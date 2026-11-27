import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { snapshot, createBundle, applyParts, mergeLocal, rebaseOnto, remoteHas } from '../main/runner/codeState.js';

const g = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.quotepath=off', ...args], { cwd, stdio: 'pipe' }).toString().trim();

let tmp;
let seq = 0;
before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rooms-cs-')); });
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const write = (dir, file, text) => { fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); fs.writeFileSync(path.join(dir, file), text); };
const read = (dir, file) => fs.readFileSync(path.join(dir, file), 'utf8');
const lines = (n, patch = {}) => Array.from({ length: n }, (_, i) => patch[i + 1] ?? `l${i + 1}`).join('\n') + '\n';
const status = (wt) => g(wt, 'status', '--porcelain', '-uall');
const names = (wt, rev) => g(wt, 'ls-tree', '-r', '--name-only', rev).split('\n').sort();

/** bare origin(main, release/1.0) + 맥 사본을 만드는 함수(별도 clone 의 worktree, detached) */
function setup() {
  const name = `f${++seq}`;
  const bare = path.join(tmp, `${name}.git`);
  const seed = path.join(tmp, `${name}-seed`);
  fs.mkdirSync(seed);
  g(seed, 'init', '-q', '-b', 'main');
  write(seed, 'a.txt', lines(7));
  write(seed, 'b.txt', 'b\n');
  write(seed, '.gitignore', '*.log\n');
  write(seed, '수정될.txt', '원래\n');
  write(seed, '삭제될.txt', '지워질\n');
  g(seed, 'add', '.');
  g(seed, 'commit', '-q', '-m', 'init');
  g(seed, 'branch', 'release/1.0');
  g(tmp, 'init', '-q', '--bare', '-b', 'main', bare);
  g(seed, 'remote', 'add', 'origin', bare);
  g(seed, 'push', '-q', 'origin', 'main', 'release/1.0');
  const f = { bare, seed, base: g(bare, 'rev-parse', 'release/1.0'), n: 0 };
  f.mac = (label) => {
    const src = path.join(tmp, `${name}-${label}-src`);
    g(tmp, 'clone', '-q', bare, src);
    const wt = path.join(tmp, `${name}-${label}-wt`);
    g(src, 'worktree', 'add', '-q', '--detach', wt, 'origin/release/1.0');
    return { src, wt };
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
  // 스냅샷을 만들고 묶는다(prev: 이전 스냅샷 — 주면 그 이후 바뀐 것만 묶는다)
  f.pack = async (wt, prev) => {
    const s = await snapshot({ worktree: wt, base: f.base, prev });
    const file = path.join(tmp, `${name}-${++f.n}.bundle`);
    const r = await createBundle({ worktree: wt, base: f.base, prev, snapshot: s.snapshot, file });
    return { ...s, file, r };
  };
  return f;
}

// A 사본: 커밋 1개 + 커밋 안 한 수정 + 새 파일 + 삭제 + 무시되는 파일
function work(wt) {
  write(wt, 'c.txt', 'committed\n');
  g(wt, 'add', 'c.txt');
  g(wt, 'commit', '-q', '-m', 'c');
  write(wt, 'a.txt', lines(7, { 1: 'A1' }));
  write(wt, 'u.txt', 'untracked\n');
  write(wt, 'c.txt', 'committed\nplus\n');
  fs.rmSync(path.join(wt, 'b.txt'));
  write(wt, 'junk.log', 'A-junk\n');
}

test('snapshot: 수정·새 파일·삭제·커밋 안 한 변경을 담고 작업 폴더·인덱스·HEAD 는 그대로', async () => {
  const f = setup();
  const { wt } = f.mac('a');
  work(wt);
  const [head, st] = [g(wt, 'rev-parse', 'HEAD'), status(wt)];
  const r = await snapshot({ worktree: wt, base: f.base });
  assert.equal(r.empty, false);
  assert.deepEqual(names(wt, r.snapshot), ['.gitignore', 'a.txt', 'c.txt', 'u.txt', '삭제될.txt', '수정될.txt'].sort()); // b.txt 삭제, junk.log 제외
  assert.equal(g(wt, 'show', `${r.snapshot}:a.txt`), lines(7, { 1: 'A1' }).trim());
  assert.equal(g(wt, 'show', `${r.snapshot}:c.txt`), 'committed\nplus');
  assert.equal(g(wt, 'rev-parse', `${r.snapshot}^`), head);
  assert.equal(g(wt, 'rev-parse', 'HEAD'), head);
  assert.equal(status(wt), st);
  g(wt, 'diff', '--cached', '--quiet'); // 인덱스는 비어 있는 그대로(바뀌었으면 종료 코드 1 로 던진다)
  // 스테이징해 둔 것도 그대로
  g(wt, 'add', 'u.txt');
  const staged = g(wt, 'diff', '--cached', '--name-only');
  await snapshot({ worktree: wt, base: f.base });
  assert.equal(g(wt, 'diff', '--cached', '--name-only'), staged);
});

test('snapshot: 변경이 없고 HEAD 가 base 면 empty, 커밋만 있어도 empty 아님', async () => {
  const f = setup();
  const { wt } = f.mac('a');
  assert.equal((await snapshot({ worktree: wt, base: f.base })).empty, true);
  write(wt, 'x.txt', 'x\n');
  assert.equal((await snapshot({ worktree: wt, base: f.base })).empty, false);
  g(wt, 'add', '.');
  g(wt, 'commit', '-q', '-m', 'x');
  assert.equal((await snapshot({ worktree: wt, base: f.base })).empty, false);
});

test('createBundle: 변경이 없으면 묶지 않고, base 가 없으면 NO_BASE, 임시 ref 는 남지 않는다', async () => {
  const f = setup();
  const { wt } = f.mac('a');
  const none = await f.pack(wt);
  assert.deepEqual(none.r, { ok: true, size: 0, empty: true });
  assert.equal(fs.existsSync(none.file), false);
  write(wt, 'x.txt', 'x\n');
  const s = await snapshot({ worktree: wt, base: f.base });
  const bad = await createBundle({ worktree: wt, base: '0'.repeat(40), snapshot: s.snapshot, file: path.join(tmp, 'nobase.bundle') });
  assert.deepEqual(bad, { ok: false, reason: 'NO_BASE' });
  const ok = await f.pack(wt);
  assert.equal(ok.r.ok, true);
  assert.ok(ok.r.size > 0);
  assert.equal(g(wt, 'for-each-ref', 'refs/rooms'), '');
});

test('createBundle → applyParts: B 사본이 A 사본과 같아진다(커밋·커밋 안 한 변경 구분 유지)', async () => {
  const f = setup();
  const a = f.mac('a');
  const b = f.mac('b');
  write(b.wt, 'junk.log', 'B-junk\n'); // 무시되는 파일은 그대로 남아야 한다
  work(a.wt);
  const p = await f.pack(a.wt);
  assert.equal(p.r.ok, true);
  assert.deepEqual(await applyParts({ worktree: b.wt, files: [p.file], snapshot: p.snapshot }), { applied: true });

  assert.equal(g(b.wt, 'rev-parse', 'HEAD'), g(a.wt, 'rev-parse', 'HEAD')); // 커밋된 상태
  assert.equal(g(b.wt, 'branch', '--show-current'), '');
  assert.equal(status(b.wt), status(a.wt)); // 커밋 안 한 변경 목록
  g(b.wt, 'diff', '--cached', '--quiet');
  for (const file of ['a.txt', 'c.txt', 'u.txt']) assert.equal(read(b.wt, file), read(a.wt, file), file);
  assert.equal(fs.existsSync(path.join(b.wt, 'b.txt')), false);
  assert.equal(read(b.wt, 'junk.log'), 'B-junk\n');

  // 이어서 A 가 더 고친다(untracked 였던 u.txt 를 지움) → lastApplied 를 주고 다시 맞춘다
  fs.rmSync(path.join(a.wt, 'u.txt'));
  write(a.wt, 'v.txt', 'v\n');
  write(a.wt, 'a.txt', lines(7, { 1: 'A1', 7: 'A7' }));
  const p2 = await f.pack(a.wt);
  assert.deepEqual(await applyParts({ worktree: b.wt, files: [p2.file], snapshot: p2.snapshot, lastApplied: p.snapshot }), { applied: true });
  assert.equal(status(b.wt), status(a.wt));
  assert.equal(fs.existsSync(path.join(b.wt, 'u.txt')), false);
  assert.equal(read(b.wt, 'a.txt'), read(a.wt, 'a.txt'));
});

test('applyParts: .gitignore 된 파일은 묶이지도 지워지지도 않는다', async () => {
  const f = setup();
  const a = f.mac('a');
  const b = f.mac('b');
  write(a.wt, 'junk.log', 'A-junk\n');
  write(a.wt, 'x.txt', 'x\n');
  write(b.wt, 'junk.log', 'B-junk\n'); // 직접 고침 판정에도 안 걸린다
  const p = await f.pack(a.wt);
  assert.equal(g(a.wt, 'ls-tree', '-r', '--name-only', p.snapshot).includes('junk.log'), false);
  assert.deepEqual(await applyParts({ worktree: b.wt, files: [p.file], snapshot: p.snapshot }), { applied: true });
  assert.equal(read(b.wt, 'junk.log'), 'B-junk\n');
  assert.equal(read(b.wt, 'x.txt'), 'x\n');
  // 다음 맞추기에서 A 쪽 x.txt 가 사라져도 B 의 junk.log 는 남는다
  fs.rmSync(path.join(a.wt, 'x.txt'));
  write(a.wt, 'y.txt', 'y\n');
  const p2 = await f.pack(a.wt);
  assert.deepEqual(await applyParts({ worktree: b.wt, files: [p2.file], snapshot: p2.snapshot, lastApplied: p.snapshot }), { applied: true });
  assert.equal(fs.existsSync(path.join(b.wt, 'x.txt')), false);
  assert.equal(read(b.wt, 'junk.log'), 'B-junk\n');
});

test('applyParts U11: B 가 직접 고친 상태면 맞추지 않고 LOCAL_CHANGES, B 는 그대로', async () => {
  const f = setup();
  const a = f.mac('a');
  const b = f.mac('b');
  write(a.wt, 'x.txt', 'x\n');
  const p = await f.pack(a.wt);

  write(b.wt, 'a.txt', lines(7, { 3: 'B3' })); // 마지막으로 맞춘 상태(없음 = 깨끗한 HEAD)와 다르다
  const [head, st] = [g(b.wt, 'rev-parse', 'HEAD'), status(b.wt)];
  assert.deepEqual(await applyParts({ worktree: b.wt, files: [p.file], snapshot: p.snapshot }), { applied: false, reason: 'LOCAL_CHANGES' });
  assert.equal(read(b.wt, 'a.txt'), lines(7, { 3: 'B3' }));
  assert.equal(fs.existsSync(path.join(b.wt, 'x.txt')), false);
  assert.equal(g(b.wt, 'rev-parse', 'HEAD'), head);
  assert.equal(status(b.wt), st);

  // 맞춘 뒤 새 파일을 만들어도(lastApplied 기준) 직접 고친 것이다
  const c = f.mac('c');
  assert.deepEqual(await applyParts({ worktree: c.wt, files: [p.file], snapshot: p.snapshot }), { applied: true });
  write(c.wt, 'mine.txt', 'mine\n');
  write(a.wt, 'y.txt', 'y\n');
  const p2 = await f.pack(a.wt);
  assert.deepEqual(await applyParts({ worktree: c.wt, files: [p2.file], snapshot: p2.snapshot, lastApplied: p.snapshot }), { applied: false, reason: 'LOCAL_CHANGES' });
  assert.equal(read(c.wt, 'mine.txt'), 'mine\n');
  // 아무것도 안 고쳤으면 lastApplied 기준으로도 맞춰진다
  fs.rmSync(path.join(c.wt, 'mine.txt'));
  assert.deepEqual(await applyParts({ worktree: c.wt, files: [p2.file], snapshot: p2.snapshot, lastApplied: p.snapshot }), { applied: true });
});

test('applyParts: 묶음의 기준 커밋이 없는 저장소면 MISSING_BASE, 묶음에 없는 스냅샷이면 BAD_BUNDLE', async () => {
  const f = setup();
  const a = f.mac('a');
  write(a.wt, 'x.txt', 'x\n');
  const p = await f.pack(a.wt);
  const lone = path.join(tmp, 'lone');
  fs.mkdirSync(lone);
  g(lone, 'init', '-q', '-b', 'main');
  write(lone, 'z.txt', 'z\n');
  g(lone, 'add', '.');
  g(lone, 'commit', '-q', '-m', 'z');
  assert.deepEqual(await applyParts({ worktree: lone, files: [p.file], snapshot: p.snapshot }), { applied: false, reason: 'MISSING_BASE' });
  const b = f.mac('b');
  await assert.rejects(applyParts({ worktree: b.wt, files: [p.file], snapshot: f.base }), /BAD_BUNDLE/);
});

test('mergeLocal: 겹치지 않는 변경은 합쳐지고(같은 파일 다른 줄 포함) 사본이 합친 스냅샷으로 맞춰진다', async () => {
  const f = setup();
  const a = f.mac('a');
  const b = f.mac('b');
  write(a.wt, 'a.txt', lines(7, { 1: 'A1' }));
  const p1 = await f.pack(a.wt);
  await applyParts({ worktree: b.wt, files: [p1.file], snapshot: p1.snapshot });

  write(a.wt, 'a.txt', lines(7, { 1: 'A1', 7: 'A7' })); // A 가 이어서 고침
  write(a.wt, 'x.txt', 'x\n');
  const p2 = await f.pack(a.wt, p1.snapshot);
  write(b.wt, 'a.txt', lines(7, { 1: 'A1', 4: 'B4' })); // B 가 직접 고침(같은 파일, 다른 줄)
  write(b.wt, 'b.txt', 'B-b\n');
  assert.equal((await applyParts({ worktree: b.wt, files: [p2.file], snapshot: p2.snapshot, lastApplied: p1.snapshot })).reason, 'LOCAL_CHANGES');

  const r = await mergeLocal({ worktree: b.wt, remoteSnapshot: p2.snapshot, files: [p2.file], lastApplied: p1.snapshot });
  assert.equal(r.ok, true);
  assert.equal(read(b.wt, 'a.txt'), lines(7, { 1: 'A1', 4: 'B4', 7: 'A7' }));
  assert.equal(read(b.wt, 'b.txt'), 'B-b\n');
  assert.equal(read(b.wt, 'x.txt'), 'x\n');
  assert.equal(g(b.wt, 'rev-parse', 'HEAD'), g(a.wt, 'rev-parse', 'HEAD')); // 커밋된 상태는 서버 스냅샷의 것
  assert.equal(g(b.wt, 'rev-parse', `${r.snapshot}^`), g(b.wt, 'rev-parse', 'HEAD'));
  assert.equal(g(b.wt, 'rev-parse', `${r.snapshot}^2`), p2.snapshot); // 둘째 부모 = 원격 스냅샷(다음 증분의 기준)
  assert.equal(g(b.wt, 'diff', '--cached', '--name-only'), '');
  // 합친 결과가 그대로 사본의 상태이므로 lastApplied 로 쓸 수 있다
  assert.equal(await snapshot({ worktree: b.wt }).then((s) => g(b.wt, 'rev-parse', `${s.snapshot}^{tree}`) === g(b.wt, 'rev-parse', `${r.snapshot}^{tree}`)), true);
});

test('mergeLocal: 같은 줄 충돌이면 CONFLICT, 사본은 그대로', async () => {
  const f = setup();
  const a = f.mac('a');
  const b = f.mac('b');
  write(a.wt, 'a.txt', lines(7, { 1: 'A1' }));
  const p1 = await f.pack(a.wt);
  await applyParts({ worktree: b.wt, files: [p1.file], snapshot: p1.snapshot });
  write(a.wt, 'a.txt', lines(7, { 1: 'A1', 7: 'A7' }));
  const p2 = await f.pack(a.wt);
  write(b.wt, 'a.txt', lines(7, { 1: 'A1', 7: 'B7' }));
  write(b.wt, 'mine.txt', 'mine\n');
  const [head, st] = [g(b.wt, 'rev-parse', 'HEAD'), status(b.wt)];

  const r = await mergeLocal({ worktree: b.wt, remoteSnapshot: p2.snapshot, files: [p2.file], lastApplied: p1.snapshot });
  assert.deepEqual(r, { ok: false, reason: 'CONFLICT' });
  assert.equal(read(b.wt, 'a.txt'), lines(7, { 1: 'A1', 7: 'B7' }));
  assert.equal(read(b.wt, 'mine.txt'), 'mine\n');
  assert.equal(g(b.wt, 'rev-parse', 'HEAD'), head);
  assert.equal(status(b.wt), st);
});

test('rebaseOnto: 기준 브랜치가 앞서 가면 사본 커밋과 커밋 안 한 변경이 새 기준 위로 옮겨진다', async () => {
  const f = setup();
  const { src, wt } = f.mac('a');
  work(wt);
  write(wt, 'b.txt', 'b\n'); // work() 가 지운 b.txt 를 되살려 둔다(다른 사람이 b.txt 를 고친다)
  const newBase = f.otherPush('b.txt', 'b-other\n');
  g(src, 'fetch', '-q', 'origin');

  const r = await rebaseOnto({ worktree: wt, base: f.base, newBase: 'origin/release/1.0' });
  assert.equal(r.ok, true);
  assert.equal(g(wt, 'rev-parse', 'HEAD^'), newBase); // 사본 커밋 1개가 새 기준 위에
  assert.equal(g(wt, 'show', 'HEAD:c.txt'), 'committed');
  assert.equal(read(wt, 'b.txt'), 'b-other\n'); // 새 기준의 변경
  assert.equal(read(wt, 'a.txt'), lines(7, { 1: 'A1' })); // 커밋 안 한 수정이 그대로 얹힘
  assert.equal(read(wt, 'c.txt'), 'committed\nplus\n');
  assert.equal(read(wt, 'u.txt'), 'untracked\n');
  assert.equal(status(wt), 'M a.txt\n M c.txt\n?? u.txt');
  assert.equal(g(wt, 'rev-parse', `${r.snapshot}^`), g(wt, 'rev-parse', 'HEAD'));
  assert.equal(g(wt, 'stash', 'list'), '');
});

test('rebaseOnto: 커밋이 충돌하면 CONFLICT, 원래 상태(HEAD·미커밋 변경)로 되돌린다', async () => {
  const f = setup();
  const { src, wt } = f.mac('a');
  write(wt, 'a.txt', lines(7, { 1: 'C1' }));
  g(wt, 'commit', '-q', '-am', 'local');
  write(wt, 'b.txt', 'b-dirty\n');
  write(wt, 'u.txt', 'u\n');
  f.otherPush('a.txt', lines(7, { 1: 'O1' }));
  g(src, 'fetch', '-q', 'origin');
  const [head, st] = [g(wt, 'rev-parse', 'HEAD'), status(wt)];

  assert.deepEqual(await rebaseOnto({ worktree: wt, base: f.base, newBase: 'origin/release/1.0' }), { ok: false, reason: 'CONFLICT' });
  assert.equal(g(wt, 'rev-parse', 'HEAD'), head);
  assert.equal(status(wt), st);
  assert.equal(read(wt, 'b.txt'), 'b-dirty\n');
  assert.equal(g(wt, 'stash', 'list'), '');
  assert.equal(fs.existsSync(path.join(g(wt, 'rev-parse', '--absolute-git-dir'), 'rebase-merge')), false);
});

test('rebaseOnto: 커밋 안 한 변경이 새 기준과 충돌해도 CONFLICT 이고 원래 상태', async () => {
  const f = setup();
  const { src, wt } = f.mac('a');
  write(wt, 'a.txt', lines(7, { 1: 'L1' }));
  f.otherPush('a.txt', lines(7, { 1: 'O1' }));
  g(src, 'fetch', '-q', 'origin');
  const [head, st] = [g(wt, 'rev-parse', 'HEAD'), status(wt)];

  assert.deepEqual(await rebaseOnto({ worktree: wt, base: f.base, newBase: 'origin/release/1.0' }), { ok: false, reason: 'CONFLICT' });
  assert.equal(g(wt, 'rev-parse', 'HEAD'), head);
  assert.equal(status(wt), st);
  assert.equal(read(wt, 'a.txt'), lines(7, { 1: 'L1' }));
  assert.equal(g(wt, 'stash', 'list'), '');
});

test('remoteHas: 원격 브랜치 유무', async () => {
  const f = setup();
  const { wt } = f.mac('a');
  assert.equal(await remoteHas({ worktree: wt, branch: 'release/1.0' }), true);
  assert.equal(await remoteHas({ worktree: wt, branch: 'feature/NOPE-1' }), false);
  await assert.rejects(remoteHas({ worktree: wt, branch: '--bad' }), /BAD_BRANCH/);
  g(wt, 'remote', 'set-url', 'origin', path.join(tmp, 'no-such.git'));
  await assert.rejects(remoteHas({ worktree: wt, branch: 'release/1.0' })); // 원격에 닿지 못하면 없다고 하지 않는다
});

test('한글 파일 이름: 새 파일·수정·삭제·하위 폴더가 그대로 맞춰진다', async () => {
  const f = setup();
  const a = f.mac('a');
  const b = f.mac('b');
  write(a.wt, '새 파일.txt', '새로\n');
  write(a.wt, '폴더/하위 파일.txt', '하위\n');
  write(a.wt, '수정될.txt', '바뀜\n');
  fs.rmSync(path.join(a.wt, '삭제될.txt'));
  const p = await f.pack(a.wt);
  assert.deepEqual(await applyParts({ worktree: b.wt, files: [p.file], snapshot: p.snapshot }), { applied: true });
  assert.equal(read(b.wt, '새 파일.txt'), '새로\n');
  assert.equal(read(b.wt, '폴더/하위 파일.txt'), '하위\n');
  assert.equal(read(b.wt, '수정될.txt'), '바뀜\n');
  assert.equal(fs.existsSync(path.join(b.wt, '삭제될.txt')), false);
  assert.equal(status(b.wt), status(a.wt));
  assert.ok(names(a.wt, p.snapshot).includes('폴더/하위 파일.txt'));
});

// ── 증분 조각 ──
const big = (wt, file = 'big.bin', mb = 4) => write(wt, file, crypto.randomBytes(mb * 1024 * 1024));
const parentCount = (wt, rev) => g(wt, 'rev-list', '--parents', '-n1', rev).split(' ').length - 1;

test('snapshot prev: 둘째 부모가 prev, 서버 상태에서 바뀐 게 없으면 same, prev 가 저장소에 없으면 부모 1개', async () => {
  const f = setup();
  const { wt } = f.mac('a');
  write(wt, 'x.txt', 'x\n');
  const s1 = await snapshot({ worktree: wt, base: f.base });
  assert.equal(s1.same, false);
  assert.equal(parentCount(wt, s1.snapshot), 1);
  const s2 = await snapshot({ worktree: wt, base: f.base, prev: s1.snapshot });
  assert.equal(parentCount(wt, s2.snapshot), 2);
  assert.equal(g(wt, 'rev-parse', `${s2.snapshot}^1`), g(wt, 'rev-parse', 'HEAD'));
  assert.equal(g(wt, 'rev-parse', `${s2.snapshot}^2`), s1.snapshot);
  assert.equal(s2.same, true); // 트리·첫째 부모가 prev 와 같다
  write(wt, 'y.txt', 'y\n');
  assert.equal((await snapshot({ worktree: wt, base: f.base, prev: s1.snapshot })).same, false); // 트리가 다르다
  g(wt, 'add', '.');
  g(wt, 'commit', '-q', '-m', 'x');
  assert.equal((await snapshot({ worktree: wt, base: f.base, prev: s1.snapshot })).same, false); // 첫째 부모(HEAD)가 다르다
  const s3 = await snapshot({ worktree: wt, base: f.base, prev: '1'.repeat(40) });
  assert.equal(s3.same, false);
  assert.equal(parentCount(wt, s3.snapshot), 1);
  assert.equal(g(wt, 'for-each-ref', 'refs/rooms'), '');
});

test('createBundle prev: 큰 바이너리가 이미 올라간 뒤 작은 수정은 바이너리보다 훨씬 작게 묶인다', async () => {
  const f = setup();
  const { wt } = f.mac('a');
  big(wt);
  g(wt, 'add', '.');
  g(wt, 'commit', '-q', '-m', 'big');
  write(wt, 'x.txt', 'x\n');
  const p1 = await f.pack(wt);
  assert.ok(p1.r.size > 4 * 1024 * 1024);
  write(wt, 'a.txt', lines(7, { 1: 'A1' }));
  const p2 = await f.pack(wt, p1.snapshot);
  assert.equal(p2.r.ok, true);
  assert.ok(p2.r.size < 10 * 1024, `증분 ${p2.r.size}`);
  // 커밋 안 한 큰 파일도 한 번 올라간 뒤엔 다시 안 담긴다
  big(wt, 'big2.bin', 2);
  const p3 = await f.pack(wt, p2.snapshot);
  assert.ok(p3.r.size > 2 * 1024 * 1024);
  write(wt, 'x.txt', 'x2\n');
  const p4 = await f.pack(wt, p3.snapshot);
  assert.ok(p4.r.size < 10 * 1024, `증분 ${p4.r.size}`);
  assert.equal(g(wt, 'for-each-ref', 'refs/rooms'), '');
});

test('applyParts: 조각 3개(전체→증분→증분)를 차례로 적용하면 마지막 상태와 같다, 이미 맞춘 사본엔 뒤 조각만 줘도 된다', async () => {
  const f = setup();
  const a = f.mac('a');
  work(a.wt);
  const p1 = await f.pack(a.wt);
  fs.rmSync(path.join(a.wt, 'u.txt'));
  write(a.wt, 'v.txt', 'v\n');
  const p2 = await f.pack(a.wt, p1.snapshot);
  write(a.wt, 'v.txt', 'v2\n');
  g(a.wt, 'add', 'v.txt');
  g(a.wt, 'commit', '-q', '-m', 'v'); // 커밋된 상태가 바뀐다
  write(a.wt, 'w.txt', 'w\n');
  const p3 = await f.pack(a.wt, p2.snapshot);
  const same = (b) => {
    assert.equal(g(b.wt, 'rev-parse', 'HEAD'), g(a.wt, 'rev-parse', 'HEAD'));
    assert.equal(status(b.wt), status(a.wt));
    g(b.wt, 'diff', '--cached', '--quiet');
    for (const x of ['a.txt', 'c.txt', 'v.txt', 'w.txt']) assert.equal(read(b.wt, x), read(a.wt, x), x);
    assert.equal(fs.existsSync(path.join(b.wt, 'u.txt')), false);
  };

  const b = f.mac('b');
  assert.deepEqual(await applyParts({ worktree: b.wt, files: [p1.file, p2.file, p3.file], snapshot: p3.snapshot }), { applied: true });
  same(b);

  const c = f.mac('c');
  assert.deepEqual(await applyParts({ worktree: c.wt, files: [p1.file], snapshot: p1.snapshot }), { applied: true });
  assert.deepEqual(await applyParts({ worktree: c.wt, files: [p2.file, p3.file], snapshot: p3.snapshot, lastApplied: p1.snapshot }), { applied: true });
  same(c);
});

test('applyParts: 조각이 빠지면 MISSING_BASE 이고 사본은 그대로, 마지막 조각에 snapshot 이 없으면 BAD_BUNDLE', async () => {
  const f = setup();
  const a = f.mac('a');
  write(a.wt, 'x.txt', 'x\n');
  const p1 = await f.pack(a.wt);
  write(a.wt, 'y.txt', 'y\n');
  const p2 = await f.pack(a.wt, p1.snapshot);
  write(a.wt, 'z.txt', 'z\n');
  const p3 = await f.pack(a.wt, p2.snapshot);
  const b = f.mac('b');
  const [head, st] = [g(b.wt, 'rev-parse', 'HEAD'), status(b.wt)];
  assert.deepEqual(await applyParts({ worktree: b.wt, files: [p3.file], snapshot: p3.snapshot }), { applied: false, reason: 'MISSING_BASE' });
  assert.deepEqual(await applyParts({ worktree: b.wt, files: [p1.file, p3.file], snapshot: p3.snapshot }), { applied: false, reason: 'MISSING_BASE' });
  assert.equal(g(b.wt, 'rev-parse', 'HEAD'), head);
  assert.equal(status(b.wt), st);
  await assert.rejects(applyParts({ worktree: b.wt, files: [p1.file, p2.file], snapshot: p3.snapshot }), /BAD_BUNDLE/);
});

test('rebaseOnto prev: 새 기준 위로 옮긴 뒤 스냅샷도 증분 묶음이 작다', async () => {
  const f = setup();
  const { src, wt } = f.mac('a');
  big(wt);
  g(wt, 'add', '.');
  g(wt, 'commit', '-q', '-m', 'big');
  write(wt, 'x.txt', 'x\n');
  const p1 = await f.pack(wt);
  f.otherPush('b.txt', 'b-other\n');
  g(src, 'fetch', '-q', 'origin');

  const r = await rebaseOnto({ worktree: wt, base: f.base, newBase: 'origin/release/1.0', prev: p1.snapshot });
  assert.equal(r.ok, true);
  assert.equal(g(wt, 'rev-parse', `${r.snapshot}^2`), p1.snapshot);
  const file = path.join(tmp, 'rebased.bundle');
  const b = await createBundle({ worktree: wt, base: 'origin/release/1.0', prev: p1.snapshot, snapshot: r.snapshot, file });
  assert.equal(b.ok, true);
  assert.ok(b.size < 10 * 1024, `증분 ${b.size}`);
});
