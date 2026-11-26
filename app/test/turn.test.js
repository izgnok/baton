import test, { beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { MSG } from '@rooms/shared/protocol.js';
import { runTurn } from '../main/runner/turn.js';
import { roomDirOf } from '../main/runner/sync.js';
import { buildPrompt } from '../main/runner/prompt.js';

const fx = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const FAKE = path.join(fx, 'fake-claude.mjs');
const SID = '11111111-2222-3333-4444-555555555555';
const g = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'pipe' }).toString();

const sha = (x) => createHash('sha256').update(x).digest('hex');
const tmps = [];
after(() => tmps.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
fs.chmodSync(FAKE, 0o755);

let tmp;
let repo;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rooms-turn-'));
  tmps.push(tmp);
  process.env.ROOMS_HOME = path.join(tmp, 'home');
  process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude-config');
  const bare = path.join(tmp, 'r.git');
  const seed = path.join(tmp, 'seed');
  fs.mkdirSync(seed);
  g(seed, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(seed, 'a.txt'), 'a');
  g(seed, 'add', '.');
  g(seed, 'commit', '-q', '-m', 'init');
  g(tmp, 'init', '-q', '--bare', '-b', 'main', bare);
  g(seed, 'remote', 'add', 'origin', bare);
  g(seed, 'push', '-q', 'origin', 'main');
  const local = path.join(tmp, 'local');
  g(tmp, 'clone', '-q', bare, local);
  repo = { id: 1, name: 'r', remoteUrl: bare, branch: 'main', local };
});

// 가짜 서버 클라이언트와 http, 입력 묶음
function setup({ finishError } = {}) {
  const calls = [];
  const client = {
    request: async (type, payload) => {
      calls.push({ type, payload });
      if (type === MSG.RUN_FINISH) {
        if (finishError) throw new Error(finishError);
        return { newVersion: 1 };
      }
      return null;
    },
  };
  const http = {
    getTranscript: async () => null,
    getManifest: async () => [],
    getShared: async () => Buffer.alloc(0),
  };
  const runStart = {
    requestId: 42, roomId: 5, sessionId: null, transcriptVersion: 3, requesterName: 'A', body: '해줘',
    chatsSince: [{ name: 'B', body: '안녕' }],
  };
  const roomState = { repos: [{ id: repo.id, name: repo.name, remoteUrl: repo.remoteUrl, branch: repo.branch }] };
  const closed = [];
  return {
    calls, client, http, runStart, roomState, closed,
    roomRepoPaths: { [repo.id]: repo.local },
    askUser: async () => 'allow',
    closeApproval: (id) => closed.push(id),
    claudeBin: FAKE,
  };
}

async function run(args, env = {}) {
  const record = path.join(tmp, 'record.json');
  const set = { FAKE_STREAM: path.join(fx, 'stream-ok.jsonl'), FAKE_RECORD: record, ...env };
  Object.assign(process.env, set);
  try {
    const p = runTurn(args);
    return { promise: p, record, done: async () => ({ result: await p, rec: fs.existsSync(record) ? JSON.parse(fs.readFileSync(record, 'utf8')) : null }) };
  } finally {
    // 환경 변수는 spawn 시점에 읽히므로 완료 뒤 정리한다
    run.cleanup = () => Object.keys(set).forEach((k) => delete process.env[k]);
  }
}
async function runDone(args, env) {
  const r = await run(args, env);
  try { return await r.done(); } finally { run.cleanup(); }
}
const argAfter = (argv, flag) => argv[argv.indexOf(flag) + 1];

test('정상: 신호 → 이벤트(system 제외) → finish, 올리는 값과 인자 확인', async () => {
  const a = setup();
  const index = '- 메모 한 줄'; // 서버에서 내려받은 방 메모리 목차
  a.http.getManifest = async () => [{ path: 'memory/INDEX.md', sha256: sha(index) }];
  a.http.getShared = async () => Buffer.from(index);
  const { result, rec } = await runDone(a, { FAKE_TRANSCRIPT: '{"t":1}\n', FAKE_SHARED_WRITE: 'outputs/r.md' });
  assert.deepEqual(result, { ok: true });

  const types = a.calls.map((c) => c.type);
  assert.equal(types[0], MSG.RUN_HEARTBEAT);
  assert.equal(types.at(-1), MSG.RUN_FINISH);
  const events = a.calls.filter((c) => c.type === MSG.RUN_EVENT);
  assert.deepEqual(events.map((c) => c.payload.event.type), ['assistant', 'result']);
  assert.equal(types.includes(MSG.RUN_FAIL), false);

  const fin = a.calls.at(-1).payload;
  assert.equal(fin.transcript, '{"t":1}\n');
  assert.equal(fin.transcriptVersion, 3);
  assert.equal(fin.sessionId, SID);
  assert.equal(fin.requestId, 42);
  assert.deepEqual(fin.sharedChanges.map((c) => c.path), ['outputs/r.md']);

  const roomDir = roomDirOf(5);
  assert.equal(rec.stdin, buildPrompt(a.runStart));
  assert.equal(argAfter(rec.argv, '--permission-mode'), 'default');
  assert.equal(argAfter(rec.argv, '--permission-prompt-tool'), 'mcp__rooms__approve');
  assert.ok(argAfter(rec.argv, '--mcp-config').endsWith('mcp.json'));
  assert.equal(argAfter(rec.argv, '--add-dir'), repo.local);
  const sys = argAfter(rec.argv, '--append-system-prompt');
  assert.ok(sys.includes(roomDir) && sys.includes('- 메모 한 줄'));
  assert.equal(rec.argv.includes('--resume'), false);
  assert.equal(fs.realpathSync(rec.cwd), fs.realpathSync(roomDir));

  assert.deepEqual(a.closed, [42]);
  assert.equal(fs.existsSync(path.dirname(argAfter(rec.argv, '--mcp-config'))), false);
});

test('목차가 없으면 "(아직 없음)"', async () => {
  const a = setup();
  const { rec } = await runDone(a, { FAKE_TRANSCRIPT: 'x' });
  assert.ok(argAfter(rec.argv, '--append-system-prompt').endsWith('(아직 없음)'));
});

test('브랜치가 다르면 신호 뒤 RUN_FAIL 만 보내고 claude 는 실행되지 않는다', async () => {
  const a = setup();
  g(repo.local, 'checkout', '-q', '-b', 'develop');
  const { result, rec } = await runDone(a);
  assert.deepEqual(result, { ok: false, error: 'PREFLIGHT:BRANCH_MISMATCH' });
  assert.deepEqual(a.calls, [
    { type: MSG.RUN_HEARTBEAT, payload: { requestId: 42 } },
    { type: MSG.RUN_FAIL, payload: { requestId: 42, reason: 'PREFLIGHT:BRANCH_MISMATCH' } },
  ]);
  assert.equal(rec, null);
  assert.deepEqual(a.closed, [42]);
});

test('claude 가 비정상 종료하면 RUN_FAIL, finish 는 보내지 않는다', async () => {
  const a = setup();
  const { result } = await runDone(a, { FAKE_STREAM: path.join(fx, 'stream-crash.jsonl'), FAKE_EXIT: '1' });
  assert.deepEqual(result, { ok: false, error: 'CLAUDE_EXIT_1' });
  const types = a.calls.map((c) => c.type);
  assert.equal(types.includes(MSG.RUN_FINISH), false);
  assert.deepEqual(a.calls.at(-1), { type: MSG.RUN_FAIL, payload: { requestId: 42, reason: 'CLAUDE_EXIT_1' } });
});

test('RUN_FINISH 가 실패하면 RUN_FAIL 을 보내지 않는다', async () => {
  const a = setup({ finishError: 'VERSION_MISMATCH' });
  const { result } = await runDone(a, { FAKE_TRANSCRIPT: 'x' });
  assert.deepEqual(result, { ok: false, error: 'VERSION_MISMATCH' });
  assert.equal(a.calls.some((c) => c.type === MSG.RUN_FAIL), false);
  assert.deepEqual(a.closed, [42]);
});

test('대화 원본을 못 찾으면 TRANSCRIPT_NOT_FOUND 로 RUN_FAIL', async () => {
  const a = setup();
  const { result } = await runDone(a); // FAKE_TRANSCRIPT 없음
  assert.deepEqual(result, { ok: false, error: 'TRANSCRIPT_NOT_FOUND' });
  assert.equal(a.calls.at(-1).type, MSG.RUN_FAIL);
});

test('실행 중 roomState 가 바뀌어도 시작 때 값으로 끝난다', async () => {
  const a = setup();
  const r = await run(a, { FAKE_TRANSCRIPT: 'x', FAKE_SLEEP_MS: '60' });
  a.roomState.repos[0].branch = 'zzz';
  a.roomState.repos.push({ id: 2, name: 'x', remoteUrl: 'u', branch: 'b' });
  a.roomRepoPaths[1] = '/nope';
  try {
    const { result, rec } = await r.done();
    assert.deepEqual(result, { ok: true });
    assert.deepEqual(rec.argv.filter((x, i) => rec.argv[i - 1] === '--add-dir'), [repo.local]);
  } finally { run.cleanup(); }
});

test('heartbeatMs 마다 신호를 보낸다', async () => {
  const a = setup();
  a.heartbeatMs = 20;
  const { result } = await runDone(a, { FAKE_TRANSCRIPT: 'x', FAKE_SLEEP_MS: '200' });
  assert.equal(result.ok, true);
  const beats = a.calls.filter((c) => c.type === MSG.RUN_HEARTBEAT).length;
  assert.ok(beats >= 2, `beats=${beats}`);
  const after = a.calls.length;
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(a.calls.length, after); // 끝난 뒤에는 신호가 없다
});
