import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { safeJoin } from '@baton/shared/paths.js';

const base = path.resolve('/tmp/base');
const bad = { message: 'BAD_PATH' };

test('safeJoin: 벗어나는 경로는 BAD_PATH', () => {
  for (const rel of ['../x', '/etc/x', 'a/../../x', 'a/../b', 'C:\\x', '\\\\x', 'a\\b', '', 'a\0b', '..', null, 5]) {
    assert.throws(() => safeJoin(base, rel), bad, String(rel));
  }
});

test('safeJoin: 정상 경로는 base 안', () => {
  assert.equal(safeJoin(base, 'memory/메모.md'), path.join(base, 'memory', '메모.md'));
  assert.equal(safeJoin(base, 'a..b/c.md'), path.join(base, 'a..b', 'c.md'));
});
