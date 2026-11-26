import { execFile } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';

/** Finder 로 띄운 앱의 PATH 에 로그인 셸의 PATH 를 반영한다. 실패하면 흔한 위치를 앞에 붙인다 */
export async function fixPath() {
  try {
    const { stdout } = await promisify(execFile)(process.env.SHELL || '/bin/zsh', ['-ilc', 'printf %s "$PATH"'], { timeout: 5000 });
    const last = stdout.trim().split('\n').pop();
    if (!last || !last.includes('/')) throw new Error('empty');
    process.env.PATH = last;
  } catch {
    const home = os.homedir();
    process.env.PATH = `${home}/.local/bin:/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? ''}`;
  }
}
