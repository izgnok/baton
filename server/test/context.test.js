import test from 'node:test';
import assert from 'node:assert/strict';
import { contextFromTranscript } from '../src/context.js';

const line = (o) => JSON.stringify(o);
const assistant = (usage, model = 'claude-opus-5-5') => line({ type: 'assistant', message: { model, usage, content: [] } });

test('contextFromTranscript: 마지막 답의 input·cache·output 합과 모델', () => {
  const text = [
    line({ type: 'user', message: { content: '하나' } }),
    assistant({ input_tokens: 10, output_tokens: 5 }),
    line({ type: 'user', message: { content: '둘' } }),
    assistant({ input_tokens: 2, cache_creation_input_tokens: 1000, cache_read_input_tokens: 143497, output_tokens: 356 }, 'claude-sonnet-5-5'),
    line({ type: 'user', message: { content: [{ type: 'tool_result' }] } }),
    '',
  ].join('\n');
  assert.deepEqual(contextFromTranscript(text), { tokens: 144855, model: 'claude-sonnet-5-5' });
});

test('contextFromTranscript: 비었거나 답이 없거나 압축 뒤 답이 없으면 null, 깨진 줄은 건너뜀', () => {
  assert.equal(contextFromTranscript(null), null);
  assert.equal(contextFromTranscript(''), null);
  assert.equal(contextFromTranscript(line({ type: 'user', message: { content: 'x' } })), null);
  const compacted = [assistant({ input_tokens: 500000 }), line({ type: 'system', subtype: 'compact_boundary' })].join('\n');
  assert.equal(contextFromTranscript(compacted), null);
  const afterCompact = [compacted, assistant({ input_tokens: 9000 })].join('\n');
  assert.deepEqual(contextFromTranscript(afterCompact), { tokens: 9000, model: 'claude-opus-5-5' });
  assert.deepEqual(contextFromTranscript(`${assistant({ input_tokens: 7 })}\n{broken`), { tokens: 7, model: 'claude-opus-5-5' });
});
