// 입력창 위 자동완성 팝업: 맨 앞 / 는 명령·스킬, 단어 시작의 @ 는 멤버·공유 파일·레포 파일
import { h } from '../dom.js';
import { detectTrigger, applyChoice, rankByQuery, mergeMentionItems, BASE_COMMANDS } from '../complete.js';

const SOURCE_TEXT = { base: '기본', user: '개인', plugin: '플러그인', project: '프로젝트', member: '멤버', shared: '공유', repo: '레포' };
const MAX = 8;

/**
 * @param {{input: HTMLTextAreaElement, host: HTMLElement,
 *   getMembers: () => string[], getShared: () => Promise<{path: string}[]>,
 *   getSkills: () => Promise<{name: string, description: string, source: string}[]>,
 *   searchRepoFiles: (query: string) => Promise<{name: string, path: string, mention: string}[]>,
 *   debounceMs?: number}} o
 * @returns {{close: () => void, isOpen: () => boolean}}
 */
export function attachAutocomplete({ input, host, getMembers, getShared, getSkills, searchRepoFiles, debounceMs = 200 }) {
  let items = []; // {insert, name, desc, source}
  let sel = 0;
  let trigger = null;
  let seq = 0;
  let timer = 0;
  const pop = h('div', { class: 'ac-pop', hidden: true, role: 'listbox' });
  host.append(pop);

  const close = () => { pop.hidden = true; items = []; trigger = null; seq++; clearTimeout(timer); };

  function render() {
    pop.replaceChildren(...items.map((it, i) => h('button', {
      type: 'button', role: 'option', class: `ac-item${i === sel ? ' on' : ''}`,
      onmousedown: (e) => { e.preventDefault(); choose(i); }, // 입력창 포커스를 잃지 않게
    }, h('span', { class: 'ac-name' }, it.name), h('span', { class: 'ac-desc' }, it.desc ?? ''), h('span', { class: 'ac-src' }, SOURCE_TEXT[it.source] ?? it.source))));
    pop.hidden = !items.length;
    pop.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
  }

  function choose(i) {
    const it = items[i];
    if (!it || !trigger) return;
    const r = applyChoice(input.value, input.selectionStart, trigger, it.insert);
    input.value = r.value;
    input.setSelectionRange(r.caret, r.caret);
    input.dispatchEvent(new Event('input')); // 높이 맞춤 등 다른 반응도 따라가게
    close();
  }

  async function update() {
    const t = detectTrigger(input.value, input.selectionStart);
    if (!t) return close();
    trigger = t;
    const mine = ++seq;
    const show = (list) => { if (mine === seq) { items = list; sel = Math.min(sel, Math.max(0, list.length - 1)); render(); } };
    sel = 0;
    if (t.kind === 'slash') {
      const skills = (await getSkills().catch(() => [])).map((s) => ({ ...s }));
      const all = rankByQuery([...BASE_COMMANDS, ...skills], t.query);
      return show(all.slice(0, MAX).map((c) => ({ insert: `/${c.name}`, name: `/${c.name}`, desc: c.description, source: c.source })));
    }
    // 멘션: 멤버·공유 파일은 바로, 레포 파일은 입력을 멈춘 뒤 찾는다
    const members = rankByQuery(getMembers(), t.query, (n) => n, () => '').map((n) => ({ insert: `@${n}`, name: n, desc: '', source: 'member' }));
    const shared = rankByQuery(await getShared().catch(() => []), t.query, (f) => f.path, () => '')
      .map((f) => ({ insert: `@shared/${f.path}`, name: `shared/${f.path}`, desc: '', source: 'shared' }));
    if (mine !== seq) return;
    show(mergeMentionItems({ members, shared }, MAX));
    if (!t.query) return;
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const files = (await searchRepoFiles(t.query).catch(() => []))
        .map((f) => ({ insert: `@${f.mention}`, name: f.path, desc: f.name, source: 'repo' }));
      show(mergeMentionItems({ members, shared, repoFiles: files }, MAX));
    }, debounceMs);
  }

  input.addEventListener('input', update);
  input.addEventListener('click', update);
  input.addEventListener('blur', () => setTimeout(close, 100));
  input.addEventListener('keydown', (e) => {
    if (pop.hidden || e.isComposing) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      sel = (sel + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
      render();
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      e.stopImmediatePropagation(); // 보내기보다 먼저 선택으로 처리
      choose(sel);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  });

  return { close, isOpen: () => !pop.hidden };
}
