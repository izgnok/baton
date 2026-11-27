// 공유 사본의 코드 상태(커밋 + 커밋 안 한 변경)를 묶어 다른 맥의 사본에 똑같이 맞추는 git 로직.
// 설계: docs/2026-11-27-shared-copy-design.md 2장·3.3·3.4. 서버·화면과 무관한 순수 git 헬퍼
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { assertBranch } from './worktree.js';

const run = promisify(execFile);
const NET = 60000;
const UNMERGED = /^(DD|AU|UD|UA|DU|AA|UU) /m;
// 사용자 git 설정(서명 등)에 흔들리지 않게 한다
const SAFE = ['-c', 'user.name=rooms', '-c', 'user.email=rooms@localhost', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false'];

// 실패하면 stderr 를 message 에, 종료 코드를 code 에 담아 던진다
async function git(wt, args, { env, timeout = 30000, raw = false } = {}) {
  try {
    const r = await run('git', [...SAFE, '-C', wt, ...args], {
      timeout, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ...env, GIT_TERMINAL_PROMPT: '0' },
    });
    return raw ? r.stdout : r.stdout.trim();
  } catch (e) {
    const err = new Error(`${e.stderr || e.message}`.trim());
    err.code = e.code;
    throw err;
  }
}

const rp = (wt, x) => git(wt, ['rev-parse', '--verify', '-q', x]);
const rpOr = (wt, x) => rp(wt, x).catch(() => '');
const stashTop = (wt) => rpOr(wt, 'refs/stash');

/**
 * 작업 폴더의 지금 모습(커밋 + 커밋 안 한 변경, 새 파일·삭제 포함, .gitignore 제외)의 트리.
 * 실제 인덱스 복사본에서 add -A → write-tree. 작업 폴더·실제 인덱스는 그대로
 */
async function stateTree(wt) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rooms-idx-'));
  const index = path.join(dir, 'index');
  try {
    const real = path.resolve(wt, await git(wt, ['rev-parse', '--git-path', 'index']));
    if (fs.existsSync(real)) { // 비어 있는 인덱스에서 시작해도 결과는 같다(복사는 속도용)
      fs.copyFileSync(real, index);
      // 수정 시각도 원본대로 둔다. 새 시각이면 git 이 "인덱스를 쓴 그 순간에 고친 같은 크기 파일"을 변경 없음으로 본다(racy git)
      const st = fs.statSync(real);
      fs.utimesSync(index, st.atime, st.mtime);
    }
    const env = { GIT_INDEX_FILE: index };
    await git(wt, ['add', '-A'], { env, timeout: NET });
    return await git(wt, ['write-tree'], { env });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * 지금 상태를 담은 커밋을 만든다. 첫째 부모 = 지금 HEAD, 둘째 부모 = prev(이전 스냅샷, 이 저장소에 있을 때만).
 * 둘째 부모 덕에 묶음에서 이전 스냅샷이 가진 내용이 빠진다. 작업 폴더·인덱스·HEAD 는 바꾸지 않는다
 * @returns {Promise<{snapshot: string, empty: boolean, same: boolean}>}
 *   empty: HEAD 가 base 이고 바뀐 것이 없음. same: prev 가 있고 prev 와 트리·첫째 부모가 같음(서버 상태에서 바뀐 것 없음)
 */
export async function snapshot({ worktree, base, prev }) {
  const tree = await stateTree(worktree);
  const head = await rp(worktree, 'HEAD');
  const prevSha = prev ? await rpOr(worktree, `${prev}^{commit}`) : '';
  const snap = await git(worktree, ['commit-tree', tree, '-p', head, ...(prevSha ? ['-p', prevSha] : []), '-m', 'rooms snapshot']);
  const baseSha = base ? await rpOr(worktree, `${base}^{commit}`) : head;
  const same = !!prevSha && await rp(worktree, `${prevSha}^{tree}`) === tree && await rpOr(worktree, `${prevSha}^1`) === head;
  return { snapshot: snap, empty: head === baseSha && tree === await rp(worktree, 'HEAD^{tree}'), same };
}

/**
 * (prev 가 있으면 prev 이후, 없으면 base 이후) 바뀐 것을 조각 묶음 파일로 만든다
 * @returns {Promise<{ok: true, size: number, empty?: true} | {ok: false, reason: 'NO_BASE'}>}
 *   empty: 담을 변경이 없어 파일을 만들지 않았다(prev 가 없을 때만 base 와 같은지 본다). NO_BASE: base 가 이 저장소에 없다
 */
export async function createBundle({ worktree, base, prev, snapshot: snap, file }) {
  const baseSha = await rpOr(worktree, `${base}^{commit}`);
  if (!baseSha) return { ok: false, reason: 'NO_BASE' };
  const prevSha = prev ? await rpOr(worktree, `${prev}^{commit}`) : '';
  if (prevSha ? snap === prevSha
    : await rp(worktree, `${snap}^1`) === baseSha && await rp(worktree, `${snap}^{tree}`) === await rp(worktree, `${baseSha}^{tree}`)) {
    return { ok: true, size: 0, empty: true };
  }
  // 스냅샷 커밋은 ref 가 없어 묶을 수 없다 → 임시 ref. ref 는 같은 원본을 쓰는 사본끼리 공유되므로 이름을 겹치지 않게 한다
  const ref = `refs/rooms/snap-${crypto.randomBytes(4).toString('hex')}`;
  const out = path.resolve(file);
  await git(worktree, ['update-ref', ref, snap]);
  try {
    await git(worktree, ['bundle', 'create', '--quiet', out, ref, ...(prevSha ? [`^${prevSha}`] : []), `^${baseSha}`], { timeout: 10 * 60000 });
  } finally {
    await git(worktree, ['update-ref', '-d', ref]).catch(() => {});
  }
  return { ok: true, size: fs.statSync(out).size };
}

/**
 * 조각 파일들을 차례로 받아 온다(앞 조각이 뒤 조각의 prerequisite). 마지막 조각에 sha 가 없으면 BAD_BUNDLE,
 * 받는 데 필요한 커밋이 이 저장소에 없으면 false
 */
async function fetchParts(wt, files, sha) {
  const abs = files.map((f) => path.resolve(f));
  const headsOf = async (f) => (await git(wt, ['bundle', 'list-heads', f])).split('\n').map((l) => l.split(' '));
  if (!(await headsOf(abs.at(-1))).some(([s]) => s === sha)) throw new Error('BAD_BUNDLE');
  for (const f of abs) {
    try {
      await git(wt, ['bundle', 'verify', f]);
    } catch (e) {
      if (/prerequisite/i.test(e.message)) return false;
      throw e;
    }
    await git(wt, ['fetch', '--quiet', '--no-tags', f, ...(await headsOf(f)).map(([, r]) => r)], { timeout: 10 * 60000 });
  }
  return true;
}

/** 사본을 (부모 커밋 = 커밋된 상태 + 스냅샷의 변경 = 커밋 안 한 상태)로 맞춘다. 지금 작업 폴더의 변경은 버린다 */
async function alignTo(wt, parent, snap) {
  await git(wt, ['reset', '-q', '--hard']);
  await git(wt, ['clean', '-fdq']); // -x 없음: .gitignore 된 파일은 건드리지 않는다
  await git(wt, ['checkout', '-q', '--detach', parent]);
  // 스냅샷에 없는 추적 파일은 지워지고(restore 는 겹치지 않게 덮는다), 새 파일은 추적 안 된 채로 생긴다. 인덱스는 HEAD 그대로
  await git(wt, ['restore', '-q', `--source=${snap}`, '--worktree', '--', '.']);
}

/** 직접 고친 것이 있는가: 마지막으로 맞춘 상태(없으면 HEAD 의 깨끗한 상태)와 지금 작업 폴더가 다르면 true */
async function locallyChanged(wt, lastApplied) {
  const tree = await stateTree(wt);
  if (!lastApplied) return tree !== await rp(wt, 'HEAD^{tree}');
  try {
    return tree !== await rp(wt, `${lastApplied}^{tree}`) || await rp(wt, 'HEAD') !== await rp(wt, `${lastApplied}^1`);
  } catch { return true; } // 마지막으로 맞춘 상태를 모르면 안전한 쪽으로
}

/**
 * 조각들(seq 순)을 차례로 받아 마지막 스냅샷 S 로 사본을 맞춘다(HEAD = S^1 detached, 작업 폴더 = S, 인덱스 = HEAD)
 * files 는 이 맥이 아직 못 받은 조각부터 주면 된다(앞 조각은 이미 저장소에 있어야 함)
 * U11: 직접 고친 것이 있으면 맞추지 않는다. MISSING_BASE: 조각이 기대는 커밋이 이 저장소에 없다(원격을 먼저 fetch, 빠진 조각)
 * @returns {Promise<{applied: true} | {applied: false, reason: 'LOCAL_CHANGES' | 'MISSING_BASE'}>}
 * @throws BAD_BUNDLE (마지막 조각에 snapshot 이 없음)
 */
export async function applyParts({ worktree, files, snapshot: snap, lastApplied }) {
  if (await locallyChanged(worktree, lastApplied)) return { applied: false, reason: 'LOCAL_CHANGES' };
  if (!await fetchParts(worktree, files, snap)) return { applied: false, reason: 'MISSING_BASE' };
  await alignTo(worktree, `${snap}^1`, snap);
  return { applied: true };
}

/**
 * 직접 고친 이 맥의 상태와 서버의 새 스냅샷을 lastApplied 기준으로 3-way 합쳐 사본을 맞춘다
 * 합친 결과는 "원격 스냅샷의 커밋된 상태 + 그 위의 커밋 안 한 변경"이 된다(이 맥에서 직접 커밋한 것도 커밋 안 한 변경으로 들어간다)
 * 충돌이면 아무것도 바꾸지 않는다
 * @returns {Promise<{ok: true, snapshot: string} | {ok: false, reason: 'CONFLICT' | 'MISSING_BASE'}>}
 */
export async function mergeLocal({ worktree, remoteSnapshot, files, lastApplied }) {
  if (!await fetchParts(worktree, files, remoteSnapshot)) return { ok: false, reason: 'MISSING_BASE' };
  const local = (await snapshot({ worktree })).snapshot;
  let tree;
  try {
    const baseCommit = lastApplied || await rp(worktree, 'HEAD');
    tree = (await git(worktree, ['merge-tree', '--write-tree', `--merge-base=${baseCommit}`, local, remoteSnapshot])).split('\n')[0];
  } catch (e) {
    if (e.code === 1) return { ok: false, reason: 'CONFLICT' };
    throw e;
  }
  const parent = await rp(worktree, `${remoteSnapshot}^1`);
  // 둘째 부모 = 원격 스냅샷: 다음 증분 묶음에서 원격 스냅샷의 내용이 빠진다
  const merged = await git(worktree, ['commit-tree', tree, '-p', parent, '-p', remoteSnapshot, '-m', 'rooms snapshot']);
  await alignTo(worktree, parent, merged);
  return { ok: true, snapshot: merged };
}

/**
 * 기준 브랜치가 앞서 갔을 때: base..HEAD 커밋을 newBase 위로 옮기고 커밋 안 한 변경도 다시 얹는다.
 * 충돌이면 원래 상태로 되돌린다(syncWorktree 와 같은 처리)
 * @returns {Promise<{ok: true, snapshot: string} | {ok: false, reason: 'CONFLICT'}>}
 */
export async function rebaseOnto({ worktree, base, newBase, prev }) {
  const [baseSha, newSha] = [await rp(worktree, `${base}^{commit}`), await rp(worktree, `${newBase}^{commit}`)];
  if (await git(worktree, ['symbolic-ref', '-q', 'HEAD']).catch(() => '')) await git(worktree, ['switch', '--detach']); // 브랜치를 다시 쓰지 않게
  const oldHead = await rp(worktree, 'HEAD');
  const stashBefore = await stashTop(worktree);
  try {
    await git(worktree, ['rebase', '--autostash', '--onto', newSha, baseSha], { timeout: NET });
    // autostash 를 되돌려 얹다 충돌하면 rebase 는 성공으로 끝나고 충돌 표시만 남는다
    if (UNMERGED.test(await git(worktree, ['status', '--porcelain']))) {
      await git(worktree, ['reset', '-q', '--hard', oldHead]);
      if (await stashTop(worktree) !== stashBefore) await git(worktree, ['stash', 'pop', '-q']);
      return { ok: false, reason: 'CONFLICT' };
    }
  } catch {
    await git(worktree, ['rebase', '--abort']).catch(() => {}); // 진행 중이 아니면 실패해도 무시
    return { ok: false, reason: 'CONFLICT' };
  }
  return { ok: true, snapshot: (await snapshot({ worktree, base: newSha, prev })).snapshot };
}

/** 원격(origin)에 브랜치가 있는가. 원격에 닿지 못하면 던진다(없다고 단정하지 않는다) */
export async function remoteHas({ worktree, branch }) {
  await assertBranch(branch);
  return await git(worktree, ['ls-remote', '--heads', 'origin', `refs/heads/${branch}`], { timeout: NET }) !== '';
}
