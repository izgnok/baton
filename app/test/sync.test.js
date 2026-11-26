import test, { beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  encodeProjectDir, transcriptPath, roomDirOf, pullRoom, collectChanges, readTranscript,
} from '../main/runner/sync.js';

const sha = (s) => createHash('sha256').update(s).digest('hex');
const tmps = [];
after(() => tmps.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

let home;
let claudeDir;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'rooms-sync-'));
  claudeDir = path.join(home, 'claude-config');
  tmps.push(home);
  process.env.ROOMS_HOME = path.join(home, 'rooms');
  process.env.CLAUDE_CONFIG_DIR = claudeDir;
});

// 서버 상태를 흉내 낸 가짜 http. calls 로 호출 수를 센다
function fakeHttp({ transcript = null, files = {} } = {}) {
  const calls = { transcript: 0, manifest: 0, shared: [] };
  return {
    calls,
    getTranscript: async () => (calls.transcript++, transcript),
    getManifest: async () => (calls.manifest++, Object.entries(files).map(([p, c]) => ({ path: p, sha256: sha(c) }))),
    getShared: async (_id, p) => (calls.shared.push(p), Buffer.from(files[p])),
  };
}

test('encodeProjectDir / roomDirOf', () => {
  assert.equal(encodeProjectDir('/Users/a/claude-rooms/r1'), '-Users-a-claude-rooms-r1');
  assert.equal(encodeProjectDir('/Users/가/방_1.x'), '-Users-----1-x');
  assert.equal(roomDirOf(7), path.join(process.env.ROOMS_HOME, '7'));
  assert.equal(fs.existsSync(roomDirOf(7)), false);
});

test('pull: 대화 원본이 realpath 인코딩 위치에 쓰인다', async () => {
  const real = fs.mkdtempSync(path.join(home, 'real-'));
  const link = path.join(home, 'link');
  fs.symlinkSync(real, link);
  const roomDir = path.join(link, 'room'); // 심볼릭 경로 아래
  fs.mkdirSync(roomDir);
  const http = fakeHttp({ transcript: '{"a":1}\n' });
  await pullRoom({ http, roomId: 1, roomDir, sessionId: '11111111-2222-4333-8444-555555555555' });
  const expected = path.join(claudeDir, 'projects', encodeProjectDir(fs.realpathSync(roomDir)), '11111111-2222-4333-8444-555555555555.jsonl');
  assert.equal(fs.readFileSync(expected, 'utf8'), '{"a":1}\n');
  assert.equal(transcriptPath({ cwd: roomDir, sessionId: '11111111-2222-4333-8444-555555555555' }), expected);
  assert.notEqual(encodeProjectDir(roomDir), encodeProjectDir(fs.realpathSync(roomDir)));
});

test('pull: sessionId 가 없으면 원본을 받지 않고 폴더는 만든다', async () => {
  const http = fakeHttp();
  const roomDir = roomDirOf(1);
  await pullRoom({ http, roomId: 1, roomDir, sessionId: null });
  assert.equal(http.calls.transcript, 0);
  assert.ok(fs.existsSync(path.join(roomDir, 'shared')));
});

test('pull: sessionId 가 있는데 서버 원본이 없으면 TRANSCRIPT_MISSING', async () => {
  await assert.rejects(
    pullRoom({ http: fakeHttp({ transcript: null }), roomId: 1, roomDir: roomDirOf(1), sessionId: '11111111-2222-4333-8444-555555555555' }),
    { message: 'TRANSCRIPT_MISSING' },
  );
});

test('pull: 공유 파일 받기, 같은 해시는 건너뛰기, 서버에 없는 로컬 파일 삭제', async () => {
  const files = { 'memory/INDEX.md': '# 목차', 'outputs/메모.md': '한글' };
  const http = fakeHttp({ files });
  const roomDir = roomDirOf(1);
  const { snapshot } = await pullRoom({ http, roomId: 1, roomDir, sessionId: null });
  const shared = path.join(roomDir, 'shared');
  assert.equal(fs.readFileSync(path.join(shared, 'memory/INDEX.md'), 'utf8'), '# 목차');
  assert.equal(fs.readFileSync(path.join(shared, 'outputs/메모.md'), 'utf8'), '한글');
  assert.deepEqual([...snapshot.entries()], [['memory/INDEX.md', sha('# 목차')], ['outputs/메모.md', sha('한글')]]);
  assert.equal(http.calls.shared.length, 2);

  fs.writeFileSync(path.join(shared, 'local-only.md'), 'x');
  fs.writeFileSync(path.join(shared, 'memory/INDEX.md'), '로컬에서 바뀜');
  await pullRoom({ http, roomId: 1, roomDir, sessionId: null });
  assert.deepEqual(http.calls.shared, ['memory/INDEX.md', 'outputs/메모.md', 'memory/INDEX.md']); // 바뀐 것만 다시
  assert.equal(fs.existsSync(path.join(shared, 'local-only.md')), false);
  assert.equal(fs.readFileSync(path.join(shared, 'memory/INDEX.md'), 'utf8'), '# 목차');
});

test('pull: manifest 에 나쁜 경로가 섞이면 BAD_PATH, 아무것도 쓰지 않는다', async () => {
  const http = fakeHttp({ files: { 'ok.md': 'ok', '../evil': 'x' } });
  const roomDir = roomDirOf(1);
  await assert.rejects(pullRoom({ http, roomId: 1, roomDir, sessionId: null }), { message: 'BAD_PATH' });
  assert.deepEqual(fs.readdirSync(path.join(roomDir, 'shared')), []);
  assert.equal(http.calls.shared.length, 0);
});

test('collectChanges: 수정·추가·삭제', async () => {
  const roomDir = roomDirOf(1);
  const http = fakeHttp({ files: { 'a.md': 'a', 'b.md': 'b', 'c.md': 'c' } });
  const { snapshot } = await pullRoom({ http, roomId: 1, roomDir, sessionId: null });
  assert.deepEqual(collectChanges({ roomDir, snapshot }), []);
  const shared = path.join(roomDir, 'shared');
  fs.writeFileSync(path.join(shared, 'a.md'), '수정');
  fs.rmSync(path.join(shared, 'b.md'));
  fs.mkdirSync(path.join(shared, 'outputs'));
  fs.writeFileSync(path.join(shared, 'outputs/new.html'), '<p>새</p>');
  const changes = collectChanges({ roomDir, snapshot });
  assert.deepEqual(changes, [
    { path: 'a.md', contentBase64: Buffer.from('수정').toString('base64') },
    { path: 'b.md', contentBase64: null },
    { path: 'outputs/new.html', contentBase64: Buffer.from('<p>새</p>').toString('base64') },
  ]);
});

test('readTranscript: 위치에서 읽고, 없으면 TRANSCRIPT_NOT_FOUND', async () => {
  const roomDir = roomDirOf(1);
  await pullRoom({ http: fakeHttp({ transcript: 'T' }), roomId: 1, roomDir, sessionId: '11111111-2222-4333-8444-555555555555' });
  assert.equal(readTranscript({ cwd: roomDir, sessionId: '11111111-2222-4333-8444-555555555555' }), 'T');
  assert.throws(() => readTranscript({ cwd: roomDir, sessionId: '99999999-2222-4333-8444-555555555555' }), { message: 'TRANSCRIPT_NOT_FOUND' });
});

test('세션 ID 가 UUID 가 아니면 BAD_SESSION_ID, 아무것도 쓰지 않는다', async () => {
  const roomDir = roomDirOf(1);
  const evil = '../../../../../tmp/rooms-evil';
  await assert.rejects(
    pullRoom({ http: fakeHttp({ transcript: 'X' }), roomId: 1, roomDir, sessionId: evil }),
    { message: 'BAD_SESSION_ID' },
  );
  assert.throws(() => transcriptPath({ cwd: roomDir, sessionId: 'sess-1' }), { message: 'BAD_SESSION_ID' });
  assert.equal(fs.existsSync('/tmp/rooms-evil.jsonl'), false);
});
