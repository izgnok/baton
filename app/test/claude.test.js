import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runClaude } from '../main/runner/claude.js';

const fx = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const FAKE = path.join(fx, 'fake-claude.mjs');
const SID = '11111111-2222-3333-4444-555555555555';
const lines = (name) => fs.readFileSync(path.join(fx, name), 'utf8').split('\n').filter(Boolean);

let tmp;
before(() => {
  fs.chmodSync(FAKE, 0o755);
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rooms-claude-'));
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// 가짜 claude 로 실행하고 이벤트·기록을 같이 돌려준다
async function run(stream, { env = {}, ...opts } = {}) {
  const record = path.join(tmp, `rec-${Math.random().toString(36).slice(2)}.json`);
  const set = { FAKE_STREAM: path.join(fx, stream), FAKE_RECORD: record, ...env };
  Object.assign(process.env, set);
  const events = [];
  try {
    const result = await runClaude({
      cwd: tmp, prompt: '프롬프트\n두 줄', claudeBin: FAKE, onEvent: (e) => events.push(e), ...opts,
    });
    return { result, events, rec: JSON.parse(fs.readFileSync(record, 'utf8')) };
  } catch (err) {
    err.events = events;
    throw err;
  } finally {
    for (const k of Object.keys(set)) delete process.env[k];
  }
}

test('성공: 이벤트 수·sessionId·result, stdin 으로 프롬프트, resume 없음', async () => {
  const { result, events, rec } = await run('stream-ok.jsonl');
  assert.equal(events.length, lines('stream-ok.jsonl').length);
  assert.deepEqual(result, { sessionId: SID, result: 'ok', permissionDenials: [] });
  assert.equal(rec.stdin, '프롬프트\n두 줄');
  assert.equal(fs.realpathSync(rec.cwd), fs.realpathSync(tmp));
  assert.deepEqual(rec.argv, ['-p', '--output-format', 'stream-json', '--verbose']);
});

test('옵션은 각각 정확한 인자로 들어간다', async () => {
  const { rec } = await run('stream-ok.jsonl', {
    sessionId: 'abc', addDirs: ['/r1', '/r2'], systemPrompt: '목차', mcpConfigPath: '/m.json', permissionMode: 'default',
  });
  assert.deepEqual(rec.argv, [
    '-p', '--output-format', 'stream-json', '--verbose', '--resume', 'abc',
    '--add-dir', '/r1', '--add-dir', '/r2', '--append-system-prompt', '목차',
    '--mcp-config', '/m.json', '--permission-prompt-tool', 'mcp__rooms__approve',
    '--permission-mode', 'default',
  ]);
});

test('중간에 죽으면 CLAUDE_EXIT_1, 그 전 이벤트와 sessionId 는 남는다', async () => {
  await assert.rejects(run('stream-crash.jsonl', { env: { FAKE_EXIT: '1', FAKE_STDERR: 'boom' } }), (err) => {
    assert.equal(err.message, 'CLAUDE_EXIT_1');
    assert.equal(err.events.length, 2);
    assert.equal(err.sessionId, SID);
    assert.equal(err.stderr, 'boom');
    return true;
  });
});

test('result 없이 정상 종료하면 NO_RESULT', async () => {
  await assert.rejects(run('stream-crash.jsonl'), { message: 'NO_RESULT' });
});

test('한도 초과는 USAGE_LIMIT, 일반 오류는 CLAUDE_ERROR', async () => {
  await assert.rejects(run('stream-limit.jsonl'), { message: 'USAGE_LIMIT' });
  await assert.rejects(run('stream-limit.jsonl', { env: { FAKE_EXIT: '1' } }), { message: 'USAGE_LIMIT' });
  await assert.rejects(run('stream-error.jsonl'), { message: 'CLAUDE_ERROR' });
});

test('stderr 의 한도 문구도 USAGE_LIMIT', async () => {
  await assert.rejects(
    run('stream-crash.jsonl', { env: { FAKE_EXIT: '1', FAKE_STDERR: 'You hit your limit' } }),
    { message: 'USAGE_LIMIT' },
  );
});

test('없는 바이너리는 CLAUDE_NOT_FOUND', async () => {
  await assert.rejects(
    runClaude({ cwd: tmp, prompt: 'x', claudeBin: path.join(tmp, 'no-such-claude') }),
    { message: 'CLAUDE_NOT_FOUND' },
  );
});

test('파싱 안 되는 줄이 섞여도 계속 진행하고 permission_denials 를 돌려준다', async () => {
  const { result, events } = await run('stream-garbage.jsonl');
  assert.equal(events.length, 3);
  assert.equal(result.result, 'ok');
  assert.deepEqual(result.permissionDenials, [{ tool_name: 'Bash' }]);
});

test('AbortSignal 로 중단하면 CLAUDE_KILLED', async () => {
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(run('stream-ok.jsonl', { signal: ac.signal }), { message: 'CLAUDE_KILLED' });
});

test('실제 claude (RUN_REAL_CLAUDE=1 일 때만)', { skip: !process.env.RUN_REAL_CLAUDE }, async () => {
  const r = await runClaude({ cwd: tmp, prompt: '답은 ok 한 단어로만.' });
  assert.ok(r.sessionId);
  assert.match(r.result, /ok/i);
});
