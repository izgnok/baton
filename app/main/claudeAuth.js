import { execFile, spawn } from 'node:child_process';

const bin = () => process.env.CLAUDE_BIN || 'claude';

/**
 * `claude auth status` 결과
 * @returns {Promise<{loggedIn: boolean, email?: string, orgName?: string, subscriptionType?: string, error?: string}>}
 */
export function claudeAuthStatus() {
  return new Promise((resolve) => {
    execFile(bin(), ['auth', 'status'], { timeout: 15000 }, (err, stdout) => {
      if (err?.code === 'ENOENT') return resolve({ loggedIn: false, error: 'CLAUDE_NOT_FOUND' });
      try {
        const j = JSON.parse(stdout);
        resolve({ loggedIn: !!j.loggedIn, email: j.email, orgName: j.orgName, subscriptionType: j.subscriptionType });
      } catch {
        resolve({ loggedIn: false, error: err ? 'CLAUDE_STATUS_FAILED' : 'CLAUDE_STATUS_UNPARSEABLE' });
      }
    });
  });
}

/** 공식 `claude auth login` 실행(브라우저 창). 끝날 때까지 기다린다 */
export function claudeLogin() {
  return new Promise((resolve, reject) => {
    const child = spawn(bin(), ['auth', 'login'], { stdio: 'ignore' });
    child.on('error', () => reject(new Error('CLAUDE_NOT_FOUND')));
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error('CLAUDE_LOGIN_FAILED'))));
  });
}

// `claude --version` 출력의 앞 버전 숫자. 못 읽으면 null
function claudeVersion() {
  return new Promise((resolve) => {
    execFile(bin(), ['--version'], { timeout: 15000 }, (err, stdout) => {
      resolve(err ? null : (/\d+\.\d+\.\d+/.exec(String(stdout)) ?? [null])[0]);
    });
  });
}

/**
 * `claude update` 로 Claude Code 를 최신으로(5분 제한). 실패해도 던지지 않는다
 * @returns {Promise<{ok: boolean, updated?: boolean, before?: string|null, after?: string|null, error?: string}>}
 */
export async function claudeUpdate() {
  const before = await claudeVersion();
  if (!before) return { ok: false, error: 'CLAUDE_NOT_FOUND' };
  const ok = await new Promise((resolve) => {
    execFile(bin(), ['update'], { timeout: 5 * 60 * 1000 }, (err) => resolve(!err));
  });
  if (!ok) return { ok: false, error: 'CLAUDE_UPDATE_FAILED', before };
  const after = await claudeVersion();
  return { ok: true, updated: !!after && after !== before, before, after };
}
