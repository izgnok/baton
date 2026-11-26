import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { normalizeRemote } from '@rooms/shared/remote.js';
import { roomsHome } from '../localConfig.js';

const run = promisify(execFile);

function git(args, timeout = 15000) {
  return run('git', args, { timeout, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
    .then((r) => r.stdout.trim());
}

const isGitRoot = async (localPath) => {
  try {
    const top = await git(['-C', localPath, 'rev-parse', '--show-toplevel']);
    return fs.realpathSync(top) === fs.realpathSync(localPath);
  } catch {
    return false;
  }
};

/**
 * 레포 한 개 점검. block 이 있으면 막고, warn 은 경고만
 * @param {{localPath?: string, remoteUrl: string, branch: string}} repo
 * @returns {Promise<{ok: boolean, block?: 'MISSING'|'REMOTE_MISMATCH'|'BRANCH_MISMATCH', warn: string[], currentBranch?: string}>}
 */
export async function checkRepo({ localPath, remoteUrl, branch }) {
  const blocked = (block, extra) => ({ ok: false, block, warn: [], ...extra });
  if (!localPath || !fs.existsSync(localPath) || !(await isGitRoot(localPath))) return blocked('MISSING');

  let origin = null;
  try { origin = await git(['-C', localPath, 'remote', 'get-url', 'origin']); } catch { /* origin 없음 */ }
  if (origin === null || normalizeRemote(origin) !== normalizeRemote(remoteUrl)) {
    return blocked('REMOTE_MISMATCH');
  }

  const currentBranch = await git(['-C', localPath, 'branch', '--show-current']).catch(() => '');
  if (currentBranch !== branch) return blocked('BRANCH_MISMATCH', { currentBranch });

  const warn = [];
  if (await git(['-C', localPath, 'status', '--porcelain']).catch(() => '')) warn.push('DIRTY');
  try {
    await git(['-C', localPath, 'fetch', 'origin', branch]);
    const behind = await git(['-C', localPath, 'rev-list', '--count', `HEAD..origin/${branch}`]);
    if (Number(behind) > 0) warn.push('BEHIND');
  } catch { /* 오프라인 등은 경고 없이 넘어간다 */ }
  return { ok: true, warn, currentBranch };
}

/** 디렉터리 이름으로 쓸 수 있게 바꾼다 */
export function safeDirName(name) {
  const s = String(name ?? '').replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '');
  return s || 'repo';
}

/** 기본 위치에 지정 브랜치로 clone 하고 경로를 돌려준다 */
export async function cloneRepo({ remoteUrl, branch, name }) {
  const dest = path.join(roomsHome(), 'repos', safeDirName(name));
  if (fs.existsSync(dest) && fs.readdirSync(dest).length > 0) throw new Error('DEST_EXISTS');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  // `--` 뒤에 두어 '-' 로 시작하는 주소가 git 옵션으로 읽히지 않게 한다
  await git(['clone', '--branch', branch, '--', remoteUrl, dest], 5 * 60 * 1000);
  return dest;
}

/**
 * 방 레포 전체 점검(병렬). 하나라도 block 이면 ok=false
 * @param {{id: number, name: string, remoteUrl: string, branch: string}[]} repos
 * @param {Record<string, string>} roomRepoPaths repoId → 로컬 경로
 */
export async function preflight(repos, roomRepoPaths = {}) {
  const results = await Promise.all(repos.map(async (r) => {
    const localPath = roomRepoPaths[r.id];
    const res = await checkRepo({ localPath, remoteUrl: r.remoteUrl, branch: r.branch });
    return { repoId: r.id, name: r.name, localPath: localPath ?? null, ...res };
  }));
  return { ok: results.every((r) => !r.block), results };
}
