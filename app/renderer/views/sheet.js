// 아래에서 올라오는 시트 공용. 입력 시트·확인 시트도 여기서 만든다
import { h, button } from '../dom.js';
import { errorText } from '../format.js';

const open = new Set(); // 지금 떠 있는 시트 {close, persist}

/** 화면을 옮길 때 승인 시트를 뺀 나머지 시트를 닫는다 */
export function closeTransientSheets() {
  for (const s of [...open]) if (!s.persist) s.close();
}

/**
 * @param {{title: string, subtitle?: string, body?: Node, wide?: boolean, dismissable?: boolean,
 *   actions?: {label: string, kind?: 'primary'|'secondary'|'danger', onClick?: () => any}[], onClose?: () => void}} opts
 * 버튼 onClick 이 false 를 돌려주면 시트를 닫지 않는다
 */
export function openSheet({ title, subtitle, body, wide = false, dismissable = true, actions = [], onClose }) {
  let closed = false;
  const entry = { close: () => close(), persist: !dismissable };
  const onKey = (e) => { if (e.key === 'Escape' && dismissable) close(); };
  function close() {
    if (closed) return;
    closed = true;
    open.delete(entry);
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
    onClose?.();
  }
  const subtitleEl = h('p', { class: 'sub' }, subtitle ?? '');
  const btns = actions.map((a) => {
    const b = button(a.label, a.kind ?? 'secondary', async () => {
      b.disabled = true;
      let keep = false;
      try { keep = (await a.onClick?.()) === false; } finally { b.disabled = false; }
      if (!keep) close();
    });
    return b;
  });
  const backdrop = h('div', {
    class: 'sheet-backdrop',
    onmousedown: (e) => { if (e.target === backdrop && dismissable) close(); },
  },
  h('div', { class: `sheet${wide ? ' wide' : ''}`, role: 'dialog' },
    h('div', { class: 'sheet-head' }, h('h2', { class: 'title' }, title), subtitleEl),
    h('div', { class: 'sheet-body' }, body),
    btns.length ? h('div', { class: 'sheet-actions' }, btns) : null));
  document.getElementById('sheet-root').append(backdrop);
  document.addEventListener('keydown', onKey);
  open.add(entry);
  return { close, setSubtitle: (t) => { subtitleEl.textContent = t; }, el: backdrop };
}

/**
 * 입력 시트. 모든 칸이 채워져야 하고, onSubmit 이 던지면 시트 안에 오류를 보여 준다
 * @param {{title: string, fields: {name: string, label: string, value?: string, placeholder?: string}[],
 *   submitLabel: string, onSubmit: (values: Record<string, string>) => Promise<void>, errors?: Record<string, string>}} opts
 */
export function inputSheet({ title, fields, submitLabel, onSubmit, errors = {} }) {
  const inputs = fields.map((f) => h('input', { class: 'input', value: f.value ?? '', placeholder: f.placeholder ?? '', autocomplete: 'off' }));
  const err = h('p', { class: 'error-text' });
  const values = () => Object.fromEntries(fields.map((f, i) => [f.name, inputs[i].value.trim()]));
  async function submit() {
    const v = values();
    if (Object.values(v).some((x) => !x)) { err.textContent = '빈칸을 채워 주세요'; return false; }
    try { await onSubmit(v); } catch (e) { err.textContent = errors[e.message] ?? errorText(e.message); return false; }
  }
  const body = h('div', {}, fields.map((f, i) => h('label', { class: 'field' }, h('span', { class: 'label' }, f.label), inputs[i])), err);
  inputs.forEach((i) => i.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); sheet.el.querySelector('.btn-primary').click(); }
  }));
  const sheet = openSheet({
    title, body,
    actions: [{ label: '취소', kind: 'secondary' }, { label: submitLabel, kind: 'primary', onClick: submit }],
  });
  inputs[0]?.focus();
  return sheet;
}

/** 확인 시트 → 확인하면 true, 닫으면 false */
export function confirmSheet({ title, message, confirmLabel, danger = false }) {
  return new Promise((resolve) => {
    let answer = false;
    openSheet({
      title, body: h('p', { class: 'sub' }, message),
      onClose: () => resolve(answer),
      actions: [
        { label: '취소', kind: 'secondary' },
        { label: confirmLabel, kind: danger ? 'danger' : 'primary', onClick: () => { answer = true; } },
      ],
    });
  });
}
