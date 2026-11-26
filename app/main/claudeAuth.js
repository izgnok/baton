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
