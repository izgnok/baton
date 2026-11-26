import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRemote } from '@rooms/shared/remote.js';

test('normalizeRemote: 같은 저장소의 여러 표기는 같은 값', () => {
  for (const u of [
    'git@bitbucket.org:example-team/payment-api.git',
    'https://bitbucket.org/example-team/payment-api',
    'https://gjh@bitbucket.org/example-team/payment-api.git/',
    'ssh://git@bitbucket.org:22/example-team/payment-api.git',
    '  http://bitbucket.org/example-team/payment-api.git  ',
  ]) assert.equal(normalizeRemote(u), 'bitbucket.org/example-team/payment-api', u);
});

test('normalizeRemote: 호스트만 소문자, 경로는 유지', () => {
  assert.equal(normalizeRemote('https://BitBucket.org/A/B'), 'bitbucket.org/A/B');
});
