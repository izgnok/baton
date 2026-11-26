// 요소 만들기 도우미. 글은 항상 텍스트 노드로 넣는다(HTML 로 해석되지 않는다)
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export const button = (label, kind, onclick, props = {}) =>
  h('button', { type: 'button', class: `btn btn-${kind}`, onclick, ...props }, label);
