// 공유 사본을 서버의 코드 상태에 맞추고(실행 전·알림), 실행 뒤 바뀐 것만 조각으로 올린다.
// 설계: docs/2026-11-27-shared-copy-design.md 3.2·3.3. git 동작은 codeState.js, 서버 통신은 serverClient 의 http 가 맡는다
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { git, ensureWorktree, fetchBranch } from './worktree.js';
import { snapshot, createBundle, applyParts, mergeLocal, rebaseOnto } from './codeState.js';

// 조각이 이만큼 쌓이면 다음 올리기는 증분 없이 통째로 묶어 체인을 새로 시작한다
const PARTS_LIMIT = 100;

const roomRef = (roomId, repoId) => `refs/rooms/${roomId}/${repoId}`;

/**
 * 원본 레포에 이름표 refs/rooms/<방>/<레포> 를 서버 스냅샷으로 둔다(없으면 지운다).
 * 스냅샷의 둘째 부모가 이전 스냅샷으로 이어져 있어 gc 로 사라지지 않게 하는 역할도 한다. 원본의 작업 폴더·브랜치는 건드리지 않는다
 */
export async function updateRoomRef({ sourcePath, roomId, repoId, snapshot: snap }) {
  try {
    await git(['-C', sourcePath, 'update-ref', ...(snap ? [roomRef(roomId, repoId), snap] : ['-d', roomRef(roomId, repoId)])]);
  } catch { /* 이름표는 보조 수단이라 실패해도 맞추기·올리기를 막지 않는다 */ }
}

// origin/<base> 가 앞서 있으면 사본의 커밋·수정을 그 위로 옮긴다. 충돌이면 false(사본은 그대로)
async function followBase(wt, base) {
  const tip = await git(['-C', wt, 'rev-parse', `origin/${base}`]);
  const mb = await git(['-C', wt, 'merge-base', 'HEAD', tip]).catch(() => ''); // 공통 조상이 없으면 건드리지 않는다
  if (!mb || mb === tip) return true;
  return (await rebaseOnto({ worktree: wt, base: mb, newBase: tip })).ok;
}

// 직접 고친 것이 없는 사본을 origin/<base> 로 깨끗이 맞춘다
async function resetToBase(wt, base) {
  await git(['-C', wt, 'reset', '-q', '--hard']);
  await git(['-C', wt, 'clean', '-fdq']); // -x 없음: .gitignore 된 파일은 건드리지 않는다
  await git(['-C', wt, 'checkout', '-q', '--detach', `origin/${base}`]);
}

/**
 * 레포 사본(worktree)을 서버의 코드 상태에 맞춘다. 사본이 없으면 origin/<기준> 에서 만든다
 * background: 알림 때 맞추기 — 직접 고친 사본이면 합치지 않고 'local_changes' 로 알리기만 하고, 기준 브랜치 따라가기(rebase)도 하지 않는다
 * @param {{http: {listCodeParts: Function, downloadCodePart: Function}, roomId: number,
 *   repo: {id: number, baseBranch: string, code: {snapshot: string}|null}, sourcePath: string, worktree: string,
 *   lastApplied?: string|null, tmpDir: string, background?: boolean}} p
 * @returns {Promise<{snapshot: string|null, status: 'ok'|'local_changes'|'conflict', merged?: true}>}
 *   snapshot: 이 맥 사본이 지금 맞춰진 서버 스냅샷(서버가 비어 있으면 null). conflict·local_changes(알림)는 바뀌지 않은 값
 * @throws BAD_BRANCH | BRANCH_NOT_ON_REMOTE | FETCH_FAILED | WORKTREE_FAILED | CODE_SYNC_FAILED
 */
export async function syncRepoCode({ http, roomId, repo, sourcePath, worktree, lastApplied = null, tmpDir, background = false }) {
  const base = repo.baseBranch;
  const { created } = await ensureWorktree({ sourcePath, worktreePath: worktree, branch: base });
  const last = created ? null : lastApplied; // 새로 만든 사본은 맞춰 둔 상태가 없다
  fs.mkdirSync(tmpDir, { recursive: true });
  const files = new Map(); // seq → 받은 파일
  const download = async (list) => {
    for (const p of list) {
      if (files.has(p.seq)) continue;
      const f = path.join(tmpDir, `part-${repo.id}-${p.seq}.bundle`);
      await http.downloadCodePart(roomId, repo.id, p.seq, f);
      files.set(p.seq, f);
    }
    return list.map((p) => files.get(p.seq));
  };

  // 서버 조각들로 맞춘다
  async function fromParts(parts) {
    const target = parts.at(-1).snapshot;
    const at = parts.findIndex((p) => p.snapshot === last);
    const todo = parts.slice(at + 1); // 마지막으로 맞춘 조각 다음부터(없으면 전부)
    const attempt = async (list) => {
      const r = await applyParts({ worktree, files: await download(list), snapshot: target, lastApplied: last });
      if (r.applied) return { snapshot: target, status: 'ok' };
      if (r.reason === 'MISSING_BASE') return null;
      if (background) return { snapshot: last, status: 'local_changes' };
      const m = await mergeLocal({ worktree, remoteSnapshot: target, files: await download(list), lastApplied: last });
      if (m.ok) return { snapshot: target, status: 'ok', merged: true };
      return m.reason === 'CONFLICT' ? { snapshot: last, status: 'conflict' } : null;
    };
    let r = await attempt(todo);
    if (!r) { await fetchBranch(sourcePath, base).catch(() => {}); r = await attempt(todo); } // 기준 브랜치가 앞서 있어 조각의 기준 커밋이 아직 없을 수 있다
    if (!r && todo.length < parts.length) r = await attempt(parts);
    if (!r) throw new Error('CODE_SYNC_FAILED');
    return r;
  }

  try {
    let result = { snapshot: null, status: 'ok' };
    const stale = !!repo.code && repo.code.snapshot !== last;
    const parts = stale ? await http.listCodeParts(roomId, repo.id) : [];
    if (parts.length) {
      result = parts.at(-1).snapshot === last ? { snapshot: last, status: 'ok' } : await fromParts(parts);
    } else if (repo.code && !stale) {
      result = { snapshot: last, status: 'ok' }; // 이미 맞다
    } else if (last) {
      // 서버가 비웠다(기준 변경·승격): 직접 고친 게 없으면 새 기준으로 깨끗이, 있으면 그대로 둔다
      if ((await snapshot({ worktree, prev: last })).same) await resetToBase(worktree, base);
      else result = { snapshot: null, status: 'local_changes' };
    }
    if (!background && result.status === 'ok' && !await followBase(worktree, base)) result = { snapshot: result.snapshot, status: 'conflict' };
    await updateRoomRef({ sourcePath, roomId, repoId: repo.id, snapshot: result.snapshot });
    return result;
  } finally {
    for (const f of files.values()) fs.rmSync(f, { force: true });
  }
}

/**
 * 실행 뒤 사본에서 바뀐 것만 묶어 올린다. 올린 entry 는 RUN_FINISH 의 codeStates 에 그대로 싣는다
 * base 는 origin/<repo.baseBranch>(승격이면 호출부가 baseBranch 를 작업 브랜치로 바꿔 넘긴다). 사본이 base 와 같아졌으면 비우기 entry
 * @param {{http: {uploadBundle: Function}, roomId: number, requestId: number, repo: {id: number, baseBranch: string},
 *   worktree: string, prev?: string|null, parts?: number, tmpDir: string}} p
 *   prev: 서버에 있는 지금 스냅샷(이 맥이 맞춘 것), parts: 서버 조각 수
 * @returns {Promise<{entry: object} | {skipped: 'same'|'empty'} | {tooBig: true}>}
 */
export async function uploadRepoCode({ http, roomId, requestId, repo, worktree, prev = null, parts = 0, tmpDir }) {
  const baseSha = await git(['-C', worktree, 'rev-parse', `origin/${repo.baseBranch}^{commit}`]);
  let s = await snapshot({ worktree, base: baseSha, prev });
  if (s.same) return { skipped: 'same' };
  if (s.empty) return prev ? { entry: { repoId: repo.id, baseBranch: repo.baseBranch, snapshot: null, uploadId: null } } : { skipped: 'empty' };
  let use = prev;
  if (prev && parts >= PARTS_LIMIT) { // 조각이 너무 쌓였다 → 통째로 묶어 체인을 새로 시작
    use = null;
    s = await snapshot({ worktree, base: baseSha, prev: null });
  }
  fs.mkdirSync(tmpDir, { recursive: true });
  const file = path.join(tmpDir, `up-${repo.id}-${crypto.randomBytes(4).toString('hex')}.bundle`);
  try {
    const r = await createBundle({ worktree, base: baseSha, prev: use, snapshot: s.snapshot, file });
    if (!r.ok) throw new Error('CODE_UPLOAD_FAILED');
    if (r.empty) return { skipped: 'empty' };
    let up;
    try {
      up = await http.uploadBundle(roomId, requestId, file);
    } catch (e) {
      if (e.message === 'BUNDLE_TOO_BIG') return { tooBig: true };
      throw e;
    }
    return { entry: { repoId: repo.id, baseBranch: repo.baseBranch, baseCommit: baseSha, snapshot: s.snapshot, prevSnapshot: use ?? null, uploadId: up.uploadId } };
  } finally {
    fs.rmSync(file, { force: true });
  }
}
