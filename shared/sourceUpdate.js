// 소스 폴더(git 클론)를 origin/main 으로 따라가는 git·npm 단계. 앱 업데이트와 서버 관리 프로그램이 같이 쓴다
import { execFile } from 'node:child_process';
import fs from 'node:fs';

const run = (cmd, args, cwd, timeout) => new Promise((resolve, reject) => {
  execFile(cmd, args, { cwd, timeout, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (err, stdout, stderr) => {
    if (err) return reject(Object.assign(new Error(String(stderr || err.message).trim().slice(0, 300)), { code: err.code }));
    resolve(String(stdout).trim());
  });
});
const git = (root, args, timeout = 30000) => run('git', ['-C', root, ...args], undefined, timeout);

/** root 가 git 최상위 폴더면 현재 HEAD(전체 해시), 아니면 null */
export async function sourceHead(root) {
  try {
    const top = await git(root, ['rev-parse', '--show-toplevel']);
    if (fs.realpathSync(top) !== fs.realpathSync(root)) return null;
    return await git(root, ['rev-parse', 'HEAD']);
  } catch { return null; }
}

/** origin/main 을 받고 HEAD 보다 앞선 커밋 수·제목(최대 20개) */
export async function fetchBehind(root) {
  await git(root, ['fetch', 'origin', 'main'], 60000);
  const count = Number(await git(root, ['rev-list', '--count', 'HEAD..origin/main']));
  const subjects = count ? (await git(root, ['log', '--format=%s', '-n', '20', 'HEAD..origin/main'])).split('\n').filter(Boolean) : [];
  return { count, subjects };
}

/** 커밋 안 된 변경이 있나 */
export const isDirty = async (root) => (await git(root, ['status', '--porcelain'])) !== '';

/** pull --ff-only origin main. package-lock.json 이 바뀌었는지도 알려 준다 */
export async function pullFf(root) {
  const before = await git(root, ['rev-parse', 'HEAD']);
  await git(root, ['pull', '--ff-only', 'origin', 'main'], 120000);
  const after = await git(root, ['rev-parse', 'HEAD']);
  const lockChanged = before !== after && (await git(root, ['diff', '--name-only', before, after, '--', 'package-lock.json'])) !== '';
  return { before, after, lockChanged };
}

/** 루트에서 npm install(10분 제한) */
export const npmInstall = (root) => run('npm', ['install'], root, 10 * 60 * 1000);
