import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { normalizeRemote } from '@baton/shared/remote.js';
import { batonHome } from '../localConfig.js';

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
 * 내 원본 레포 한 개 점검. 폴더·원격 주소만 본다(브랜치·변경은 방 작업 폴더가 맡는다)
 * @param {{localPath?: string, remoteUrl: string}} repo
 * @returns {Promise<{ok: boolean, block?: 'MISSING'|'REMOTE_MISMATCH', currentBranch?: string}>}
 */
export async function checkRepo({ localPath, remoteUrl }) {
  if (!localPath || !fs.existsSync(localPath) || !(await isGitRoot(localPath))) return { ok: false, block: 'MISSING' };

  let origin = null;
  try { origin = await git(['-C', localPath, 'remote', 'get-url', 'origin']); } catch { /* origin 없음 */ }
  if (origin === null || normalizeRemote(origin) !== normalizeRemote(remoteUrl)) return { ok: false, block: 'REMOTE_MISMATCH' };

  const currentBranch = await git(['-C', localPath, 'branch', '--show-current']).catch(() => '');
  return { ok: true, currentBranch };
}

/**
 * 고른 폴더의 레포 정보(최상위 폴더 기준). git 레포가 아니면 NOT_A_REPO
 * @returns {Promise<{localPath: string, name: string, remoteUrl: string, branch: string}>}
 */
export async function inspectRepo(dir) {
  let top;
  try { top = await git(['-C', dir, 'rev-parse', '--show-toplevel']); } catch { throw new Error('NOT_A_REPO'); }
  const remoteUrl = await git(['-C', top, 'remote', 'get-url', 'origin']).catch(() => '');
  const branch = await git(['-C', top, 'branch', '--show-current']).catch(() => '');
  return { localPath: top, name: path.basename(top), remoteUrl, branch };
}

/** 디렉터리 이름으로 쓸 수 있게 바꾼다 */
export function safeDirName(name) {
  const s = String(name ?? '').replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '');
  return s || 'repo';
}

/** 기본 위치에 지정 브랜치로 clone 하고 경로를 돌려준다 */
export async function cloneRepo({ remoteUrl, branch, name }) {
  const dest = path.join(batonHome(), 'repos', safeDirName(name));
  if (fs.existsSync(dest) && fs.readdirSync(dest).length > 0) throw new Error('DEST_EXISTS');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  // `--` 뒤에 두어 '-' 로 시작하는 주소가 git 옵션으로 읽히지 않게 한다
  await git(['clone', '--branch', branch, '--', remoteUrl, dest], 5 * 60 * 1000);
  return dest;
}

/**
 * 방 레포 전체 점검(병렬). 하나라도 block 이면 ok=false
 * @param {{id: number, name: string, remoteUrl: string}[]} repos
 * @param {Record<string, string>} roomRepoPaths repoId → 로컬 경로
 */
export async function preflight(repos, roomRepoPaths = {}) {
  const results = await Promise.all(repos.map(async (r) => {
    const localPath = roomRepoPaths[r.id];
    const res = await checkRepo({ localPath, remoteUrl: r.remoteUrl });
    return { repoId: r.id, name: r.name, localPath: localPath ?? null, ...res };
  }));
  return { ok: results.every((r) => !r.block), results };
}
