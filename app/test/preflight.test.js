import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { checkRepo, cloneRepo, inspectRepo, preflight, safeDirName } from '../main/runner/preflight.js';

const g = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'pipe' }).toString();

let tmp;
before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rooms-pre-'));
  process.env.ROOMS_HOME = path.join(tmp, 'home');
});

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// bare 원격(main, develop 브랜치) 과 그 clone 을 만든다
function fixture(name) {
  const bare = path.join(tmp, `${name}.git`);
  const seed = path.join(tmp, `${name}-seed`);
  fs.mkdirSync(seed);
  g(seed, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(seed, 'a.txt'), 'a');
  g(seed, 'add', '.');
  g(seed, 'commit', '-q', '-m', 'init');
  g(seed, 'branch', 'develop');
  g(tmp, 'init', '-q', '--bare', '-b', 'main', bare);
  g(seed, 'remote', 'add', 'origin', bare);
  g(seed, 'push', '-q', 'origin', 'main', 'develop');
  const local = path.join(tmp, `${name}-local`);
  g(tmp, 'clone', '-q', bare, local);
  return { bare, seed, local };
}

test('정상이면 ok', async () => {
  const f = fixture('ok');
  const r = await checkRepo({ localPath: f.local, remoteUrl: f.bare, branch: 'main' });
  assert.deepEqual(r, { ok: true, currentBranch: 'main' });
});

test('폴더 없음, git 아닌 폴더는 MISSING', async () => {
  const plain = fs.mkdtempSync(path.join(tmp, 'plain-'));
  for (const localPath of [path.join(tmp, 'nope'), plain, undefined]) {
    const r = await checkRepo({ localPath, remoteUrl: 'x', branch: 'main' });
    assert.deepEqual([r.ok, r.block], [false, 'MISSING']);
  }
});

test('origin 이 다르면 REMOTE_MISMATCH', async () => {
  const f = fixture('rm');
  const other = fixture('rm2');
  const r = await checkRepo({ localPath: f.local, remoteUrl: other.bare, branch: 'main' });
  assert.equal(r.block, 'REMOTE_MISMATCH');
});

test('브랜치가 달라도, 커밋 안 된 변경이 있어도, 원격이 앞서 있어도 막지 않는다(작업 폴더가 맡는다)', async () => {
  const f = fixture('free');
  g(f.local, 'checkout', '-q', 'develop');
  fs.writeFileSync(path.join(f.local, 'a.txt'), 'changed');
  fs.writeFileSync(path.join(f.seed, 'b.txt'), 'b');
  g(f.seed, 'add', '.');
  g(f.seed, 'commit', '-q', '-m', 'more');
  g(f.seed, 'push', '-q', 'origin', 'main');
  const r = await checkRepo({ localPath: f.local, remoteUrl: f.bare, branch: 'main' });
  assert.deepEqual(r, { ok: true, currentBranch: 'develop' });
});

test('cloneRepo 는 지정 브랜치로 체크아웃, 같은 이름은 DEST_EXISTS', async () => {
  const f = fixture('clone');
  const dest = await cloneRepo({ remoteUrl: f.bare, branch: 'develop', name: 'my repo' });
  assert.equal(dest, path.join(process.env.ROOMS_HOME, 'repos', 'my_repo'));
  assert.equal(g(dest, 'branch', '--show-current').trim(), 'develop');
  await assert.rejects(cloneRepo({ remoteUrl: f.bare, branch: 'develop', name: 'my repo' }), { message: 'DEST_EXISTS' });
});

test('cloneRepo: - 로 시작하는 주소는 git 옵션으로 실행되지 않는다', async () => {
  const marker = path.join(process.env.ROOMS_HOME, 'pwned');
  await assert.rejects(cloneRepo({
    remoteUrl: `--upload-pack=touch ${marker}`, branch: 'develop', name: 'evil',
  }));
  assert.equal(fs.existsSync(marker), false);
});

test('inspectRepo: 하위 폴더를 골라도 최상위 기준 이름·주소·브랜치, git 아니면 NOT_A_REPO', async () => {
  const f = fixture('inspect');
  fs.mkdirSync(path.join(f.local, 'sub'));
  const info = await inspectRepo(path.join(f.local, 'sub'));
  assert.equal(fs.realpathSync(info.localPath), fs.realpathSync(f.local));
  assert.equal(info.name, 'inspect-local');
  assert.equal(info.remoteUrl, f.bare);
  assert.equal(info.branch, 'main');
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'not-repo-'));
  await assert.rejects(inspectRepo(plain), { message: 'NOT_A_REPO' });
  fs.rmSync(plain, { recursive: true, force: true });
});

test('safeDirName', () => {
  assert.ok(!safeDirName('../evil').includes('..'));
  assert.equal(safeDirName('../evil'), '_evil');
  assert.equal(safeDirName('...'), 'repo');
  assert.equal(safeDirName('a/b c'), 'a_b_c');
  assert.equal(safeDirName('payment-api-1.2'), 'payment-api-1.2');
});

test('preflight: 하나라도 MISSING 이면 ok false, 결과는 레포 수만큼', async () => {
  const f = fixture('pf');
  const repos = [
    { id: 1, name: 'a', remoteUrl: f.bare, branch: 'main' },
    { id: 2, name: 'b', remoteUrl: f.bare, branch: 'main' },
  ];
  const r = await preflight(repos, { 1: f.local });
  assert.equal(r.ok, false);
  assert.equal(r.results.length, 2);
  assert.deepEqual(r.results.map((x) => [x.repoId, x.block ?? null]), [[1, null], [2, 'MISSING']]);
  assert.equal((await preflight(repos.slice(0, 1), { 1: f.local })).ok, true);
});
