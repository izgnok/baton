import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createFileStore } from '../src/files.js';

const dirs = [];
after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rooms-files-'));
  dirs.push(dir);
  return { dir, store: createFileStore(dir) };
}
const b64 = (s) => Buffer.from(s).toString('base64');
const sha = (s) => createHash('sha256').update(s).digest('hex');

test('대화 원본 쓰기·읽기·덮어쓰기, 없으면 null, tmp 안 남음', () => {
  const { dir, store } = setup();
  assert.equal(store.readTranscript(1), null);
  store.writeTranscript(1, '{"a":1}\n');
  assert.equal(store.readTranscript(1), '{"a":1}\n');
  store.writeTranscript(1, '{"a":2}\n');
  assert.equal(store.readTranscript(1), '{"a":2}\n');
  assert.deepEqual(fs.readdirSync(path.join(dir, 'rooms', '1')), ['transcript.jsonl']);
});

test('applyShared → manifest 정렬·sha256, 삭제 반영', () => {
  const { store } = setup();
  assert.deepEqual(store.manifest(1), []);
  store.applyShared(1, [
    { path: 'outputs/메모.md', contentBase64: b64('한글 내용') },
    { path: 'memory/INDEX.md', contentBase64: b64('# 목차') },
  ]);
  assert.deepEqual(store.manifest(1), [
    { path: 'memory/INDEX.md', sha256: sha('# 목차') },
    { path: 'outputs/메모.md', sha256: sha('한글 내용') },
  ]);
  assert.equal(store.readShared(1, 'outputs/메모.md').toString(), '한글 내용');
  store.applyShared(1, [{ path: 'memory/INDEX.md', contentBase64: null }, { path: 'nope.md', contentBase64: null }]);
  assert.deepEqual(store.manifest(1).map((m) => m.path), ['outputs/메모.md']);
});

test('나쁜 경로가 하나라도 있으면 아무것도 쓰지 않는다', () => {
  const { store } = setup();
  assert.throws(
    () => store.applyShared(1, [{ path: 'ok.md', contentBase64: b64('x') }, { path: '../evil', contentBase64: b64('y') }]),
    { message: 'BAD_PATH' },
  );
  assert.deepEqual(store.manifest(1), []);
});

test('심볼릭 링크와 .tmp- 파일은 manifest 에 나오지 않는다', () => {
  const { dir, store } = setup();
  store.applyShared(1, [{ path: 'a.md', contentBase64: b64('a') }]);
  const shared = path.join(dir, 'rooms', '1', 'shared');
  fs.symlinkSync(path.join(shared, 'a.md'), path.join(shared, 'link.md'));
  fs.symlinkSync(os.tmpdir(), path.join(shared, 'linkdir'));
  fs.writeFileSync(path.join(shared, '.tmp-abc'), 'x');
  assert.deepEqual(store.manifest(1).map((m) => m.path), ['a.md']);
});

test('readShared 없는 파일은 NOT_FOUND, 나쁜 경로는 BAD_PATH, removeRoom', () => {
  const { dir, store } = setup();
  assert.throws(() => store.readShared(1, 'no.md'), { message: 'NOT_FOUND' });
  assert.throws(() => store.readShared(1, '../x'), { message: 'BAD_PATH' });
  store.writeTranscript(1, 'x');
  store.removeRoom(1);
  assert.equal(fs.existsSync(path.join(dir, 'rooms', '1')), false);
  store.removeRoom(1);
});

test('putShared: 기준이 같으면 반영, 누가 먼저 고쳤으면 충돌, 내용이 이미 같으면 그대로', () => {
  const { store } = setup();
  const sha = (s) => createHash('sha256').update(s).digest('hex');
  store.applyShared(1, [{ path: 'a.md', contentBase64: b64('v1') }, { path: 'b.md', contentBase64: b64('b') }]);
  const r = store.putShared(1, [
    { path: 'a.md', baseSha: sha('v1'), contentBase64: b64('v2') }, // 반영
    { path: 'b.md', baseSha: sha('old'), contentBase64: b64('mine') }, // 충돌
    { path: 'new.md', baseSha: null, contentBase64: b64('n') }, // 새 파일
    { path: 'same.md', baseSha: sha('zzz'), contentBase64: null }, // 이미 없음 → 그대로
  ]);
  assert.deepEqual(r, { applied: ['a.md', 'new.md'], conflicts: ['b.md'] });
  assert.equal(store.readShared(1, 'a.md').toString(), 'v2');
  assert.equal(store.readShared(1, 'b.md').toString(), 'b');
  assert.deepEqual(store.putShared(1, [{ path: 'a.md', baseSha: sha('v1'), contentBase64: b64('v2') }]), { applied: [], conflicts: [] });
  assert.deepEqual(store.putShared(1, [{ path: 'new.md', baseSha: sha('n'), contentBase64: null }]), { applied: ['new.md'], conflicts: [] });
  assert.throws(() => store.putShared(1, [{ path: '../x', baseSha: null, contentBase64: b64('x') }]), { message: 'BAD_PATH' });
});
