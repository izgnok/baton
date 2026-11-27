import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createSharedSync, _test } from '../main/sharedSync.js';

const sha = (s) => createHash('sha256').update(s).digest('hex');

// 서버 대신: 파일 목록(path → 내용)과 shared.put 처리
function fakeServer(files) {
  const puts = [];
  const http = {
    getManifest: async () => Object.entries(files).map(([p, c]) => ({ path: p, sha256: sha(c) })).sort((a, b) => (a.path < b.path ? -1 : 1)),
    getShared: async (_r, p) => Buffer.from(files[p]),
    getTranscript: async () => null,
  };
  const client = {
    http,
    async request(_type, { changes }) {
      puts.push(changes);
      const conflicts = [];
      for (const c of changes) {
        const cur = files[c.path] === undefined ? null : sha(files[c.path]);
        if (cur !== c.baseSha) { conflicts.push(c.path); continue; }
        if (c.contentBase64 === null) delete files[c.path]; else files[c.path] = Buffer.from(c.contentBase64, 'base64').toString();
      }
      return { applied: [], conflicts };
    },
  };
  return { client, puts };
}

function setup(files) {
  const roomDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rooms-ss-'));
  const srv = fakeServer(files);
  const conflicts = [];
  const ss = createSharedSync({
    getClient: () => srv.client, roomDirOf: () => roomDir, isRunning: () => false,
    onConflict: (_r, p) => conflicts.push(...p), watch: () => ({ on() {}, close() {} }),
  });
  const shared = path.join(roomDir, 'shared');
  return { ss, srv, files, roomDir, shared, conflicts };
}

test('처음 받을 땐 올리지 않고, 그 뒤 직접 고친 파일만 기준 sha 와 함께 올린다', async () => {
  const t = setup({ 'outputs/a.md': 'v1', 'memory/INDEX.md': 'i' });
  await t.ss.sync(1);
  assert.equal(t.srv.puts.length, 0);
  assert.equal(fs.readFileSync(path.join(t.shared, 'outputs/a.md'), 'utf8'), 'v1');

  fs.writeFileSync(path.join(t.shared, 'outputs/a.md'), 'mine');
  fs.writeFileSync(path.join(t.shared, 'outputs/.DS_Store'), 'x'); // 숨김 파일은 올리지 않는다
  fs.writeFileSync(path.join(t.shared, 'new.md'), 'n');
  await t.ss.sync(1);
  assert.deepEqual(t.srv.puts[0].map((c) => [c.path, c.baseSha]), [['new.md', null], ['outputs/a.md', sha('v1')]]);
  assert.equal(t.files['outputs/a.md'], 'mine');
  assert.equal(t.files['new.md'], 'n');
});

test('누가 먼저 고쳤으면 내 수정본을 다른 이름으로 올리고 서버 내용을 받는다', async () => {
  const t = setup({ 'a.md': 'v1' });
  await t.ss.sync(1);
  fs.writeFileSync(path.join(t.shared, 'a.md'), 'mine');
  t.files['a.md'] = 'theirs'; // 다른 사람이 먼저 고침
  await t.ss.sync(1);
  assert.equal(t.conflicts.length, 1);
  const copy = t.conflicts[0];
  assert.match(copy, /^a \(내 수정 \d{4}-\d{4}\)\.md$/);
  assert.equal(t.files[copy], 'mine');
  assert.equal(fs.readFileSync(path.join(t.shared, 'a.md'), 'utf8'), 'theirs');
  assert.equal(fs.readFileSync(path.join(t.shared, copy), 'utf8'), 'mine');
});

test('실행 중인 방은 건너뛰고, 직접 지운 파일은 서버에서도 지운다', async () => {
  const t = setup({ 'a.md': 'v1' });
  await t.ss.sync(1);
  fs.rmSync(path.join(t.shared, 'a.md'));
  await t.ss.sync(1);
  assert.equal(t.files['a.md'], undefined);

  let running = true;
  const ss2 = createSharedSync({ getClient: () => t.srv.client, roomDirOf: () => t.roomDir, isRunning: () => running, watch: () => ({ on() {}, close() {} }) });
  t.files['b.md'] = 'b';
  await ss2.sync(1);
  assert.equal(fs.existsSync(path.join(t.shared, 'b.md')), false);
  running = false;
  await ss2.sync(1);
  assert.equal(fs.existsSync(path.join(t.shared, 'b.md')), true);
});

test('숨김·임시 파일 판정과 충돌 사본 이름', () => {
  assert.deepEqual(['.DS_Store', 'a/.x.swp', 'a.md~', 'a/b.md'].map(_test.junk), [true, true, true, false]);
  assert.equal(_test.conflictName('dir/a.md', new Date(2026, 10, 27, 9, 5)), 'dir/a (내 수정 1127-0905).md');
});
