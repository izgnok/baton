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
