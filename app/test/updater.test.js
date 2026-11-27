import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createUpdater, serverMismatch } from '../main/updater.js';

const g = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'pipe' }).toString().trim();
const quiet = { warn() {} };

let tmp;
let clone;
let pusher;
const push = (name, subject, file = name) => {
  fs.writeFileSync(path.join(pusher, file), name);
  g(pusher, 'add', '.');
  g(pusher, 'commit', '-q', '-m', subject);
  g(pusher, 'push', '-q', 'origin', 'main');
};

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rooms-upd-'));
  const bare = path.join(tmp, 'o.git');
  const seed = path.join(tmp, 'seed');
  fs.mkdirSync(seed);
  g(seed, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(seed, 'package-lock.json'), '{}');
  g(seed, 'add', '.');
  g(seed, 'commit', '-q', '-m', 'init');
  g(tmp, 'init', '-q', '--bare', '-b', 'main', bare);
  g(seed, 'remote', 'add', 'origin', bare);
  g(seed, 'push', '-q', 'origin', 'main');
  clone = path.join(tmp, 'clone');
  pusher = path.join(tmp, 'pusher');
  g(tmp, 'clone', '-q', bare, clone);
  g(tmp, 'clone', '-q', bare, pusher);
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function make(over = {}) {
  const notes = [];
  const calls = { relaunch: 0, installs: [] };
  const u = createUpdater({
    root: clone, isBusy: () => false, relaunch: () => { calls.relaunch++; },
    notify: (s) => notes.push(s), install: async (r) => { calls.installs.push(r); }, log: quiet, ...over,
  });
  return { u, notes, calls };
}

test('새 커밋이 없으면 알리지 않고, 있으면 개수·제목(최신순)을 알린다', async () => {
  const { u, notes } = make();
  assert.deepEqual(await u.check(), { count: 0, subjects: [], serverMismatch: false });
  assert.equal(notes.length, 0);
  push('a.txt', '첫 변경');
  push('b.txt', '둘째 변경');
  const s = await u.check();
  assert.deepEqual([s.count, s.subjects], [2, ['둘째 변경', '첫 변경']]);
  assert.equal(notes.length, 1);
  await u.check();
  assert.equal(notes.length, 1, '같은 상태는 다시 알리지 않는다');
});

test('제목은 최대 20개', async () => {
  const { u } = make();
  for (let i = 0; i < 22; i++) push(`m${i}.txt`, `변경 ${i}`);
  const s = await u.check();
  assert.equal(s.count, 24);
  assert.equal(s.subjects.length, 20);
});

test('apply: 실행 중 요청이 있으면 UPDATE_BUSY, 로컬 변경이 있으면 UPDATE_LOCAL_CHANGES, 아무것도 안 바뀐다', async () => {
  const head = g(clone, 'rev-parse', 'HEAD');
  const busy = make({ isBusy: () => true });
  await assert.rejects(busy.u.apply(), { message: 'UPDATE_BUSY' });
  fs.writeFileSync(path.join(clone, 'package-lock.json'), '{"dirty":1}');
  const m = make();
  await assert.rejects(m.u.apply(), { message: 'UPDATE_LOCAL_CHANGES' });
  assert.equal(g(clone, 'rev-parse', 'HEAD'), head);
  assert.equal(m.calls.relaunch, 0);
  g(clone, 'checkout', 'package-lock.json');
});

test('apply: pull --ff-only 뒤 HEAD 가 원격과 같고, lock 이 안 바뀌면 install 없이 다시 켠다', async () => {
  const { u, calls } = make();
  assert.deepEqual(await u.apply(), { ok: true });
  assert.equal(g(clone, 'rev-parse', 'HEAD'), g(pusher, 'rev-parse', 'HEAD'));
  assert.equal(calls.relaunch, 1);
  assert.deepEqual(calls.installs, []);
});

test('apply: package-lock.json 이 바뀌었으면 루트에서 npm install', async () => {
  const { u, calls } = make();
  fs.writeFileSync(path.join(pusher, 'package-lock.json'), '{"v":2}');
  g(pusher, 'commit', '-qam', 'lock');
  g(pusher, 'push', '-q', 'origin', 'main');
  await u.apply();
  assert.deepEqual(calls.installs, [clone]);
  assert.equal(calls.relaunch, 1);
});

test('apply: install 이 실패하면 다시 켜지 않는다', async () => {
  const { u, calls } = make({ install: async () => { throw new Error('npm'); } });
  fs.writeFileSync(path.join(pusher, 'package-lock.json'), '{"v":3}');
  g(pusher, 'commit', '-qam', 'lock3');
  g(pusher, 'push', '-q', 'origin', 'main');
  await assert.rejects(u.apply(), { message: 'UPDATE_INSTALL_FAILED' });
  assert.equal(calls.relaunch, 0);
});

test('git 최상위가 아닌 폴더는 확인도 업데이트도 하지 않는다', async () => {
  const plain = fs.mkdtempSync(path.join(tmp, 'plain-'));
  const { u, notes } = make({ root: plain });
  assert.equal((await u.check()).count, 0);
  assert.equal(notes.length, 0);
  await assert.rejects(u.apply(), { message: 'UPDATE_NOT_GIT' });
});

test('서버 commit 과 내 HEAD 비교: 다르면 serverMismatch, 같거나 모르면 아님', async () => {
  const head = g(clone, 'rev-parse', 'HEAD');
  assert.equal(serverMismatch(head, head.slice(0, 7)), false);
  assert.equal(serverMismatch(head, 'deadbee'), true);
  assert.equal(serverMismatch(head, null), false);
  assert.equal(serverMismatch(null, 'abc1234'), false);
  const { u, notes } = make();
  await u.setServerCommit('deadbee');
  assert.equal(u.state().serverMismatch, true);
  await u.setServerCommit(head.slice(0, 7));
  assert.equal(u.state().serverMismatch, false);
  assert.equal(notes.length, 2);
});
