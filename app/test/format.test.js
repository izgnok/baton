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
