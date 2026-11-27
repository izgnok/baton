import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const NAMES = [
  '01-login', '02-rooms', '03-room-chat', '03b-room-code', '03c-room-people', '08-approval',
  '04-room-repos', '05-shared-md', '06-shared-html', '07-members', '09-autocomplete', '09b-autocomplete-mention', '10-update',
  '02-rooms-dark', '03-room-chat-dark', '03b-room-code-dark', '03c-room-people-dark', '08-approval-dark',
  '04-room-repos-dark', '07-members-dark', '09-autocomplete-dark',
];

test('capture: 21개 장면이 정해진 순서로 오고 capture:done ok:true', { timeout: 90000 }, async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'rooms-capture-test-'));
  const env = { ...process.env, ROOMS_SCREENSHOT: out, ROOMS_NO_BACKGROUND: '1' };
  delete env.ROOMS_HOME;
  const child = spawn(process.execPath, ['main/core.js'], { cwd: appDir, env });
  const scenes = [];
  let done = null;
  let buf = '';
  child.stderr.on('data', () => {});
  const finished = new Promise((resolve) => {
    child.stdout.on('data', (d) => {
      buf += d.toString();
      const parts = buf.split('\n');
      buf = parts.pop();
      for (const l of parts) {
        let m;
        try { m = JSON.parse(l); } catch { continue; }
        if (m.event === 'capture:shot') {
          scenes.push(m.payload);
          child.stdin.write(`${JSON.stringify({ id: scenes.length, call: 'captureAck', args: { name: m.payload.name } })}\n`);
        } else if (m.event === 'capture:done') { done = m.payload; resolve(); }
      }
    });
    child.on('exit', resolve);
  });
  try {
    await finished;
  } finally {
    child.stdin.end();
    setTimeout(() => child.kill(), 3000).unref();
    fs.rmSync(out, { recursive: true, force: true });
  }
  assert.deepEqual(scenes.map((s) => s.name), NAMES);
  for (const s of scenes) {
    assert.deepEqual(Object.keys(s).sort(), ['dark', 'name', 'opts', 'ui', 'view']);
    assert.equal(s.dark, s.name.endsWith('-dark'));
  }
  assert.deepEqual(done, { ok: true });
});
