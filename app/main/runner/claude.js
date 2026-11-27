import { spawn } from 'node:child_process';
import readline from 'node:readline';

const API_KEY_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];
const LIMIT = /usage limit|hit your limit|limit reached/i;

/**
 * claude -p 를 실행하고 stream-json 이벤트를 onEvent 로 넘긴다
 * @param {{cwd: string, prompt: string, sessionId?: string, addDirs?: string[], systemPrompt?: string,
 *   mcpConfigPath?: string, permissionMode?: string, model?: string, effort?: string, env?: Record<string, string>, allowedTools?: string[],
 *   onEvent?: (e: object) => void,
 *   claudeBin?: string, signal?: AbortSignal}} opts
 * @returns {Promise<{sessionId: string|null, result: string, permissionDenials: unknown[]}>}
 */
export function runClaude({
  cwd, prompt, sessionId, addDirs = [], systemPrompt, mcpConfigPath, permissionMode, model, effort, env = {}, allowedTools = [],
  onEvent = () => {}, claudeBin = process.env.CLAUDE_BIN || 'claude', signal,
}) {
  // --forward-subagent-text: 서브에이전트의 글·도구 사용을 parent_tool_use_id 와 함께 받는다
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--forward-subagent-text'];
  if (sessionId) args.push('--resume', sessionId);
  for (const d of addDirs) args.push('--add-dir', d);
  if (systemPrompt) args.push('--append-system-prompt', systemPrompt);
  if (mcpConfigPath) args.push('--mcp-config', mcpConfigPath, '--permission-prompt-tool', 'mcp__rooms__approve');
  if (permissionMode) args.push('--permission-mode', permissionMode);
  if (model) args.push('--model', model);
  if (effort) args.push('--effort', effort);
  if (allowedTools.length) args.push('--allowedTools', ...allowedTools);

  return new Promise((resolve, reject) => {
    let seenSession = null;
    let resultLine = null;
    let stderr = '';
    let settled = false;
    const done = (fn, v) => { if (!settled) { settled = true; fn(v); } };
    const failWith = (code) => {
      const err = new Error(code);
      err.sessionId = seenSession;
      err.stderr = stderr.slice(-2000);
      return err;
    };

    // 프롬프트는 stdin 으로 쓰고 바로 닫는다
    // API 키가 있으면 구독 대신 API 요금이 나가므로 빼고 실행한다
    const childEnv = { ...process.env, ...env };
    for (const k of API_KEY_VARS) delete childEnv[k];
    const child = spawn(claudeBin, args, { cwd, env: childEnv, signal });
    child.on('error', (e) => done(reject, failWith(e.name === 'AbortError' ? 'CLAUDE_KILLED' : 'CLAUDE_NOT_FOUND')));
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });

    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      let ev;
      try { ev = JSON.parse(line); } catch { return; }
      if (!ev || typeof ev !== 'object') return;
      if (!seenSession && ev.session_id) seenSession = ev.session_id;
      if (ev.type === 'result') resultLine = ev;
      try { onEvent(ev); } catch (e) { console.error('onEvent 실패', e); } // 전달 실패가 실행을 멈추지 않게
    });

    child.on('close', (code, sig) => {
      const failed = code !== 0 || resultLine?.is_error;
      if (failed && LIMIT.test(`${resultLine?.result ?? ''}\n${stderr}`)) return done(reject, failWith('USAGE_LIMIT'));
      if (sig) return done(reject, failWith('CLAUDE_KILLED'));
      if (code !== 0) return done(reject, failWith(`CLAUDE_EXIT_${code}`));
      if (!resultLine) return done(reject, failWith('NO_RESULT'));
      if (resultLine.is_error) return done(reject, failWith('CLAUDE_ERROR'));
      done(resolve, {
        sessionId: seenSession, result: resultLine.result, permissionDenials: resultLine.permission_denials ?? [],
      });
    });
  });
}
