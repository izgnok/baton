import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { migrateHome, isOldAppRunning } from '../main/migrateHome.js';

// 실제 ~/.claude-rooms·~/.baton 은 건드리지 않고 임시 폴더만 쓴다
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-mig-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
let n = 0;
const fresh = () => { const d = path.join(tmp, String(++n)); fs.mkdirSync(d); return { home: path.join(d, 'new'), oldHome: path.join(d, 'old'), d }; };
const notRunning = () => false;

function makeOrigin(d) {
  const origin = path.join(d, 'origin');
  fs.mkdirSync(origin);
  git(origin, 'init', '-q');
  git(origin, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-qm', 'init');
  return origin;
}

test('옛 폴더만 있으면 옮기고 방 작업 폴더의 원본 쪽 등록이 새 경로가 된다', async () => {
  const { home, oldHome, d } = fresh();
  const origin = makeOrigin(d);
  fs.mkdirSync(path.join(oldHome, '1', 'repos'), { recursive: true });
  const oldWt = path.join(oldHome, '1', 'repos', '5-api');
  git(origin, 'worktree', 'add', '-q', '-b', 'room-1', oldWt);
  const r = await migrateHome({ home, oldHome, env: {}, isOldAppRunning: notRunning });
  assert.deepEqual(r, { moved: true, repaired: 1 });
  assert.equal(fs.existsSync(oldHome), false);
  const list = git(origin, 'worktree', 'list', '--porcelain');
  const real = (p) => fs.realpathSync(p);
  assert.ok(list.includes(`worktree ${real(path.join(home, '1', 'repos', '5-api'))}`), list);
  assert.ok(!list.includes(oldWt));
});

test('둘 다 설정이 있으면 BOTH_EXIST, 옛 폴더 그대로', async () => {
  const { home, oldHome } = fresh();
  fs.mkdirSync(home); fs.mkdirSync(oldHome);
  fs.writeFileSync(path.join(home, 'config.json'), '{"new":1}');
  fs.writeFileSync(path.join(oldHome, 'config.json'), '{}');
  const r = await migrateHome({ home, oldHome, env: {}, isOldAppRunning: notRunning });
  assert.deepEqual(r, { moved: false, reason: 'BOTH_EXIST', repaired: 0 });
  assert.ok(fs.existsSync(path.join(oldHome, 'config.json')));
});

test('새 폴더에 설정 없이 로그만 있으면 옛 폴더로 합치고 옮긴다(로그는 이어 붙임)', async () => {
  const { home, oldHome } = fresh();
  fs.mkdirSync(home); fs.mkdirSync(oldHome);
  fs.writeFileSync(path.join(oldHome, 'config.json'), '{"old":1}');
  fs.writeFileSync(path.join(oldHome, 'core.log'), 'a\n');
  fs.writeFileSync(path.join(home, 'core.log'), 'b\n');
  fs.writeFileSync(path.join(home, 'server.log'), 's\n');
  const r = await migrateHome({ home, oldHome, env: {}, isOldAppRunning: notRunning });
  assert.deepEqual(r, { moved: true, repaired: 0 });
  assert.equal(fs.existsSync(oldHome), false);
  assert.equal(fs.readFileSync(path.join(home, 'config.json'), 'utf8'), '{"old":1}');
  assert.equal(fs.readFileSync(path.join(home, 'core.log'), 'utf8'), 'a\nb\n');
  assert.equal(fs.readFileSync(path.join(home, 'server.log'), 'utf8'), 's\n');
});

test('옛 폴더가 없으면 NO_OLD', async () => {
  const { home, oldHome } = fresh();
  const r = await migrateHome({ home, oldHome, env: {}, isOldAppRunning: notRunning });
  assert.equal(r.reason, 'NO_OLD');
  assert.equal(fs.existsSync(home), false);
});

test('BATON_HOME 이 있으면 HOME_SET, 아무것도 옮기지 않는다', async () => {
  const { home, oldHome } = fresh();
  fs.mkdirSync(oldHome);
  const r = await migrateHome({ home, oldHome, env: { BATON_HOME: '/x' }, isOldAppRunning: notRunning });
  assert.deepEqual(r, { moved: false, reason: 'HOME_SET', repaired: 0 });
  assert.ok(fs.existsSync(oldHome));
  assert.equal(fs.existsSync(home), false);
});

test('옛 앱이 켜져 있으면 OLD_RUNNING, 옛 폴더 그대로', async () => {
  const { home, oldHome } = fresh();
  fs.mkdirSync(oldHome);
  const r = await migrateHome({ home, oldHome, env: {}, isOldAppRunning: () => true });
  assert.deepEqual(r, { moved: false, reason: 'OLD_RUNNING', repaired: 0 });
  assert.ok(fs.existsSync(oldHome));
  assert.equal(fs.existsSync(home), false);
});

test('원본 레포가 지워진 작업 폴더가 있어도 moved:true, repaired:0', async () => {
  const { home, oldHome, d } = fresh();
  const origin = makeOrigin(d);
  fs.mkdirSync(path.join(oldHome, '1', 'repos'), { recursive: true });
  git(origin, 'worktree', 'add', '-q', '-b', 'room-2', path.join(oldHome, '1', 'repos', '5-api'));
  fs.rmSync(origin, { recursive: true, force: true });
  const r = await migrateHome({ home, oldHome, env: {}, isOldAppRunning: notRunning });
  assert.deepEqual(r, { moved: true, repaired: 0 });
  assert.ok(fs.existsSync(path.join(home, '1', 'repos', '5-api')));
});

test('rename 이 실패하면 FAILED, 아무것도 바꾸지 않는다', async () => {
  const { home, oldHome, d } = fresh();
  fs.mkdirSync(oldHome);
  const roDir = path.join(d, 'ro'); fs.mkdirSync(roDir); fs.chmodSync(roDir, 0o500); // 새 폴더의 부모에 쓸 수 없다
  try {
    const r = await migrateHome({ home: path.join(roDir, 'sub', 'new'), oldHome, env: {}, isOldAppRunning: notRunning });
    assert.deepEqual(r, { moved: false, reason: 'FAILED', repaired: 0 });
    assert.ok(fs.existsSync(oldHome));
  } finally { fs.chmodSync(roDir, 0o700); }
});

test('기본 옛 앱 검사는 자기 부모 프로세스를 빼고 본다', () => {
  assert.equal(isOldAppRunning({ exec: () => '', ppid: 100 }), false);
  assert.equal(isOldAppRunning({ exec: () => '100\n', ppid: 100 }), false); // 나를 띄운 앱
  assert.equal(isOldAppRunning({ exec: () => '100\n200\n', ppid: 100 }), true); // 다른 옛 앱이 하나 더
  assert.equal(isOldAppRunning({ exec: () => { throw new Error('exit 1'); }, ppid: 100 }), false); // pgrep 결과 없음
});
