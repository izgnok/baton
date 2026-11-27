import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  syncWorktree, pendingChanges, listRepoFiles, removeWorktree, isProtectedBranch, worktreePath,
  currentBranch, scanBranches, deferBranches, detachWorktrees,
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

test('syncWorktree: 작업 폴더를 만든다(detached, 원격과 같은 커밋). 원본이 같은 브랜치여도 성공', async () => {
  const f = fixture('s1');
  assert.equal(g(f.source, 'branch', '--show-current'), 'feature/ABC-1');
  const { head } = await syncWorktree(f.args());
  assert.equal(g(f.wt, 'branch', '--show-current'), ''); // detached
  assert.equal(g(f.wt, 'rev-parse', 'HEAD'), f.remoteSha());
  assert.ok(f.remoteSha().startsWith(head));
  assert.equal(g(f.source, 'branch', '--show-current'), 'feature/ABC-1'); // 원본은 그대로
});

test('syncWorktree: 원격에 새 커밋이 생기면 따라간다', async () => {
  const f = fixture('s2');
  await syncWorktree(f.args());
  otherPush(f, 'c.txt', 'c\n');
  await syncWorktree(f.args());
  assert.equal(g(f.wt, 'rev-parse', 'HEAD'), f.remoteSha());
  assert.equal(read(f.wt, 'c.txt'), 'c\n');
});

test('syncWorktree: 방 브랜치가 바뀌면 새 브랜치 위로 옮긴다', async () => {
  const f = fixture('s3');
  await syncWorktree(f.args());
  await syncWorktree(f.args('release/1.0'));
  assert.equal(g(f.wt, 'rev-parse', 'HEAD'), f.remoteSha('release/1.0'));
});

test('syncWorktree: 없는 브랜치는 BRANCH_NOT_ON_REMOTE, 옵션처럼 보이는 이름은 BAD_BRANCH', async () => {
  const f = fixture('s4');
  await assert.rejects(syncWorktree(f.args('nope')), { message: 'BRANCH_NOT_ON_REMOTE' });
  for (const b of ['-x', '--upload-pack=touch /tmp/x', 'a..b', 'a b', '']) {
    await assert.rejects(syncWorktree(f.args(b)), { message: 'BAD_BRANCH' }, b);
  }
  assert.equal(fs.existsSync(f.wt), false);
});

test('syncWorktree: 원격을 못 받으면 FETCH_FAILED', async () => {
  const f = fixture('s5');
  g(f.source, 'remote', 'set-url', 'origin', path.join(tmp, 'nowhere.git'));
  await assert.rejects(syncWorktree(f.args()), { message: 'FETCH_FAILED' });
});

test('syncWorktree: 커밋 안 된 수정은 유지하고 원격 변경을 반영한다(autostash)', async () => {
  const f = fixture('s6');
  await syncWorktree(f.args());
  write(f.wt, 'a.txt', 'mine\n');
  otherPush(f, 'b.txt', 'remote b\n');
  await syncWorktree(f.args());
  assert.equal(read(f.wt, 'a.txt'), 'mine\n');
  assert.equal(read(f.wt, 'b.txt'), 'remote b\n');
  assert.equal(g(f.wt, 'rev-parse', 'HEAD'), f.remoteSha());
});

test('syncWorktree: 같은 줄이 겹치면 SYNC_CONFLICT, rebase 진행 중이 아니고 내 수정은 그대로', async () => {
  const f = fixture('s7');
  await syncWorktree(f.args());
  const before = g(f.wt, 'rev-parse', 'HEAD');
  write(f.wt, 'a.txt', 'mine\n');
  otherPush(f, 'a.txt', 'theirs\n');
  await assert.rejects(syncWorktree(f.args()), { message: 'SYNC_CONFLICT' });
  const gitDir = path.resolve(f.wt, g(f.wt, 'rev-parse', '--git-dir'));
  assert.equal(fs.existsSync(path.join(gitDir, 'rebase-merge')) || fs.existsSync(path.join(gitDir, 'rebase-apply')), false);
  assert.equal(g(f.wt, 'rev-parse', 'HEAD'), before);
  assert.equal(read(f.wt, 'a.txt'), 'mine\n');
  assert.equal(g(f.wt, 'status', '--porcelain'), 'M a.txt');
  assert.equal(g(f.wt, 'stash', 'list'), '');
});

test('syncWorktree: 커밋해 둔 내 변경이 원격과 충돌해도 되돌리고 SYNC_CONFLICT', async () => {
  const f = fixture('s8');
  await syncWorktree(f.args());
  write(f.wt, 'a.txt', 'mine\n');
  g(f.wt, 'commit', '-qam', 'mine');
  const mine = g(f.wt, 'rev-parse', 'HEAD');
  otherPush(f, 'a.txt', 'theirs\n');
  await assert.rejects(syncWorktree(f.args()), { message: 'SYNC_CONFLICT' });
  assert.equal(g(f.wt, 'rev-parse', 'HEAD'), mine);
  assert.equal(g(f.wt, 'status', '--porcelain'), '');
});

test('pendingChanges: 수정·추가·삭제 파일과 diff, 변경이 없으면 빈 값', async () => {
  const f = fixture('pc1');
  await syncWorktree(f.args());
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
  await syncWorktree(f.args());
  write(f.wt, 'a.txt', `${'가나다라마바사\n'.repeat(20000)}`); // 약 420KB
  const r = await pendingChanges({ worktreePath: f.wt, branch: 'feature/ABC-1' });
  assert.equal(r.truncated, true);
  assert.ok(Buffer.byteLength(r.diff) <= 60 * 1024);
  assert.ok(Buffer.byteLength(r.diff) > 59 * 1024);
  assert.ok(r.diff.startsWith('diff --git'));
});

test('pendingChanges: 방 브랜치보다 앞선 커밋 수(ahead), 옵션처럼 보이는 브랜치는 BAD_BRANCH', async () => {
  const f = fixture('pc3');
  await syncWorktree(f.args());
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
  await syncWorktree({ ...f.args(), worktreePath: worktreePath('lf', { id: 1, name: 'r' }) });
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
  await syncWorktree(f.args());
  assert.deepEqual(await removeWorktree(f.args()), { removed: true });
  assert.equal(fs.existsSync(f.wt), false);
  assert.equal(g(f.source, 'worktree', 'list').includes('repos'), false);
  assert.deepEqual(await removeWorktree(f.args()), { removed: true });
});

test('removeWorktree: 커밋 안 된 변경은 DIRTY, push 안 된 커밋은 UNPUSHED(branch 를 몰라도)', async () => {
  const f = fixture('r2');
  await syncWorktree(f.args());
  write(f.wt, 'new.txt', 'n\n');
  assert.deepEqual(await removeWorktree(f.args()), { removed: false, reason: 'DIRTY' });
  g(f.wt, 'add', '-A');
  g(f.wt, 'commit', '-qm', 'local');
  assert.deepEqual(await removeWorktree(f.args()), { removed: false, reason: 'UNPUSHED' });
  const { branch, ...noBranch } = f.args();
  assert.deepEqual(await removeWorktree(noBranch), { removed: false, reason: 'UNPUSHED' });
  assert.equal(fs.existsSync(f.wt), true);
});

// ---- Claude 가 작업 폴더에서 브랜치를 옮긴 것 따라가기 ----

const treeOf = (f, branch = 'feature/ABC-1') => [{ repo: { id: 1, name: 'r', branch }, wt: f.wt }];

test('scanBranches: detached 면 바뀐 게 없고 대기도 지운다', async () => {
  const f = fixture('b1');
  await syncWorktree(f.args());
  assert.deepEqual(await scanBranches({ trees: treeOf(f), pending: {} }), { changes: [], pending: {}, detach: [] });
  assert.deepEqual((await scanBranches({ trees: treeOf(f), pending: { 1: 'old' } })).pending, {});
});

test('scanBranches: 원격에 있는 브랜치로 옮기면 방 브랜치 변경 대상, 작업 폴더는 같은 커밋 detached 로 되돌린다', async () => {
  const f = fixture('b2');
  await syncWorktree(f.args());
  write(f.wt, 'wip.txt', 'w\n'); // 커밋 안 된 수정은 그대로 남아야 한다
  g(f.wt, 'switch', '-c', 'release/1.0', '--no-track', 'origin/release/1.0');
  assert.equal(await currentBranch(f.wt), 'release/1.0');
  const r = await scanBranches({ trees: treeOf(f), pending: { 1: 'feature/gone' } });
  assert.deepEqual(r, { changes: [{ repoId: 1, repoName: 'r', branch: 'release/1.0', pending: false }], pending: {}, detach: [f.wt] });
  const head = g(f.wt, 'rev-parse', 'HEAD');
  await detachWorktrees(r.detach);
  assert.equal(await currentBranch(f.wt), '');
  assert.equal(g(f.wt, 'rev-parse', 'HEAD'), head);
  assert.equal(read(f.wt, 'wip.txt'), 'w\n');
});

test('scanBranches: 원격에 없는 새 브랜치는 대기(한 번만 알림), push 하면 변경 대상이 되고 대기가 지워진다', async () => {
  const f = fixture('b3');
  await syncWorktree(f.args());
  g(f.wt, 'switch', '-c', 'feature/new');
  const first = await scanBranches({ trees: treeOf(f), pending: {} });
  assert.deepEqual(first, { changes: [{ repoId: 1, repoName: 'r', branch: 'feature/new', pending: true }], pending: { 1: 'feature/new' }, detach: [] });
  assert.equal(await currentBranch(f.wt), 'feature/new'); // 작업 폴더는 그대로

  const again = await scanBranches({ trees: treeOf(f), pending: first.pending });
  assert.deepEqual(again, { changes: [], pending: { 1: 'feature/new' }, detach: [] });

  g(f.wt, 'push', '-q', 'origin', 'feature/new');
  const done = await scanBranches({ trees: treeOf(f), pending: first.pending });
  assert.deepEqual(done, { changes: [{ repoId: 1, repoName: 'r', branch: 'feature/new', pending: false }], pending: {}, detach: [f.wt] });
});

test('scanBranches: 방 브랜치로 돌아오면 대기를 지우고 detached 로 되돌린다', async () => {
  const f = fixture('b4');
  await syncWorktree(f.args());
  g(f.wt, 'switch', '-c', 'feature/new');
  const r = await scanBranches({ trees: treeOf(f, 'feature/new'), pending: { 1: 'feature/new' } });
  assert.deepEqual(r, { changes: [], pending: {}, detach: [f.wt] });
});

test('deferBranches: 실패한 실행은 옮긴 브랜치를 대기로만 적는다(원격 확인·되돌리기 없음)', async () => {
  const f = fixture('b5');
  await syncWorktree(f.args());
  assert.deepEqual(await deferBranches({ trees: treeOf(f), pending: { 1: 'x' } }), {});
  g(f.wt, 'switch', '-c', 'release/9', '--no-track', 'origin/release/1.0');
  assert.deepEqual(await deferBranches({ trees: treeOf(f), pending: {} }), { 1: 'release/9' });
  assert.equal(await currentBranch(f.wt), 'release/9');
});

test('syncWorktree: 브랜치에 붙어 있던 작업 폴더는 detached 로 바꾼 뒤 맞춘다(그 브랜치를 다시 쓰지 않는다)', async () => {
  const f = fixture('b6');
  await syncWorktree(f.args());
  g(f.wt, 'switch', '-c', 'feature/new');
  write(f.wt, 'n.txt', 'n\n');
  g(f.wt, 'add', '-A');
  g(f.wt, 'commit', '-qm', 'n');
  const tip = g(f.wt, 'rev-parse', 'feature/new');
  otherPush(f, 'c.txt', 'c\n');
  await syncWorktree(f.args());
  assert.equal(await currentBranch(f.wt), '');
  assert.equal(g(f.wt, 'rev-parse', 'feature/new'), tip); // 브랜치는 그대로
  assert.equal(read(f.wt, 'c.txt'), 'c\n');
});
