// 5시간·주간 사용량 막대
import { h } from '../dom.js';
import { usageLabel, usageWarn, usageChecked } from '../format.js';

/**
 * @param {{fiveHour?: object, sevenDay?: object, updatedAt?: number}|null|undefined} usage
 * @param {{compact?: boolean}} [o] compact 는 방 머리줄용(마지막 확인 시각 생략)
 */
export function usageBars(usage, { compact = false } = {}) {
  const rows = [['fiveHour', usage?.fiveHour], ['sevenDay', usage?.sevenDay]].filter(([, w]) => w);
  if (!rows.length) return h('div', { class: 'usage-empty' }, '아직 실행 기록이 없어요');
  return h('div', { class: `usage${compact ? ' compact' : ''}` },
    rows.map(([kind, w]) => h('div', { class: 'usage-row' },
      h('div', { class: 'usage-text' }, usageLabel(kind, w)),
      h('div', { class: 'usage-bar' }, h('div', { class: `usage-fill${usageWarn(w) ? ' warn' : ''}`, style: `width:${Math.min(100, Math.round(w.utilization * 100))}%` })))),
    usage.updatedAt ? h('div', { class: 'usage-checked' }, usageChecked(usage.updatedAt)) : null);
}
