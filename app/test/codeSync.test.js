import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { syncRepoCode, uploadRepoCode, updateRoomRef } from '../main/runner/codeSync.js';
import { ensureWorktree } from '../main/runner/worktree.js';

const g = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'pipe' }).toString().trim();

let tmp;
let seq = 0;
before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rooms-cx-')); });
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const write = (dir, file, text) => { fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); fs.writeFileSync(path.join(dir, file), text); };
const read = (dir, file) => fs.readFileSync(path.join(dir, file), 'utf8');
const lines = (n, patch = {}) => Array.from({ length: n }, (_, i) => patch[i + 1] ?? `l${i + 1}`).join('\n') + '\n';
const status = (wt) => g(wt, 'status', '--porcelain', '-uall');
const ROOM = 5;
const REPO = 1;

/** bare origin(release/1.0) + 가짜 서버(조각 저장) + 맥 만드는 함수 */
function setup() {
  const name = `c${++seq}`;
  const bare = path.join(tmp, `${name}.git`);
  const seed = path.join(tmp, `${name}-seed`);
  fs.mkdirSync(seed);
  g(seed, 'init', '-q', '-b', 'main');
  write(seed, 'a.txt', lines(7));
  write(seed, 'b.txt', 'b\n');
  g(seed, 'add', '.');
  g(seed, 'commit', '-q', '-m', 'init');
  g(seed, 'branch', 'release/1.0');
  g(tmp, 'init', '-q', '--bare', '-b', 'main', bare);
  g(seed, 'remote', 'add', 'origin', bare);
  g(seed, 'push', '-q', 'origin', 'main', 'release/1.0');

  // 서버: 조각 체인. entry 는 RUN_FINISH 의 codeStates 와 같은 모양
  const store = path.join(tmp, `${name}-store`);
  fs.mkdirSync(store);
  const srv = { parts: [], uploads: new Map(), downloaded: [], uploadN: 0, bundleError: null };
  srv.code = () => (srv.parts.length ? { snapshot: srv.parts.at(-1).snapshot, parts: srv.parts.length } : null);
  srv.apply = (e) => {
    if (e.snapshot === null) { srv.parts = []; return; }
    if (e.prevSnapshot === null) srv.parts = [];
    assert.equal(e.prevSnapshot, srv.parts.at(-1)?.snapshot ?? null, '서버 체인 끝과 prevSnapshot 이 이어져야 한다');
    srv.parts.push({ seq: srv.parts.length + 1, prevSnapshot: e.prevSnapshot, snapshot: e.snapshot, baseCommit: e.baseCommit, size: 1, file: srv.uploads.get(e.uploadId) });
  };
  srv.http = {
    listCodeParts: async () => srv.parts.map(({ file, ...p }) => p),
    downloadCodePart: async (room, repo, n, file) => { srv.downloaded.push(n); fs.copyFileSync(srv.parts[n - 1].file, file); },
    uploadBundle: async (room, requestId, file) => {
      if (srv.bundleError) throw new Error(srv.bundleError);
      const id = `${++srv.uploadN}`.padStart(16, '0');
      const kept = path.join(store, id);
      fs.copyFileSync(file, kept);
      srv.uploads.set(id, kept);
      return { uploadId: id, size: fs.statSync(file).size };
    },
  };
  const f = { bare, seed, srv, n: 0 };
  f.repo = (extra = {}) => ({ id: REPO, name: 'r', baseBranch: 'release/1.0', workBranch: '', code: srv.code(), ...extra });
  f.mac = (label) => {
    const src = path.join(tmp, `${name}-${label}-src`);
    g(tmp, 'clone', '-q', bare, src);
    const wt = path.join(tmp, `${name}-${label}-wt`);
    const dirs = path.join(tmp, `${name}-${label}-tmp`);
    const m = { src, wt, dirs };
    m.sync = (lastApplied = null, extra = {}) => syncRepoCode({
      http: srv.http, roomId: ROOM, repo: f.repo(extra.repo), sourcePath: src, worktree: wt, lastApplied, tmpDir: dirs, background: !!extra.background,
    });
    m.upload = (prev = null, extra = {}) => uploadRepoCode({
      http: srv.http, roomId: ROOM, requestId: 9, repo: f.repo(extra.repo), worktree: wt, prev, parts: extra.parts ?? srv.parts.length, tmpDir: dirs,
    });
    // 올리고 서버에 반영한다
    m.push = async (prev) => {
      const r = await m.upload(prev);
      assert.ok(r.entry, JSON.stringify(r));
      srv.apply(r.entry);
      return r.entry;
    };
    return m;
  };
  // 다른 사람이 release/1.0 에 커밋을 올린다
  f.otherPush = (file, text) => {
    const o = path.join(tmp, `${name}-other-${++f.n}`);
    g(tmp, 'clone', '-q', '-b', 'release/1.0', bare, o);
    write(o, file, text);
    g(o, 'add', '.');
    g(o, 'commit', '-q', '-m', `other ${file}`);
    g(o, 'push', '-q', 'origin', 'HEAD:refs/heads/release/1.0');
    return g(bare, 'rev-parse', 'release/1.0');
  };
  return f;
}

test('서버 조각이 있으면 사본이 그 상태로 맞춰지고, 원본에 이름표가 생긴다', async () => {
  const f = setup();
  const A = f.mac('A');
  const B = f.mac('B');
  assert.deepEqual(await A.sync(), { snapshot: null, status: 'ok' }); // 아무것도 없으면 origin/기준 그대로
  write(A.wt, 'c.txt', 'committed\n');
  g(A.wt, 'add', 'c.txt');
  g(A.wt, 'commit', '-q', '-m', 'c');
  write(A.wt, 'a.txt', lines(7, { 1: 'A-one' }));
  write(A.wt, 'u.txt', 'untracked\n');
  fs.rmSync(path.join(A.wt, 'b.txt'));
  const e = await A.push(null);
  assert.equal(e.prevSnapshot, null);
  assert.equal(e.baseCommit, g(f.bare, 'rev-parse', 'release/1.0'));

  const r = await B.sync(null);
  assert.deepEqual(r, { snapshot: e.snapshot, status: 'ok' });
  assert.equal(read(B.wt, 'c.txt'), 'committed\n');
  assert.equal(read(B.wt, 'a.txt'), lines(7, { 1: 'A-one' }));
  assert.equal(fs.existsSync(path.join(B.wt, 'b.txt')), false);
  assert.equal(g(B.wt, 'rev-parse', 'HEAD'), g(A.wt, 'rev-parse', 'HEAD')); // 커밋된 상태 그대로
  assert.deepEqual(status(B.wt).split('\n'), ['M a.txt', ' D b.txt', '?? u.txt']); // 커밋 안 한 변경은 커밋 안 한 채로
  // 원본 이름표 = 서버 스냅샷, 원본 작업 폴더·브랜치는 그대로
  assert.equal(g(B.src, 'rev-parse', `refs/rooms/${ROOM}/${REPO}`), e.snapshot);
  assert.equal(status(B.src), '');
  assert.equal(g(B.src, 'branch', '--show-current'), 'main');
  assert.deepEqual(fs.readdirSync(B.dirs), []); // 받은 조각 임시 파일은 지운다

  // 서버가 비면 이름표도 지운다
  f.srv.parts = [];
  await updateRoomRef({ sourcePath: B.src, roomId: ROOM, repoId: REPO, snapshot: null });
  assert.equal(g(B.src, 'for-each-ref', `refs/rooms/${ROOM}`), '');
});

test('이미 일부 받은 사본은 나머지 조각만 받는다. 이미 맞으면 아무것도 받지 않는다', async () => {
  const f = setup();
  const A = f.mac('A');
  const B = f.mac('B');
  await A.sync();
  write(A.wt, 'x.txt', '1\n');
  const e1 = await A.push(null);
  assert.equal((await B.sync(null)).snapshot, e1.snapshot);
  assert.deepEqual(f.srv.downloaded, [1]);

  write(A.wt, 'y.txt', '2\n');
  const e2 = await A.push(e1.snapshot);
  assert.equal(e2.prevSnapshot, e1.snapshot);
  f.srv.downloaded.length = 0;
  assert.deepEqual(await B.sync(e1.snapshot), { snapshot: e2.snapshot, status: 'ok' });
  assert.deepEqual(f.srv.downloaded, [2]); // 둘째 조각만
  assert.equal(read(B.wt, 'x.txt') + read(B.wt, 'y.txt'), '1\n2\n');

  f.srv.downloaded.length = 0;
  assert.deepEqual(await B.sync(e2.snapshot), { snapshot: e2.snapshot, status: 'ok' });
  assert.deepEqual(f.srv.downloaded, []);
});

test('직접 고친 사본에 서버 변경이 오면 합친다(merged), 합친 변경은 다음 올리기에 담긴다', async () => {
  const f = setup();
  const A = f.mac('A');
  const B = f.mac('B');
  await A.sync();
  await B.sync();
  write(A.wt, 'a.txt', lines(7, { 1: 'A-one' }));
  const e1 = await A.push(null);
  write(B.wt, 'a.txt', lines(7, { 7: 'B-seven' })); // 같은 파일 다른 줄 + 새 파일
  write(B.wt, 'mine.txt', 'mine\n');

  // 알림(background)은 합치지 않고 알리기만 한다
  assert.deepEqual(await B.sync(null, { background: true }), { snapshot: null, status: 'local_changes' });
  assert.equal(read(B.wt, 'a.txt'), lines(7, { 7: 'B-seven' }));

  const r = await B.sync(null);
  assert.deepEqual(r, { snapshot: e1.snapshot, status: 'ok', merged: true });
  assert.equal(read(B.wt, 'a.txt'), lines(7, { 1: 'A-one', 7: 'B-seven' }));
  assert.equal(read(B.wt, 'mine.txt'), 'mine\n');
  // B 의 다음 올리기: 서버 스냅샷 위에서 B 의 변경만 증분으로
  const e2 = await B.push(r.snapshot);
  assert.equal(e2.prevSnapshot, e1.snapshot);
  const C = f.mac('C');
  await C.sync(null);
  assert.equal(read(C.wt, 'a.txt'), lines(7, { 1: 'A-one', 7: 'B-seven' }));
  assert.equal(read(C.wt, 'mine.txt'), 'mine\n');
});

test('충돌하면 conflict, 사본은 그대로', async () => {
  const f = setup();
  const A = f.mac('A');
  const B = f.mac('B');
  await A.sync();
  await B.sync();
  write(A.wt, 'a.txt', lines(7, { 3: 'A-three' }));
  const e1 = await A.push(null);
  write(B.wt, 'a.txt', lines(7, { 3: 'B-three' }));
  const head = g(B.wt, 'rev-parse', 'HEAD');
  const r = await B.sync(null);
  assert.deepEqual(r, { snapshot: null, status: 'conflict' });
  assert.equal(read(B.wt, 'a.txt'), lines(7, { 3: 'B-three' }));
  assert.equal(g(B.wt, 'rev-parse', 'HEAD'), head);
  assert.equal(status(B.wt), 'M a.txt');
  assert.notEqual(e1.snapshot, null);
});

test('서버가 비웠으면: 고친 게 없는 사본은 origin/기준으로 깨끗이, 고친 게 있으면 그대로 두고 local_changes', async () => {
  const f = setup();
  const A = f.mac('A');
  const B = f.mac('B');
  await A.sync();
  write(A.wt, 'x.txt', '1\n');
  const e1 = await A.push(null);
  await B.sync(null);
  const C = f.mac('C');
  await C.sync(null);
  write(C.wt, 'x.txt', '1\nC\n'); // 이 맥에서 직접 고침

  f.srv.parts = []; // 기준 변경·승격으로 서버가 비움
  const tip = f.otherPush('new.txt', 'n\n');
  assert.deepEqual(await B.sync(e1.snapshot), { snapshot: null, status: 'ok' });
  assert.equal(g(B.wt, 'rev-parse', 'HEAD'), tip);
  assert.equal(status(B.wt), '');
  assert.equal(fs.existsSync(path.join(B.wt, 'x.txt')), false);
  assert.equal(read(B.wt, 'new.txt'), 'n\n');

  assert.deepEqual(await C.sync(e1.snapshot), { snapshot: null, status: 'local_changes' });
  assert.equal(read(C.wt, 'x.txt'), '1\nC\n');
});

test('서버 코드가 없고 origin/기준이 앞서면 사본을 따라가게(rebase) 한다. 충돌이면 conflict', async () => {
  const f = setup();
  const A = f.mac('A');
  await A.sync();
  write(A.wt, 'a.txt', lines(7, { 2: 'mine' })); // 직접 고침(서버에는 안 올림)
  g(A.wt, 'commit', '-qam', 'mine');
  const mine = g(A.wt, 'rev-parse', 'HEAD');
  const tip = f.otherPush('c.txt', 'c\n');
  const r = await A.sync();
  assert.deepEqual(r, { snapshot: null, status: 'ok' });
  assert.equal(g(A.wt, 'rev-parse', 'HEAD~1'), tip); // 내 커밋이 새 기준 위로
  assert.notEqual(g(A.wt, 'rev-parse', 'HEAD'), mine);
  assert.equal(read(A.wt, 'c.txt'), 'c\n');

  // 알림(background)은 따라가지 않는다
  const tip2 = f.otherPush('d.txt', 'd\n');
  await A.sync(null, { background: true });
  assert.notEqual(g(A.wt, 'rev-parse', 'HEAD~1'), tip2);

  // 같은 줄이 겹치면 충돌, 사본은 그대로
  write(A.wt, 'a.txt', lines(7, { 2: 'mine2' }));
  g(A.wt, 'commit', '-qam', 'mine2');
  f.otherPush('a.txt', lines(7, { 2: 'theirs' }));
  const head = g(A.wt, 'rev-parse', 'HEAD');
  assert.deepEqual(await A.sync(), { snapshot: null, status: 'conflict' });
  assert.equal(g(A.wt, 'rev-parse', 'HEAD'), head);
  assert.equal(status(A.wt), '');
});

test('원격에 없는 기준 브랜치는 BRANCH_NOT_ON_REMOTE, 서버가 비워서 맞출 게 없는 새 사본은 origin/기준 그대로', async () => {
  const f = setup();
  const A = f.mac('A');
  await assert.rejects(A.sync(null, { repo: { baseBranch: 'nope' } }), { message: 'BRANCH_NOT_ON_REMOTE' });
  // 사본이 새로 만들어지면 맞춰 둔 기록(lastApplied)은 무시한다
  const r = await A.sync('f'.repeat(40));
  assert.deepEqual(r, { snapshot: null, status: 'ok' });
  assert.equal(g(A.wt, 'rev-parse', 'HEAD'), g(f.bare, 'rev-parse', 'release/1.0'));
});

test('uploadRepoCode: 같으면 올리지 않고, 증분은 prevSnapshot 을 잇고, 바뀐 게 없으면 생략·비우기', async () => {
  const f = setup();
  const A = f.mac('A');
  await A.sync();
  assert.deepEqual(await A.upload(null), { skipped: 'empty' }); // 서버도 비었고 사본도 깨끗
  write(A.wt, 'x.txt', '1\n');
  const e1 = (await A.upload(null)).entry;
  assert.deepEqual([e1.repoId, e1.baseBranch, e1.prevSnapshot], [REPO, 'release/1.0', null]);
  assert.match(e1.uploadId, /^[0-9a-f]{16}$/);
  f.srv.apply(e1);
  assert.deepEqual(await A.upload(e1.snapshot), { skipped: 'same' });

  write(A.wt, 'y.txt', '2\n');
  const e2 = (await A.upload(e1.snapshot)).entry;
  assert.equal(e2.prevSnapshot, e1.snapshot);
  assert.equal(e2.baseCommit, g(f.bare, 'rev-parse', 'release/1.0'));
  assert.ok(fs.statSync(f.srv.uploads.get(e2.uploadId)).size < fs.statSync(f.srv.uploads.get(e1.uploadId)).size + 5000); // 증분만 담는다

  // 사본이 기준과 같아졌는데 서버에 코드가 있으면 비우기
  fs.rmSync(path.join(A.wt, 'x.txt'));
  fs.rmSync(path.join(A.wt, 'y.txt'));
  assert.deepEqual(await A.upload(e1.snapshot), { entry: { repoId: REPO, baseBranch: 'release/1.0', snapshot: null, uploadId: null } });
  assert.deepEqual(fs.readdirSync(A.dirs), []); // 올린 임시 파일은 지운다
});

test('uploadRepoCode: 조각이 100개 이상이면 prev 없이 통째로, 2GB 초과(BUNDLE_TOO_BIG)면 tooBig, 다른 오류는 던진다', async () => {
  const f = setup();
  const A = f.mac('A');
  await A.sync();
  write(A.wt, 'x.txt', '1\n');
  const e1 = (await A.upload(null)).entry;
  f.srv.apply(e1);
  write(A.wt, 'y.txt', '2\n');
  assert.equal((await A.upload(e1.snapshot, { parts: 99 })).entry.prevSnapshot, e1.snapshot);
  const whole = (await A.upload(e1.snapshot, { parts: 100 })).entry;
  assert.equal(whole.prevSnapshot, null);
  assert.ok(fs.statSync(f.srv.uploads.get(whole.uploadId)).size > 0);
  // 통째로 올린 것을 받으면 x·y 가 모두 들어 있다
  f.srv.apply(whole);
  const B = f.mac('B');
  await B.sync(null);
  assert.equal(read(B.wt, 'x.txt') + read(B.wt, 'y.txt'), '1\n2\n');

  f.srv.bundleError = 'BUNDLE_TOO_BIG';
  write(A.wt, 'z.txt', '3\n');
  assert.deepEqual(await A.upload(whole.snapshot), { tooBig: true });
  assert.deepEqual(fs.readdirSync(A.dirs), []);
  f.srv.bundleError = 'SERVER_UNREACHABLE';
  await assert.rejects(A.upload(whole.snapshot), { message: 'SERVER_UNREACHABLE' });
});

test('승격: base 를 작업 브랜치로 바꿔 올리면 pushed 커밋 기준으로 담는다', async () => {
  const f = setup();
  const A = f.mac('A');
  await A.sync();
  write(A.wt, 'x.txt', '1\n');
  g(A.wt, 'add', '-A');
  g(A.wt, 'commit', '-qm', 'x');
  g(A.wt, 'push', '-q', 'origin', 'HEAD:refs/heads/feature/X');
  g(A.src, 'fetch', '-q', 'origin');
  assert.deepEqual(await A.upload(null, { repo: { baseBranch: 'feature/X' } }), { skipped: 'empty' }); // push 한 그대로 → 올릴 게 없다
  write(A.wt, 'y.txt', '2\n');
  const e = (await A.upload(null, { repo: { baseBranch: 'feature/X' } })).entry;
  assert.equal(e.baseBranch, 'feature/X');
  assert.equal(e.baseCommit, g(f.bare, 'rev-parse', 'feature/X'));
});

test('ensureWorktree 가 만든 사본을 syncRepoCode 가 그대로 이어 쓴다(이미 있는 사본은 새로 만들지 않는다)', async () => {
  const f = setup();
  const A = f.mac('A');
  await ensureWorktree({ sourcePath: A.src, worktreePath: A.wt, branch: 'release/1.0' });
  write(A.wt, 'keep.txt', 'k\n');
  await A.sync(null);
  assert.equal(read(A.wt, 'keep.txt'), 'k\n');
});
