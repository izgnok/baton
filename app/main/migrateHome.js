import fs from 'node:fs';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * 옛 앱(ClaudeRooms) 프로세스가 떠 있는지. 자기 부모 프로세스는 뺀다 —
 * 아직 이름이 ClaudeRooms 인 앱이 이 코어를 띄웠다면 그건 "옛 앱"이 아니라 지금 앱이다.
 * @param {{exec?: () => string, ppid?: number}} [p] 테스트용 주입
 */
export function isOldAppRunning({ exec = () => execFileSync('pgrep', ['-x', 'ClaudeRooms'], { encoding: 'utf8' }), ppid = process.ppid } = {}) {
  let out;
  try { out = exec(); } catch { return false; } // pgrep 은 하나도 없으면 비정상 종료한다
  return out.split('\n').map((s) => s.trim()).filter(Boolean).some((pid) => Number(pid) !== ppid);
}

// 새 폴더의 항목을 옛 폴더로 옮긴다. 같은 이름이 있으면 로그는 뒤에 이어 붙이고 나머지는 옛 것을 남긴다. 끝나면 새 폴더를 지운다
function mergeStub(stub, into) {
  for (const name of fs.readdirSync(stub)) {
    const from = path.join(stub, name);
    const to = path.join(into, name);
    if (!fs.existsSync(to)) fs.renameSync(from, to);
    else if (name.endsWith('.log') && fs.statSync(from).isFile()) fs.appendFileSync(to, fs.readFileSync(from));
  }
  fs.rmSync(stub, { recursive: true, force: true });
}

/**
 * 옛 데이터 폴더를 새 폴더로 옮기고, 방 작업 폴더(git worktree)의 원본 쪽 등록 경로를 고친다.
 * 실패해도 던지지 않고 결과로 알린다. rename 이 실패하면 아무것도 바꾸지 않는다.
 * @returns {Promise<{moved: boolean, reason?: 'HOME_SET'|'NO_OLD'|'BOTH_EXIST'|'OLD_RUNNING'|'FAILED', repaired: number}>}
 */
export async function migrateHome({ home, oldHome, env = process.env, isOldAppRunning: oldRunning = isOldAppRunning }) {
  const no = (reason) => ({ moved: false, reason, repaired: 0 });
  if (env.BATON_HOME) return no('HOME_SET');
  if (!fs.existsSync(oldHome)) return no('NO_OLD');
  if (oldRunning()) return no('OLD_RUNNING');
  if (fs.existsSync(home)) {
    // 설정 없이 로그만 있는 새 폴더(앱이 먼저 로그를 써서 생겼거나 지난번 이전이 미뤄진 사이 생김)는 옛 폴더로 합치고 옮긴다
    if (fs.existsSync(path.join(home, 'config.json')) || !fs.existsSync(path.join(oldHome, 'config.json'))) return no('BOTH_EXIST');
    try { mergeStub(home, oldHome); } catch { return no('FAILED'); }
  }
  try { fs.renameSync(oldHome, home); } catch { return no('FAILED'); }

  let repaired = 0;
  for (const room of fs.readdirSync(home, { withFileTypes: true })) {
    const reposDir = path.join(home, room.name, 'repos');
    if (!room.isDirectory() || !fs.existsSync(reposDir)) continue;
    for (const repo of fs.readdirSync(reposDir, { withFileTypes: true })) {
      const dir = path.join(reposDir, repo.name);
      if (!repo.isDirectory() || !fs.statSync(path.join(dir, '.git'), { throwIfNoEntry: false })?.isFile()) continue;
      // 원본 레포가 없어졌으면 실패하지만 이전은 이미 끝났다
      if (await run('git', ['-C', dir, 'worktree', 'repair']).then(() => true, () => false)) repaired++;
    }
  }
  return { moved: true, repaired };
}
