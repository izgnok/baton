import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import { assertBranch } from './worktree.js';

const run = promisify(execFile);

const MAX_OUT = 200 * 1024;
const READ_ONLY = new Set(['show', 'grep', 'ls-tree', 'log', 'diff', 'rev-parse']);
// 파일 쓰기·명령 실행·설정 바꾸기·저장소 밖 읽기로 이어지는 옵션. 긴 옵션은 줄여 쓴 형태(--out)도 막는다
const BLOCKED_LONG = ['output', 'exec', 'upload-pack', 'receive-pack', 'config', 'git-dir', 'work-tree',
  'ext-diff', 'textconv', 'no-index', 'open-files-in-pager'];
const BLOCKED_SHORT = ['-c', '-O'];

function blockedArg(a) {
  if (BLOCKED_SHORT.some((p) => a.startsWith(p))) return true;
  // 짧은 옵션 묶음(-nOvim 등) 안의 -O 도 막는다(지정한 프로그램으로 파일을 여는 옵션)
  if (a.startsWith('-') && !a.startsWith('--') && a.slice(1).includes('O')) return true;
  if (!a.startsWith('--')) return false;
  const name = a.slice(2).split('=')[0];
  return !!name && BLOCKED_LONG.some((l) => l.startsWith(name));
}

/** 허용 저장소 목록: JSON 배열 문자열이거나 그 JSON 을 담은 파일 경로 */
export function loadAllowedRepos(spec) {
  if (!spec) return [];
  try {
    const list = JSON.parse(spec.trim().startsWith('[') ? spec : fs.readFileSync(spec, 'utf8'));
    return Array.isArray(list) ? list.filter((p) => typeof p === 'string') : [];
  } catch { return []; }
}

const real = (p) => { try { return fs.realpathSync(p); } catch { return null; } };

/**
 * 읽기 전용 git 명령 실행. 거부하면 사유 문구로 throw 한다
 * @param {{repo: unknown, args: unknown, allowed: string[]}} p
 * @returns {Promise<string>} stdout 앞 200KB
 */
export async function gitRead({ repo, args, allowed }) {
  if (typeof repo !== 'string' || !Array.isArray(args) || !args.length || !args.every((a) => typeof a === 'string')) {
    throw new Error('repo(문자열)와 args(문자열 배열)가 필요합니다');
  }
  const top = real(repo);
  if (!top || !allowed.map(real).includes(top)) throw new Error('허용되지 않은 저장소입니다');
  const bad = args.find(blockedArg);
  if (bad !== undefined) throw new Error(`허용되지 않는 옵션입니다: ${bad}`);

  const [sub, ...rest] = args;
  let gitArgs;
  if (sub === 'fetch') {
    // 형식은 정확히 `fetch origin <브랜치>`. origin/<브랜치> 로 읽을 수 있게 그 참조를 갱신한다
    if (rest.length !== 2 || rest[0] !== 'origin') throw new Error('fetch 는 `fetch origin <브랜치>` 형식만 허용됩니다');
    try { await assertBranch(rest[1]); } catch { throw new Error('브랜치 이름이 올바르지 않습니다'); }
    gitArgs = ['fetch', 'origin', `+refs/heads/${rest[1]}:refs/remotes/origin/${rest[1]}`];
  } else if (sub === 'branch') {
    const list = rest.includes('--list');
    if (!rest.some((a) => ['-r', '-a', '--list'].includes(a))
      || !rest.every((a) => ['-r', '-a', '--list'].includes(a) || (list && !a.startsWith('-')))) {
      throw new Error('branch 는 -r, -a, --list(와 패턴)만 허용됩니다');
    }
    gitArgs = args;
  } else if (sub === 'cat-file') {
    if (rest.length !== 2 || !['-p', '-t', '-s'].includes(rest[0]) || rest[1].startsWith('-')) {
      throw new Error('cat-file 은 `cat-file -p|-t|-s <객체>` 형식만 허용됩니다');
    }
    gitArgs = args;
  } else if (READ_ONLY.has(sub)) {
    gitArgs = ['show', 'log', 'diff'].includes(sub) ? [sub, '--no-ext-diff', '--no-textconv', ...rest] : args;
  } else {
    throw new Error(`허용되지 않는 git 명령입니다: ${sub}`);
  }

  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat' };
  delete env.GIT_EXTERNAL_DIFF;
  try {
    const r = await run('git', ['--no-pager', '-C', top, ...gitArgs], {
      timeout: 60000, env, encoding: 'buffer', maxBuffer: 8 * 1024 * 1024,
    });
    return r.stdout.subarray(0, MAX_OUT).toString('utf8');
  } catch (e) {
    if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return e.stdout.subarray(0, MAX_OUT).toString('utf8');
    const err = String(e.stderr ?? '').trim();
    if (e.code === 1 && !err) return ''; // grep 은 결과가 없으면 1 로 끝난다
    throw new Error(err || e.message);
  }
}
