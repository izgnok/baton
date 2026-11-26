import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompt } from '../main/runner/prompt.js';

test('채팅이 있으면 [방 대화] 와 [요청] 을 붙인다', () => {
  const out = buildPrompt({
    chatsSince: [{ name: 'A', body: '이 API 응답 구조 어때?' }, { name: 'B', body: '페이징은 빼도 될 듯\n두 번째 줄' }],
    requesterName: 'A',
    body: '페이징 빼고 구현해줘',
  });
  assert.equal(out, '[방 대화]\nA: 이 API 응답 구조 어때?\nB: 페이징은 빼도 될 듯\n두 번째 줄\n\n[요청 - A]\n페이징 빼고 구현해줘');
});

test('채팅이 없으면 요청만', () => {
  assert.equal(buildPrompt({ chatsSince: [], requesterName: 'A', body: '해줘' }), '[요청 - A]\n해줘');
  assert.equal(buildPrompt({ requesterName: 'A', body: '해줘' }), '[요청 - A]\n해줘');
});
