import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown, failText, errorText, formatDate } from '../renderer/format.js';

test('원문 HTML 은 글자로 이스케이프된다', () => {
  for (const src of ['<script>alert(1)</script>', 'a <img src=x onerror=alert(1)> b', '<div onclick="x()">hi</div>']) {
    const out = renderMarkdown(src);
    assert.ok(!/<(script|img|div)\b/i.test(out), out);
  }
});

test('링크는 http(s) 만 살린다', () => {
  assert.match(renderMarkdown('[a](https://x.com/p?a=1&b=2)'), /<a href="https:\/\/x\.com\/p\?a=1&amp;b=2"/);
  for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd']) {
    assert.ok(!/<a\b/i.test(renderMarkdown(`[a](${bad})`)), bad);
  }
});

test('이미지는 대체 글자만 남는다', () => {
  assert.ok(!/<img/i.test(renderMarkdown('![alt](https://x.com/a.png)')));
});

test('코드 블록은 이스케이프되고 줄바꿈이 유지된다', () => {
  assert.match(renderMarkdown('```js\nconst a = "<b>";\n```'), /&lt;b&gt;/);
  assert.match(renderMarkdown('가\n나'), /<br>/);
});

test('실패 사유 문구', () => {
  assert.equal(failText('PREFLIGHT:BRANCH_MISMATCH'), '레포 브랜치가 방 설정과 달라요');
  assert.equal(failText('CLAUDE_EXIT_2'), 'Claude 가 비정상 종료했어요(2)');
  assert.equal(failText('WHAT'), '실행에 실패했어요(WHAT)');
  assert.equal(errorText('EMAIL_TAKEN'), '이미 가입한 이메일이에요');
  assert.match(formatDate(0), /^\d{4}\.\d{2}\.\d{2}$/);
});

import { personIndex, initial, usageLabel, usageWarn, usageChecked, memberSummary, modelLabel, effortLabel, STATUS_TEXT } from '../renderer/format.js';
import { detectTrigger, applyChoice, rankByQuery, mergeMentionItems } from '../renderer/complete.js';

test('사람별 색 번호는 0~5, 같은 id 는 항상 같다', () => {
  for (const id of [1, 2, 7, 100, '12']) assert.ok(personIndex(id) >= 0 && personIndex(id) <= 5);
  assert.equal(personIndex(3), personIndex('3'));
  assert.notEqual(personIndex(1), personIndex(2));
  assert.equal(initial('  하은'), '하');
  assert.equal(initial('abc'), 'A');
  assert.equal(initial(''), '?');
});

test('사용량 문구: 5시간은 시각, 주간은 요일 + 시각, 지난 시각은 안내', () => {
  const at = (d, h, m) => new Date(2026, 10, d, h, m).getTime(); // 2026-11-26 은 목요일
  const now = at(26, 10, 0);
  assert.equal(usageLabel('fiveHour', { utilization: 0.21, resetsAt: at(26, 15, 0) }, now), '5시간 21% · 15:00 초기화');
  assert.equal(usageLabel('sevenDay', { utilization: 0.567, resetsAt: at(27, 14, 0) }, now), '주간 57% · 금 14:00 초기화');
  assert.equal(usageLabel('fiveHour', { utilization: 0.5, resetsAt: at(26, 9, 0) }, now), '5시간 50% · 초기화 시각이 지났어요');
  assert.equal(usageWarn({ utilization: 0.8 }), true);
  assert.equal(usageWarn({ utilization: 0.79 }), false);
  assert.equal(usageChecked(at(26, 9, 5), now), '마지막 확인 09:05');
  assert.equal(usageChecked(at(25, 9, 5), now), '마지막 확인 11.25 09:05');
});

test('멤버 연결 요약·모델 이름·중단됨 문구', () => {
  assert.equal(memberSummary({ repos: ['a', 'b'], readDirs: ['x'], claude: true }), '연결한 레포: a, b · 자기 맥에서 함께 읽는 폴더: x · Claude 로그인 ○');
  assert.equal(memberSummary({ repos: [], readDirs: [], claude: false }), '연결한 레포: 없음 · 자기 맥에서 함께 읽는 폴더: 없음 · Claude 로그인 ×');
  assert.equal(memberSummary(undefined), '아직 연결 정보가 없어요');
  assert.deepEqual([modelLabel('opus'), modelLabel('claude-x-1'), modelLabel('')], ['Opus(최신)', 'claude-x-1', '']);
  assert.deepEqual([modelLabel('claude-opus-5-5'), modelLabel('claude-fable-5-2'), modelLabel('claude-haiku-5-5-20261101')],
    ['Opus 5.5', 'Fable 5.2', 'Haiku 5.5']);
  assert.deepEqual([effortLabel('xhigh'), effortLabel('')], ['매우 높음', '']);
  assert.equal(STATUS_TEXT.cancelled, '중단됨');
  assert.equal(errorText('NOT_CANCELLABLE'), '이미 끝났거나 중단할 수 없는 요청이에요');
});

test('자동완성 트리거: 맨 앞 / 는 명령, 단어 시작의 @ 는 멘션, 그 밖은 없음', () => {
  assert.deepEqual(detectTrigger('/comp', 5), { kind: 'slash', query: 'comp', start: 0 });
  assert.deepEqual(detectTrigger('  /', 3), { kind: 'slash', query: '', start: 2 });
  assert.equal(detectTrigger('/compact 이어서', 15), null); // 공백 뒤는 인자
  assert.equal(detectTrigger('안녕 /compact', 9), null); // 맨 앞이 아니면 명령이 아니다
  assert.deepEqual(detectTrigger('@', 1), { kind: 'mention', query: '', start: 0 });
  assert.deepEqual(detectTrigger('이 파일 @src/pay', 13), { kind: 'mention', query: 'src/pay', start: 5 });
  assert.equal(detectTrigger('a@b.com', 7), null); // 단어 중간의 @
  assert.equal(detectTrigger('@하은 안녕', 6), null);
  assert.deepEqual(detectTrigger('@하은 안녕 @ti', 10), { kind: 'mention', query: 'ti', start: 7 });
});

test('자동완성 적용: 트리거 구간만 바꾸고 뒤 글은 유지, 캐럿은 삽입 뒤', () => {
  const v = '이 파일 @src/pay 를 봐줘';
  const t = detectTrigger(v, 13);
  const ins = '@repos/1-api/src/pay.js';
  assert.deepEqual(applyChoice(v, 13, t, ins), { value: `이 파일 ${ins} 를 봐줘`, caret: 5 + ins.length + 1 });
  assert.deepEqual(applyChoice('/co', 3, detectTrigger('/co', 3), '/compact'), { value: '/compact ', caret: 9 });
});

test('후보 정렬·상한: 이름 시작 우선, 설명 포함도 찾음, 합쳐서 8개', () => {
  const items = [{ name: 'bitbucket', description: 'PR' }, { name: 'compact', description: '대화 압축' }, { name: 'x-compact', description: '' }, { name: 'api-spec', description: '압축 문서' }];
  assert.deepEqual(rankByQuery(items, 'comp').map((x) => x.name), ['compact', 'x-compact']);
  assert.deepEqual(rankByQuery(items, '압축').map((x) => x.name), ['compact', 'api-spec']);
  assert.equal(rankByQuery(items, '').length, 4);
  const many = (n, p) => Array.from({ length: n }, (_, i) => `${p}${i}`);
  const merged = mergeMentionItems({ members: many(5, 'm'), shared: many(5, 's'), repoFiles: many(20, 'r') });
  assert.equal(merged.length, 8);
  assert.deepEqual(merged.slice(0, 6), ['m0', 'm1', 'm2', 's0', 's1', 's2']);
  assert.deepEqual(mergeMentionItems({ repoFiles: many(20, 'r') }).length, 8);
});
