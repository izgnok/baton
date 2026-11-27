import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { roomsHome } from '../localConfig.js';
import { safeDirName } from './preflight.js';

const run = promisify(execFile);

// 실패하면 stderr 를 error.message 에 담아 던진다(호출부가 거절·충돌을 구분하는 데 쓴다). raw 는 앞뒤 공백을 그대로 둔다
async function git(args, timeout = 15000, { raw = false, maxBuffer } = {}) {
  try {
    const r = await run('git', args, { timeout, maxBuffer, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    return raw ? r.stdout : r.stdout.trim();
  } catch (e) {
    const err = new Error(`${e.stderr || e.message}`.trim());
    err.code = e.code;
    err.stdout = e.stdout;
    throw err;
  }
}

const NET = 60000;
const UNMERGED = /^(DD|AU|UD|UA|DU|AA|UU) /m;

/** 방 전용 작업 폴더 경로 */
export const worktreePath = (roomId, repo) =>
  path.join(roomsHome(), String(roomId), 'repos', `${repo.id}-${safeDirName(repo.name)}`);

export const isProtectedBranch = (branch) => /^(main|master|develop|production)$|^(release|hotfix)\//.test(branch ?? '');

// 남이 준 값이 git 옵션·특수 표기로 읽히지 않게 한다
export async function assertBranch(branch) {
  if (typeof branch !== 'string' || !branch || branch.startsWith('-')) throw new Error('BAD_BRANCH');
  try { await git(['check-ref-format', `refs/heads/${branch}`]); } catch { throw new Error('BAD_BRANCH'); }
}

const fetchBranch = (cwd, branch) =>
  git(['-C', cwd, 'fetch', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`], NET);

async function isWorktree(dir) {
  if (!fs.existsSync(dir)) return false;
  try {
    const top = await git(['-C', dir, 'rev-parse', '--show-toplevel']);
    return fs.realpathSync(top) === fs.realpathSync(dir);
  } catch { return false; }
}

/**
 * 방 작업 폴더를 원격 방 브랜치에 맞춘다(없으면 만든다). 항상 detached HEAD
 * @returns {Promise<{head: string}>}
 * @throws BAD_BRANCH | BRANCH_NOT_ON_REMOTE | FETCH_FAILED | SYNC_CONFLICT | WORKTREE_FAILED
 */
export async function syncWorktree({ sourcePath, worktreePath: wt, branch }) {
  await assertBranch(branch);
  try {
    await fetchBranch(sourcePath, branch);
  } catch {
    const heads = await git(['-C', sourcePath, 'ls-remote', '--heads', 'origin', `refs/heads/${branch}`]).catch(() => null);
    throw new Error(heads === '' ? 'BRANCH_NOT_ON_REMOTE' : 'FETCH_FAILED');
  }
  const target = `origin/${branch}`;

  if (!await isWorktree(wt)) {
    try {
      fs.mkdirSync(path.dirname(wt), { recursive: true });
      await git(['-C', sourcePath, 'worktree', 'prune']); // 폴더만 지워진 옛 등록 정리
      await git(['-C', sourcePath, 'worktree', 'add', '--detach', wt, target]);
    } catch { throw new Error('WORKTREE_FAILED'); }
    return { head: await git(['-C', wt, 'rev-parse', '--short', 'HEAD']) };
  }

  const oldHead = await git(['-C', wt, 'rev-parse', 'HEAD']);
  const stashBefore = await git(['-C', wt, 'rev-parse', '-q', '--verify', 'refs/stash']).catch(() => '');
  try {
    await git(['-C', wt, 'rebase', '--autostash', target]);
    // autostash 를 되돌려 얹다 충돌하면 rebase 는 성공으로 끝나고 충돌 표시만 남는다 → 원래 상태로 되돌린다
    if (UNMERGED.test(await git(['-C', wt, 'status', '--porcelain']))) {
      await git(['-C', wt, 'reset', '--hard', oldHead]);
      const stashNow = await git(['-C', wt, 'rev-parse', '-q', '--verify', 'refs/stash']).catch(() => '');
      if (stashNow !== stashBefore) await git(['-C', wt, 'stash', 'pop']);
      throw new Error('SYNC_CONFLICT');
    }
  } catch (e) {
    if (e.message === 'SYNC_CONFLICT') throw e;
    await git(['-C', wt, 'rebase', '--abort']).catch(() => {}); // 진행 중이 아니면 실패해도 무시
    throw new Error('SYNC_CONFLICT');
  }
  return { head: await git(['-C', wt, 'rev-parse', '--short', 'HEAD']) };
}

const DIFF_LIMIT = 60 * 1024;

/**
 * 작업 폴더의 바뀐 파일·diff(앞 60KB)·방 브랜치보다 앞선 커밋 수. 추적 안 된 파일은 files 에만 나온다
 * @returns {Promise<{files: {status: string, path: string}[], diff: string, truncated: boolean, ahead: number}>}
 */
export async function pendingChanges({ worktreePath: wt, branch }) {
  await assertBranch(branch);
  const entries = (await git(['-C', wt, 'status', '--porcelain', '-z', '-uall'], 15000, { raw: true })).split('\0').filter(Boolean);
  const files = [];
  for (let i = 0; i < entries.length; i++) {
    const status = entries[i].slice(0, 2).trim();
    files.push({ status, path: entries[i].slice(3) });
    if (/^[RC]/.test(entries[i])) i++; // 이름 바꾸기·복사는 다음 항목이 원래 경로
  }
  let diff;
  try {
    diff = await git(['-C', wt, 'diff', '--no-ext-diff', 'HEAD'], 30000, { raw: true, maxBuffer: 50 * 1024 * 1024 });
  } catch (e) {
    if (e.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw e;
    diff = e.stdout; // 너무 크면 받은 앞부분만 쓴다
  }
  const bytes = Buffer.from(diff);
  const truncated = bytes.length > DIFF_LIMIT;
  if (truncated) diff = bytes.subarray(0, DIFF_LIMIT).toString('utf8').replace(/\uFFFD$/, '');
  const ahead = Number(await git(['-C', wt, 'rev-list', '--count', `origin/${branch}..HEAD`]).catch(() => '0'));
  return { files, diff, truncated, ahead };
}

/**
 * 방 작업 폴더들의 추적 파일 중 query 가 들어간 것(대소문자 무시, 최대 50개)
 * @returns {Promise<{repoId: number, name: string, path: string, mention: string}[]>}
 */
export async function listRepoFiles({ roomId, repos, query }) {
  const q = String(query ?? '').toLowerCase();
  const out = [];
  for (const repo of repos) {
    const wt = worktreePath(roomId, repo);
    if (!fs.existsSync(wt)) continue;
    let list;
    try { list = (await git(['-C', wt, 'ls-files', '-z'], 15000, { raw: true, maxBuffer: 64 * 1024 * 1024 })).split('\0'); } catch { continue; }
    for (const p of list) {
      if (!p || !p.toLowerCase().includes(q)) continue;
      out.push({ repoId: repo.id, name: repo.name, path: p, mention: `repos/${path.basename(wt)}/${p}` });
      if (out.length >= 50) return out;
    }
  }
  return out;
}

/**
 * 안 올린 변경이 없으면 작업 폴더를 지운다. branch 를 모르면 어느 원격 브랜치에도 없는 커밋으로 대신 검사한다
 * @returns {Promise<{removed: boolean, reason?: 'DIRTY'|'UNPUSHED'}>}
 */
export async function removeWorktree({ sourcePath, worktreePath: wt, branch }) {
  if (!fs.existsSync(wt)) {
    await git(['-C', sourcePath, 'worktree', 'prune']).catch(() => {});
    return { removed: true };
  }
  if (await git(['-C', wt, 'status', '--porcelain'])) return { removed: false, reason: 'DIRTY' };
  const range = branch ? [`origin/${branch}..HEAD`] : ['HEAD', '--not', '--remotes'];
  // 확인할 수 없으면(참조 없음 등) 지우지 않는 쪽으로
  const ahead = Number(await git(['-C', wt, 'rev-list', '--count', ...range]).catch(() => '1'));
  if (ahead > 0) return { removed: false, reason: 'UNPUSHED' };
  await git(['-C', sourcePath, 'worktree', 'remove', wt]);
  return { removed: true };
}
