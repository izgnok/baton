import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeUpdate } from '../main/claudeAuth.js';

// 가짜 claude: --version 은 버전 파일 내용, update 는 버전 파일을 바꾼다
function fake(dir, { before = '2.1.265 (Claude Code)', after = '2.1.300 (Claude Code)', fail = false } = {}) {
  const ver = path.join(dir, 'ver');
  fs.writeFileSync(ver, before);
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(bin, `#!/bin/sh
if [ "$1" = "--version" ]; then cat "${ver}"; exit 0; fi
if [ "$1" = "update" ]; then ${fail ? 'echo nope >&2; exit 1' : `printf '%s' '${after}' > "${ver}"; echo updated`}; fi
`);
  fs.chmodSync(bin, 0o755);
  return bin;
}

test('claudeUpdate: 버전이 바뀌면 before·after 와 updated true', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rooms-cu-'));
  process.env.CLAUDE_BIN = fake(dir);
  try {
    assert.deepEqual(await claudeUpdate(), { ok: true, updated: true, before: '2.1.265', after: '2.1.300' });
  } finally { delete process.env.CLAUDE_BIN; }
});

test('claudeUpdate: 이미 최신이면 updated false, 실패해도 던지지 않는다', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rooms-cu-'));
  process.env.CLAUDE_BIN = fake(dir, { after: '2.1.265 (Claude Code)' });
  try {
    assert.deepEqual(await claudeUpdate(), { ok: true, updated: false, before: '2.1.265', after: '2.1.265' });
    process.env.CLAUDE_BIN = fake(fs.mkdtempSync(path.join(os.tmpdir(), 'rooms-cu-')), { fail: true });
    assert.equal((await claudeUpdate()).ok, false);
    process.env.CLAUDE_BIN = path.join(dir, 'nope');
    assert.equal((await claudeUpdate()).ok, false);
  } finally { delete process.env.CLAUDE_BIN; }
});
