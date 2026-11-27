import test from 'node:test';
import assert from 'node:assert/strict';
import { MSG, parseClaudeMention } from '@baton/shared/protocol.js';

test('parseClaudeMention', () => {
  const cases = [
    ['  @Claude 안녕', { isClaude: true, body: '안녕' }],
    ['@claude', { isClaude: true, body: '' }],
    ['@claude   ', { isClaude: true, body: '' }],
    ['이메일 a@claude.com', { isClaude: false, body: '이메일 a@claude.com' }],
    ['@claudex 안녕', { isClaude: false, body: '@claudex 안녕' }],
    ['안녕 @claude', { isClaude: false, body: '안녕 @claude' }],
    ['/compact', { isClaude: true, body: '/compact' }],
    ['  /my-skill 인자 하나', { isClaude: true, body: '/my-skill 인자 하나' }],
    ['/', { isClaude: true, body: '' }],
    ['안녕 /compact', { isClaude: false, body: '안녕 /compact' }],
  ];
  for (const [text, want] of cases) assert.deepEqual(parseClaudeMention(text), want, text);
});

test('MSG 는 동결되어 있고 값이 맞다', () => {
  assert.ok(Object.isFrozen(MSG));
  assert.equal(MSG.RUN_HEARTBEAT, 'run.heartbeat');
  assert.equal(MSG.REQUEST_RETRY, 'request.retry');
});
