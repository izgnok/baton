import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  ensureWorktree, pendingChanges, listRepoFiles, removeWorktree, discardWorktree, isProtectedBranch, worktreePath,
} from '../main/runner/worktree.js';

const g = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'pipe' }).toString().trim();

let tmp;
before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rooms-wt-'));
  process.env.ROOMS_HOME = path.join(tmp, 'home');
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const write = (dir, file, text) => fs.writeFileSync(path.join(dir, file), text);
const read = (dir, file) => fs.readFileSync(path.join(dir, file), 'utf8');

/** bare 원격(main, feature/ABC-1, release/1.0) + 내 원본 clone(feature 체크아웃 중) + 다른 사람 clone */
function fixture(name) {
  const bare = path.join(tmp, `${name}.git`);
  const seed = path.join(tmp, `${name}-seed`);
  fs.mkdirSync(seed);
  g(seed, 'init', '-q', '-b', 'main');
  write(seed, 'a.txt', 'a\n');
  write(seed, 'b.txt', 'b\n');
  g(seed, 'add', '.');
  g(seed, 'commit', '-q', '-m', 'init');
  g(seed, 'branch', 'feature/ABC-1');
  g(seed, 'branch', 'release/1.0');
  g(tmp, 'init', '-q', '--bare', '-b', 'main', bare);
  g(seed, 'remote', 'add', 'origin', bare);
  g(seed, 'push', '-q', 'origin', 'main', 'feature/ABC-1', 'release/1.0');
  const source = path.join(tmp, `${name}-source`);
  g(tmp, 'clone', '-q', '-b', 'feature/ABC-1', bare, source);
  g(source, 'config', 'user.name', 't');
  g(source, 'config', 'user.email', 't@t');
  const other = path.join(tmp, `${name}-other`);
  g(tmp, 'clone', '-q', '-b', 'feature/ABC-1', bare, other);
  const wt = worktreePath(name, { id: 1, name: 'r' });
  const remoteSha = (branch = 'feature/ABC-1') => g(bare, 'rev-parse', branch);
  const args = (branch = 'feature/ABC-1') => ({ sourcePath: source, worktreePath: wt, branch });
  return { bare, seed, source, other, wt, remoteSha, args };
}

// 다른 사람이 원격 브랜치에 커밋을 올린다
function otherPush(f, file, text, branch = 'feature/ABC-1') {
  g(f.other, 'pull', '-q', '--rebase', 'origin', branch);
  write(f.other, file, text);
  g(f.other, 'add', '.');
  g(f.other, 'commit', '-q', '-m', `other ${file}`);
  g(f.other, 'push', '-q', 'origin', `HEAD:refs/heads/${branch}`);
}

test('worktreePath, isProtectedBranch', () => {
  assert.equal(worktreePath(5, { id: 2, name: 'my repo' }), path.join(process.env.ROOMS_HOME, '5', 'repos', '2-my_repo'));
  for (const b of ['main', 'master', 'develop', 'production', 'release/1.0', 'hotfix/x']) assert.equal(isProtectedBranch(b), true, b);
  for (const b of ['feature/ABC-1', 'mainline', 'releases', 'my-develop']) assert.equal(isProtectedBranch(b), false, b);
});

test('ensureWorktree: 작업 폴더를 만든다(detached, 원격과 같은 커밋). 원본이 같은 브랜치여도 성공', async () => {
  const f = fixture('s1');
  assert.equal(g(f.source, 'branch', '--show-current'), 'feature/ABC-1');
  assert.deepEqual(await ensureWorktree(f.args()), { created: true });
  assert.equal(g(f.wt, 'branch', '--show-current'), ''); // detached
  assert.equal(g(f.wt, 'rev-parse', 'HEAD'), f.remoteSha());
  assert.equal(g(f.source, 'branch', '--show-current'), 'feature/ABC-1'); // 원본은 그대로
});

test('ensureWorktree: 이미 있는 작업 폴더는 건드리지 않는다(원격만 받아 둔다)', async () => {
  const f = fixture('s2');
  await ensureWorktree(f.args());
  write(f.wt, 'a.txt', 'mine\n');
  const head = g(f.wt, 'rev-parse', 'HEAD');
  otherPush(f, 'c.txt', 'c\n');
  assert.deepEqual(await ensureWorktree(f.args()), { created: false });
  assert.equal(g(f.wt, 'rev-parse', 'HEAD'), head);
  assert.equal(read(f.wt, 'a.txt'), 'mine\n');
  assert.equal(g(f.wt, 'rev-parse', 'origin/feature/ABC-1'), f.remoteSha()); // 원격 추적 브랜치는 최신
});

test('ensureWorktree: 없는 브랜치는 BRANCH_NOT_ON_REMOTE, 옵션처럼 보이는 이름은 BAD_BRANCH', async () => {
  const f = fixture('s4');
  await assert.rejects(ensureWorktree(f.args('nope')), { message: 'BRANCH_NOT_ON_REMOTE' });
  for (const b of ['-x', '--upload-pack=touch /tmp/x', 'a..b', 'a b', '']) {
    await assert.rejects(ensureWorktree(f.args(b)), { message: 'BAD_BRANCH' }, b);
  }
  assert.equal(fs.existsSync(f.wt), false);
});

test('ensureWorktree: 원격을 못 받으면 FETCH_FAILED', async () => {
  const f = fixture('s5');
  g(f.source, 'remote', 'set-url', 'origin', path.join(tmp, 'nowhere.git'));
  await assert.rejects(ensureWorktree(f.args()), { message: 'FETCH_FAILED' });
});

test('discardWorktree: 고친 게 있어도 지우고 등록도 정리한다. 다시 만들 수 있다', async () => {
  const f = fixture('d1');
  await ensureWorktree(f.args());
  write(f.wt, 'x.txt', 'x\n');
  await discardWorktree({ sourcePath: f.source, worktreePath: f.wt });
  assert.equal(fs.existsSync(f.wt), false);
  assert.equal(g(f.source, 'worktree', 'list').includes('repos'), false);
  assert.deepEqual(await ensureWorktree(f.args()), { created: true });
});

test('pendingChanges: 수정·추가·삭제 파일과 diff, 변경이 없으면 빈 값', async () => {
  const f = fixture('pc1');
  await ensureWorktree(f.args());
  assert.deepEqual(await pendingChanges({ worktreePath: f.wt, branch: 'feature/ABC-1' }), { files: [], diff: '', truncated: false, ahead: 0 });

  write(f.wt, 'a.txt', 'changed\n');
  fs.rmSync(path.join(f.wt, 'b.txt'));
  fs.mkdirSync(path.join(f.wt, 'src/deep'), { recursive: true });
  write(f.wt, 'src/deep/new file.txt', 'n\n');
  const r = await pendingChanges({ worktreePath: f.wt, branch: 'feature/ABC-1' });
  assert.deepEqual(r.files, [
    { status: 'M', path: 'a.txt' },
    { status: 'D', path: 'b.txt' },
    { status: '??', path: 'src/deep/new file.txt' }, // 폴더 안 추적 안 된 파일도 파일 단위로
  ]);
  assert.ok(r.diff.includes('+changed') && r.diff.includes('-b'));
  assert.equal(r.truncated, false);
  assert.equal(r.ahead, 0);
  // 아무것도 커밋·스테이지하지 않는다
  assert.equal(g(f.wt, 'diff', '--cached', '--name-only'), '');
});

test('pendingChanges: diff 는 앞 60KB 만, 넘으면 truncated', async () => {
  const f = fixture('pc2');
  await ensureWorktree(f.args());
  write(f.wt, 'a.txt', `${'가나다라마바사\n'.repeat(20000)}`); // 약 420KB
  const r = await pendingChanges({ worktreePath: f.wt, branch: 'feature/ABC-1' });
  assert.equal(r.truncated, true);
  assert.ok(Buffer.byteLength(r.diff) <= 60 * 1024);
  assert.ok(Buffer.byteLength(r.diff) > 59 * 1024);
  assert.ok(r.diff.startsWith('diff --git'));
});

test('pendingChanges: 방 브랜치보다 앞선 커밋 수(ahead), 옵션처럼 보이는 브랜치는 BAD_BRANCH', async () => {
  const f = fixture('pc3');
  await ensureWorktree(f.args());
  write(f.wt, 'x.txt', 'x\n');
  g(f.wt, 'add', '-A');
  g(f.wt, 'commit', '-qm', 'local');
  write(f.wt, 'y.txt', 'y\n');
  g(f.wt, 'add', '-A');
  g(f.wt, 'commit', '-qm', 'local2');
  const r = await pendingChanges({ worktreePath: f.wt, branch: 'feature/ABC-1' });
  assert.equal(r.ahead, 2);
  assert.deepEqual(r.files, []);
  assert.equal(f.remoteSha(), g(f.wt, 'rev-parse', 'origin/feature/ABC-1')); // push 는 하지 않는다
  await assert.rejects(pendingChanges({ worktreePath: f.wt, branch: '--x' }), { message: 'BAD_BRANCH' });
});

test('listRepoFiles: 대소문자 무시 포함 검색, mention 은 방 폴더 기준, 작업 폴더 없는 레포는 건너뜀', async () => {
  const f = fixture('lf');
  await ensureWorktree({ ...f.args(), worktreePath: worktreePath('lf', { id: 1, name: 'r' }) });
  fs.mkdirSync(path.join(f.wt, 'src'), { recursive: true });
  write(f.wt, 'src/Login.java', 'x');
  g(f.wt, 'add', '-A');
  const repos = [{ id: 1, name: 'r' }, { id: 2, name: 'none' }];
  const hit = await listRepoFiles({ roomId: 'lf', repos, query: 'LOGIN' });
  assert.deepEqual(hit, [{ repoId: 1, name: 'r', path: 'src/Login.java', mention: 'repos/1-r/src/Login.java' }]);
  assert.equal((await listRepoFiles({ roomId: 'lf', repos, query: '' })).length, 3); // a, b, Login
  assert.deepEqual(await listRepoFiles({ roomId: 'lf', repos, query: 'zzz' }), []);
});

test('removeWorktree: 깨끗하면 지우고, 없으면 removed', async () => {
  const f = fixture('r1');
  await ensureWorktree(f.args());
  assert.deepEqual(await removeWorktree(f.args()), { removed: true });
  assert.equal(fs.existsSync(f.wt), false);
  assert.equal(g(f.source, 'worktree', 'list').includes('repos'), false);
  assert.deepEqual(await removeWorktree(f.args()), { removed: true });
});

test('removeWorktree: 커밋 안 된 변경은 DIRTY, push 안 된 커밋은 UNPUSHED(branch 를 몰라도)', async () => {
  const f = fixture('r2');
  await ensureWorktree(f.args());
  write(f.wt, 'new.txt', 'n\n');
  assert.deepEqual(await removeWorktree(f.args()), { removed: false, reason: 'DIRTY' });
  g(f.wt, 'add', '-A');
  g(f.wt, 'commit', '-qm', 'local');
  assert.deepEqual(await removeWorktree(f.args()), { removed: false, reason: 'UNPUSHED' });
  const { branch, ...noBranch } = f.args();
  assert.deepEqual(await removeWorktree(noBranch), { removed: false, reason: 'UNPUSHED' });
  assert.equal(fs.existsSync(f.wt), true);
});
