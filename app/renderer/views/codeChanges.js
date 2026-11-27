// Claude 실행 뒤 방 작업 폴더의 바뀐 코드 카드(rooms_code_changes)
import { h } from '../dom.js';

const lineClass = (l) => {
  if (l.startsWith('+++') || l.startsWith('---') || l.startsWith('diff ') || l.startsWith('index ')) return 'meta';
  if (l.startsWith('@@')) return 'hunk';
  if (l.startsWith('+')) return 'add';
  if (l.startsWith('-')) return 'del';
  return '';
};

// diff 는 줄마다 span(글자로 넣는다)
function diffPre(diff) {
  const pre = h('pre', { class: 'code-diff' });
  const lines = diff.split('\n');
  if (lines.at(-1) === '') lines.pop();
  pre.append(...lines.map((l) => h('span', { class: lineClass(l) }, l)));
  return pre;
}

/**
 * @param {{repoId: number, name: string, files: {status: string, path: string}[], diff: string, truncated: boolean, ahead: number}} r
 * @param {Set<string>} open 펼친 diff 키(다시 그려도 유지)
 * @param {string} key
 */
export function codeCard(r, open, key) {
  const head = `커밋 전 변경 · ${r.name} · 파일 ${r.files.length}개${r.ahead > 0 ? ` · 올리지 않은 커밋 ${r.ahead}개` : ''}`;
  const card = h('div', { class: 'code-card' },
    h('div', { class: 'head' }, head),
    r.files.length ? h('ul', { class: 'code-files' }, r.files.map((f) => h('li', {}, h('span', { class: 'fs' }, f.status === '??' ? '?' : f.status), h('span', {}, f.path)))) : null);
  if (r.diff) {
    const box = h('details', { class: 'code-diff-box', open: open.has(key) }, h('summary', {}, 'diff 보기'));
    const fill = () => { if (box.open && box.children.length === 1) box.append(...[diffPre(r.diff), r.truncated ? h('div', { class: 'sub' }, '앞부분만 보여요') : null].filter(Boolean)); };
    box.addEventListener('toggle', () => { if (box.open) { open.add(key); fill(); } else open.delete(key); });
    fill();
    card.append(box);
  }
  return card;
}
