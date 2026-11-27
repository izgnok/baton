import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { normalizeRemote } from '@rooms/shared/remote.js';

const run = promisify(execFile);

// 찾지 않는 폴더(점으로 시작하는 폴더는 따로 전부 건너뛴다)
const SKIP = new Set(['Library', 'node_modules', '.Trash', '.cache', '.npm', '.gradle', '.m2', '.cargo', '.rustup',
  '.pyenv', '.nvm', 'Applications', 'Pictures', 'Movies', 'Music']);

const remoteOf = (dir) => run('git', ['-C', dir, 'remote', 'get-url', 'origin'], { timeout: 10000 })
  .then((r) => r.stdout.trim(), () => '');

/**
 * 홈 아래 git 레포 찾기. 홈의 자식이 깊이 1, maxDepth 깊이까지 본다.
 * `.git`(폴더·파일)이 있으면 레포로 기록하고 그 아래로는 내려가지 않는다. 심볼릭 링크는 따라가지 않는다
 * @returns {Promise<{path: string, name: string, remoteUrl: string}[]>}
 */
export async function scanRepos({ home = os.homedir(), maxDepth = 5 } = {}) {
  const found = [];
  async function walk(dir, depth) {
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    if (depth > 0 && entries.some((e) => e.name === '.git')) return void found.push(dir);
    if (depth >= maxDepth) return;
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || SKIP.has(e.name)) continue;
      await walk(path.join(dir, e.name), depth + 1);
    }
  }
  await walk(home, 0);
  found.sort();
  const out = [];
  for (let i = 0; i < found.length; i += 10) { // 한 번에 10개씩 원격 주소를 읽는다
    out.push(...await Promise.all(found.slice(i, i + 10).map(async (p) => ({
      path: p, name: path.basename(p), remoteUrl: await remoteOf(p),
    }))));
  }
  return out;
}

/** 원격 주소가 같은 레포의 경로. index 는 목록이거나 {repos} */
export function matchRepo(index, remoteUrl) {
  const list = Array.isArray(index) ? index : index?.repos ?? [];
  const want = normalizeRemote(remoteUrl);
  if (!want) return null;
  return list.find((r) => r.remoteUrl && normalizeRemote(r.remoteUrl) === want)?.path ?? null;
}

/**
 * 레포 위쪽(홈 직전까지)에서 CLAUDE.md 나 .claude 폴더가 있는 폴더들. 가까운 것부터. 홈 자체는 뺀다
 * @returns {string[]}
 */
export function detectReadDirs(sourcePath, home = os.homedir()) {
  const root = path.resolve(home);
  const out = [];
  let dir = path.dirname(path.resolve(sourcePath));
  while (dir.startsWith(root + path.sep)) {
    const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
    const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
    if (isFile(path.join(dir, 'CLAUDE.md')) || isDir(path.join(dir, '.claude'))) out.push(dir);
    dir = path.dirname(dir);
  }
  return out;
}
