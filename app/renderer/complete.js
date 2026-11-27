// 입력창 자동완성의 순수 계산(DOM 에 의존하지 않는다)

/**
 * 캐럿 앞 글자로 자동완성 종류를 정한다. 글 맨 앞의 / 는 명령·스킬, 단어 시작의 @ 는 멘션
 * @returns {{kind: 'slash'|'mention', query: string, start: number}|null} start 는 / 또는 @ 의 위치
 */
export function detectTrigger(value, caret) {
  const before = value.slice(0, caret);
  const slash = /^(\s*)\/(\S*)$/.exec(before);
  if (slash) return { kind: 'slash', query: slash[2], start: slash[1].length };
  const at = /(?:^|\s)@([^\s@]*)$/.exec(before);
  if (at) return { kind: 'mention', query: at[1], start: before.length - at[1].length - 1 };
  return null;
}

/** 고른 항목을 넣은 새 글과 캐럿. 바로 뒤가 공백이 아니면 공백 하나를 붙인다 */
export function applyChoice(value, caret, trigger, insert) {
  const tail = value.slice(caret);
  const gap = /^\s/.test(tail) ? '' : ' ';
  return { value: value.slice(0, trigger.start) + insert + gap + tail, caret: trigger.start + insert.length + 1 };
}

const norm = (s) => String(s).toLowerCase();

/** 이름이 query 로 시작하는 것 먼저, 이름·설명에 들어 있는 것 다음 */
export function rankByQuery(items, query, nameOf = (x) => x.name, descOf = (x) => x.description ?? '') {
  const q = norm(query);
  if (!q) return items.slice();
  const starts = [];
  const has = [];
  for (const it of items) {
    const n = norm(nameOf(it));
    if (n.startsWith(q)) starts.push(it);
    else if (n.includes(q) || norm(descOf(it)).includes(q)) has.push(it);
  }
  return [...starts, ...has];
}

/** 그룹별 상한을 두고 이어 붙인다: 멤버 3, 공유 파일 3, 나머지는 레포 파일, 합쳐서 max */
export function mergeMentionItems({ members = [], shared = [], repoFiles = [] }, max = 8) {
  const m = members.slice(0, 3);
  const s = shared.slice(0, 3);
  return [...m, ...s, ...repoFiles.slice(0, Math.max(0, max - m.length - s.length))].slice(0, max);
}

export const BASE_COMMANDS = [{ name: 'compact', description: '대화 압축', source: 'base' }];
