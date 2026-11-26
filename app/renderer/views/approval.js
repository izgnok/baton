// Claude 가 허락을 구할 때 뜨는 시트
import { h } from '../dom.js';
import { openSheet } from './sheet.js';

const MAX = 2000;

/** 도구 입력에서 사람이 먼저 볼 한 줄 */
const headline = (input) => input?.file_path ?? input?.command ?? null;

/** 입력 전체 JSON(2000자까지) */
export function inputJson(input) {
  let s;
  try { s = JSON.stringify(input, null, 2) ?? ''; } catch { s = String(input); }
  return s.length > MAX ? `${s.slice(0, MAX)}\n… (${s.length - MAX}자 더 있음)` : s;
}

/**
 * @param {{id: string, toolName: string, input: any}} p
 * @param {(decision: 'allow'|'deny') => Promise<void>} answer
 * @returns {{close: () => void, setSubtitle: (t: string) => void}}
 */
export function openApprovalSheet(p, roomName, answer, onClose) {
  const line = headline(p.input);
  const body = h('div', {},
    h('p', { class: 'tool-name' }, p.toolName),
    line ? h('p', { class: 'summary-line' }, String(line)) : null,
    h('pre', { class: 'json-pre' }, inputJson(p.input)));
  return openSheet({
    title: 'Claude 가 허락을 구해요',
    subtitle: roomName,
    body,
    dismissable: false,
    onClose,
    actions: [
      { label: '거부', kind: 'secondary', onClick: () => answer('deny') },
      { label: '허용', kind: 'primary', onClick: () => answer('allow') },
    ],
  });
}
