// claude 가 내보내는 rate_limit_event 에서 5시간·주간 사용률을 뽑아 합친다(이 PC 에만 저장)

const KEY = { five_hour: 'fiveHour', seven_day: 'sevenDay' };

// resetsAt 은 초 단위로 오므로 ms 로 맞춘다. utilization 은 0~1
const win = (w) => (w && typeof w.utilization === 'number'
  ? { utilization: w.utilization, resetsAt: w.resetsAt < 1e12 ? w.resetsAt * 1000 : w.resetsAt, status: String(w.status ?? '') }
  : null);

/**
 * @param {object|undefined} prev 지금까지의 usage
 * @param {object} ev rate_limit_event 이벤트
 * @param {number} now
 * @returns {{fiveHour?: object, sevenDay?: object, updatedAt: number}|undefined} 읽을 값이 없으면 undefined
 */
export function mergeUsage(prev, ev, now) {
  const info = ev?.rate_limit_info;
  if (!info || typeof info !== 'object') return undefined;
  const found = {};
  for (const [k, w] of Object.entries(info.unifiedWindows ?? {})) if (KEY[k] && win(w)) found[KEY[k]] = win(w);
  if (KEY[info.rateLimitType] && win(info)) found[KEY[info.rateLimitType]] ??= win(info);
  if (!Object.keys(found).length) return undefined;
  return { ...prev, ...found, updatedAt: now };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// "Nov 27 at 10:59am", "Nov 29 at 11pm" → 이 PC 시간대의 ms. 지난 날짜면 내년으로 본다
function parseReset(s, now) {
  const m = /([A-Z][a-z]{2}) (\d{1,2}) at (\d{1,2})(?::(\d{2}))?\s*(am|pm)/i.exec(s);
  if (!m || !MONTHS.includes(m[1])) return null;
  const hour = (Number(m[3]) % 12) + (m[5].toLowerCase() === 'pm' ? 12 : 0);
  const at = (y) => new Date(y, MONTHS.indexOf(m[1]), Number(m[2]), hour, Number(m[4] ?? 0)).getTime();
  const y = new Date(now).getFullYear();
  return at(y) < now - 86400000 ? at(y + 1) : at(y);
}

/**
 * `claude -p /usage` 출력 글에서 5시간(Current session)·주간(Current week (all models)) 사용률을 뽑는다
 * @returns {{fiveHour?: object, sevenDay?: object}|undefined}
 */
export function parseUsageText(text, now) {
  const out = {};
  for (const [key, label] of [['fiveHour', 'Current session'], ['sevenDay', 'Current week (all models)']]) {
    const line = String(text ?? '').split('\n').find((l) => l.trim().startsWith(label));
    const pct = line && /(\d+(?:\.\d+)?)%\s*used/.exec(line);
    if (pct) out[key] = { utilization: Number(pct[1]) / 100, resetsAt: parseReset(line, now), status: '' };
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * 모델을 부르지 않는 로컬 명령 `/usage` 로 사용량을 읽는다(사용량이 들지 않음). 훅·세션 저장 없이, API 키 환경 변수는 빼고 실행
 * @returns {Promise<{fiveHour?: object, sevenDay?: object}|undefined>}
 */
export async function fetchUsage({ claudeBin = process.env.CLAUDE_BIN || 'claude', now = Date.now(), run } = {}) {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  const exec = run ?? (async (bin, args, opts) => {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    return promisify(execFile)(bin, args, opts);
  });
  const os = await import('node:os');
  const { stdout } = await exec(claudeBin,
    ['-p', '/usage', '--output-format', 'json', '--no-session-persistence', '--setting-sources', 'local'],
    { cwd: os.tmpdir(), env, timeout: 30000 });
  return parseUsageText(JSON.parse(stdout).result, now);
}
