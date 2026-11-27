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
import { roomDirOf, transcriptPath } from '../main/runner/sync.js';
import { buildPrompt } from '../main/runner/prompt.js';
import { worktreePath, ensureWorktree } from '../main/runner/worktree.js';
import { uploadRepoCode } from '../main/runner/codeSync.js';
import { ROOM_READ_TOOLS } from '../main/runner/approve.js';

const fx = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const FAKE = path.join(fx, 'fake-claude.mjs');
const SID = '11111111-2222-3333-4444-555555555555';
const g = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'pipe' }).toString().trim();

const sha = (x) => createHash('sha256').update(x).digest('hex');
const tmps = [];
after(() => tmps.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
fs.chmodSync(FAKE, 0o755);

let tmp;
let repo;
let parts; // 가짜 서버의 조각 체인
let store;
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
  g(local, 'config', 'user.name', 't');
  g(local, 'config', 'user.email', 't@t');
  g(seed, 'branch', 'feature/ABC-9');
  g(seed, 'push', '-q', 'origin', 'feature/ABC-9');
  repo = { id: 1, name: 'r', remoteUrl: bare, branch: 'feature/ABC-9', local, bare, wt: worktreePath(5, { id: 1, name: 'r' }) };
  parts = [];
  store = path.join(tmp, 'store');
  fs.mkdirSync(store);
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
    // 가짜 서버: 조각 체인은 parts 에 쌓는다(codeStates 를 서버가 받은 것처럼 apply 로 반영)
    listCodeParts: async () => parts.map(({ file, ...p }) => p),
    downloadCodePart: async (room, repoId, n, file) => fs.copyFileSync(parts[n - 1].file, file),
    uploadBundle: async (room, requestId, file) => {
      if (http.bundleError) throw new Error(http.bundleError);
      const id = String(uploads.size + 1).padStart(16, '0');
      const kept = path.join(store, id);
      fs.copyFileSync(file, kept);
      uploads.set(id, kept);
      return { uploadId: id, size: fs.statSync(file).size };
    },
  };
  const uploads = new Map();
  const runStart = {
    requestId: 42, roomId: 5, sessionId: null, transcriptVersion: 3, requesterName: 'A', body: '해줘',
    chatsSince: [{ name: 'B', body: '안녕' }],
  };
  const roomState = { repos: [{ id: repo.id, name: repo.name, remoteUrl: repo.remoteUrl, baseBranch: repo.branch, workBranch: '', code: null }] };
  const closed = [];
  const applied = [];
  return {
    calls, client, http, runStart, roomState, closed, applied, uploads,
    lastApplied: {},
    onCodeApplied: (repoId, snapshot) => applied.push([repoId, snapshot]),
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
  assert.deepEqual(events.map((c) => c.payload.event.type), ['assistant', 'result']); // 바뀐 코드가 없으면 rooms_code_changes 도 없다
  assert.equal(types.includes(MSG.RUN_FAIL), false);

  const fin = a.calls.at(-1).payload;
  assert.equal(fin.transcript, '{"t":1}\n');
  assert.equal(fin.transcriptVersion, 3);
  assert.equal(fin.sessionId, SID);
  assert.equal(fin.requestId, 42);
  assert.deepEqual(fin.sharedChanges.map((c) => c.path), ['outputs/r.md']);
  assert.deepEqual([fin.codeStates, fin.promotedRepoIds], [[], []]); // 코드가 안 바뀌었으면 올릴 것도 승격도 없다
  assert.equal('branchChanges' in fin, false);
  assert.deepEqual(a.applied, [[1, null]]);

  const roomDir = roomDirOf(5);
  assert.equal(rec.stdin, buildPrompt(a.runStart));
  assert.equal(rec.stdin, '[요청 - A]\n해줘'); // 사람끼리 채팅(chatsSince)은 넘기지 않는다
  assert.equal(rec.claudeMdEnv, '1');
  assert.equal(argAfter(rec.argv, '--permission-mode'), 'default');
  assert.equal(argAfter(rec.argv, '--permission-prompt-tool'), 'mcp__rooms__approve');
  assert.ok(argAfter(rec.argv, '--mcp-config').endsWith('mcp.json'));
  assert.equal(argAfter(rec.argv, '--add-dir'), repo.wt);
  const sys = argAfter(rec.argv, '--append-system-prompt');
  // 안내문에는 PC 마다 다른 절대 경로를 넣지 않는다(다음 사람 PC 에서 헷갈리지 않게)
  assert.ok(!sys.includes(roomDir) && sys.includes('./shared/memory') && sys.includes('- 메모 한 줄'));
  assert.ok(!sys.includes(repo.wt));
  // 레포 이름·기준 브랜치·사본(상대 경로)·push 명령
  assert.ok(sys.includes('- r · 기준 feature/ABC-9 / 사본 ./repos/1-r'));
  assert.ok(sys.includes('git -C ./repos/1-r push -u origin HEAD:refs/heads/feature/ABC-9') && !sys.includes('pendingBranch'));
  assert.ok(sys.includes('A 님의 PC'));
  assert.ok(sys.includes('mcp__rooms__git_read') && !sys.includes('자동으로'));
  assert.equal(rec.argv.includes('--resume'), false);
  assert.equal(fs.realpathSync(rec.cwd), fs.realpathSync(roomDir));

  assert.deepEqual(a.closed, [42]);
  assert.equal(fs.existsSync(path.dirname(argAfter(rec.argv, '--mcp-config'))), false);
});

test('runStart.fork 면 원래 세션 원본을 새 방 폴더에 받고 --resume <원래 id> --fork-session 으로 실행, 끝나면 새 세션 id 를 올린다', async () => {
  const a = setup();
  const OLD = 'aaaaaaaa-2222-3333-4444-555555555555';
  a.runStart = { ...a.runStart, sessionId: OLD, fork: true };
  a.http.getTranscript = async () => '{"t":"원래 대화"}\n';
  const { result, rec } = await runDone(a, { FAKE_TRANSCRIPT: '{"t":"갈라진 대화"}\n' });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(rec.argv.slice(rec.argv.indexOf('--resume'), rec.argv.indexOf('--resume') + 3), ['--resume', OLD, '--fork-session']);
  assert.equal(fs.readFileSync(transcriptPath({ cwd: roomDirOf(5), sessionId: OLD }), 'utf8'), '{"t":"원래 대화"}\n');
  const fin = a.calls.at(-1).payload;
  assert.deepEqual([fin.sessionId, fin.transcript], [SID, '{"t":"갈라진 대화"}\n']);
});

test('fork 가 아니면 --fork-session 이 없다', async () => {
  const a = setup();
  a.runStart = { ...a.runStart, sessionId: 'aaaaaaaa-2222-3333-4444-555555555555', fork: false };
  a.http.getTranscript = async () => '{}\n';
  const { rec } = await runDone(a, { FAKE_TRANSCRIPT: '{}\n' });
  assert.equal(rec.argv.includes('--fork-session'), false);
});

test('목차가 없으면 "(아직 없음)"', async () => {
  const a = setup();
  const { rec } = await runDone(a, { FAKE_TRANSCRIPT: 'x' });
  assert.ok(argAfter(rec.argv, '--append-system-prompt').endsWith('(아직 없음)'));
});

test('원격에 없는 방 브랜치면 신호 뒤 RUN_FAIL 만 보내고 claude 는 실행되지 않는다', async () => {
  const a = setup();
  a.roomState.repos[0].baseBranch = 'nope';
  const { result, rec } = await runDone(a);
  assert.deepEqual(result, { ok: false, error: 'BRANCH_NOT_ON_REMOTE' });
  assert.deepEqual(a.calls, [
    { type: MSG.RUN_HEARTBEAT, payload: { requestId: 42 } },
    { type: MSG.RUN_FAIL, payload: { requestId: 42, reason: 'BRANCH_NOT_ON_REMOTE' } },
  ]);
  assert.equal(rec, null);
  assert.deepEqual(a.closed, [42]);
});

test('원본 폴더가 다른 브랜치여도 실행된다', async () => {
  const a = setup();
  g(repo.local, 'checkout', '-q', '-b', 'other');
  const { result } = await runDone(a, { FAKE_TRANSCRIPT: 'x' });
  assert.deepEqual(result, { ok: true });
});

const changesOf = (x) => x.calls.filter((c) => c.type === MSG.RUN_EVENT && c.payload.event.type === 'rooms_code_changes');

test('claude 가 작업 폴더를 고치면 rooms_code_changes 를 finish 바로 앞에 한 번 보내고, push 하지 않는다', async () => {
  const a = setup();
  const before = g(repo.bare, 'rev-parse', 'feature/ABC-9');
  const { result } = await runDone(a, { FAKE_TRANSCRIPT: 'x', FAKE_REPO_WRITE: 'src/new.txt' });
  assert.deepEqual(result, { ok: true });
  const types = a.calls.map((c) => c.type);
  assert.equal(types.at(-1), MSG.RUN_FINISH);
  const ev = changesOf(a);
  assert.equal(ev.length, 1);
  assert.equal(types.indexOf(MSG.RUN_EVENT, types.length - 2), types.length - 2); // finish 바로 앞
  assert.deepEqual(ev[0].payload.event.results, [{
    repoId: 1, name: 'r', branch: 'feature/ABC-9',
    files: [{ status: '??', path: 'src/new.txt' }], diff: '', truncated: false, ahead: 0,
  }]);
  // 커밋도 push 도 하지 않는다(원격 그대로, 작업 폴더에는 파일만 남는다)
  assert.equal(g(repo.bare, 'rev-parse', 'feature/ABC-9'), before);
  assert.equal(g(repo.wt, 'status', '--porcelain', '-uall'), '?? src/new.txt');
  // 내 원본 폴더에는 아무것도 쓰지 않는다
  assert.equal(g(repo.local, 'status', '--porcelain'), '');
  assert.equal(g(repo.local, 'branch', '--show-current'), 'main');
});

test('기존 파일을 고치면 diff 가 들어간다. 고친 게 없으면 이벤트를 보내지 않는다', async () => {
  const a = setup();
  const r1 = await runDone(a, { FAKE_TRANSCRIPT: 'x' });
  assert.equal(r1.result.ok, true);
  assert.equal(changesOf(a).length, 0);

  const b = setup();
  const r2 = await runDone(b, { FAKE_TRANSCRIPT: 'x', FAKE_REPO_WRITE: 'a.txt' });
  assert.equal(r2.result.ok, true);
  const [res] = changesOf(b)[0].payload.event.results;
  assert.deepEqual(res.files, [{ status: 'M', path: 'a.txt' }]);
  assert.ok(res.diff.includes('+고친 코드'));
});

test('이전에 커밋만 해 두고 push 안 한 변경(ahead)도 알린다', async () => {
  const a = setup();
  await ensureWorktree({ sourcePath: repo.local, worktreePath: repo.wt, branch: repo.branch });
  fs.writeFileSync(path.join(repo.wt, 'left.txt'), 'l');
  g(repo.wt, 'add', '-A');
  g(repo.wt, 'commit', '-qm', 'left over');
  const { result } = await runDone(a, { FAKE_TRANSCRIPT: 'x' });
  assert.equal(result.ok, true);
  const [res] = changesOf(a)[0].payload.event.results;
  assert.deepEqual([res.files, res.ahead], [[], 1]);
});

test('안내문·allowedTools·addDirs·env: 함께 읽는 폴더와 내 PC 레포를 읽기 전용으로 연다', async () => {
  const a = setup();
  const notes = path.join(tmp, 'notes'); // 함께 읽는 폴더(레포 아님)
  fs.mkdirSync(notes);
  const idxRepo = path.join(tmp, 'idx-repo'); // 내 PC 레포 목록의 레포
  g(tmp, 'clone', '-q', repo.bare, idxRepo);
  a.readDirs = [notes, path.join(tmp, 'gone')]; // 없어진 폴더는 뺀다
  a.repoIndex = [{ path: idxRepo, name: 'idx-repo', remoteUrl: repo.bare }];
  const { result, rec } = await runDone(a, { FAKE_TRANSCRIPT: 'x' });
  assert.equal(result.ok, true);

  assert.deepEqual(rec.argv.filter((x, i) => rec.argv[i - 1] === '--add-dir'), [repo.wt, notes]);
  assert.equal(rec.claudeMdEnv, '1');
  const tools = rec.argv.slice(rec.argv.indexOf('--allowedTools') + 1);
  const rules = (p) => ['Read', 'Glob', 'Grep'].map((t) => `${t}(//${p.slice(1)}/**)`);
  assert.deepEqual(tools, ['mcp__rooms__git_read', ...ROOM_READ_TOOLS, ...rules(idxRepo), ...rules(notes)]);
  const read1 = tools[1 + ROOM_READ_TOOLS.length];
  assert.ok(read1.startsWith('Read(//') && !read1.startsWith('Read(///'));

  const sys = argAfter(rec.argv, '--append-system-prompt');
  assert.ok(sys.includes(`- notes: ${notes}`) && sys.includes(`- idx-repo: ${idxRepo}`));
  assert.ok(sys.includes('이 PC 기준') && sys.includes('원본 폴더에서 checkout·switch 금지') && !sys.includes('gone'));

  // 승인 다리의 git_read 허용 저장소: 내 PC 레포, 방 작업 폴더, 원본. git 레포가 아닌 함께 읽는 폴더는 빠진다
  const readRepos = JSON.parse(rec.mcp.mcpServers.rooms.env.ROOMS_READ_REPOS);
  assert.deepEqual(readRepos.sort(), [idxRepo, repo.wt, repo.local].sort());
});

test('claude 가 비정상 종료하면 RUN_FAIL, finish 는 보내지 않는다', async () => {
  const a = setup();
  const { result } = await runDone(a, { FAKE_STREAM: path.join(fx, 'stream-crash.jsonl'), FAKE_EXIT: '1' });
  assert.deepEqual(result, { ok: false, error: 'CLAUDE_EXIT_1' });
  const types = a.calls.map((c) => c.type);
  assert.equal(types.includes(MSG.RUN_FINISH), false);
  assert.deepEqual(a.calls.at(-1), { type: MSG.RUN_FAIL, payload: { requestId: 42, reason: 'CLAUDE_EXIT_1' } });
});

test('claude 가 실패하면 작업 폴더를 고쳤어도 변경 알림을 보내지 않는다', async () => {
  const a = setup();
  const before = g(repo.bare, 'rev-parse', 'feature/ABC-9');
  const { result } = await runDone(a, { FAKE_STREAM: path.join(fx, 'stream-crash.jsonl'), FAKE_EXIT: '1', FAKE_REPO_WRITE: 'x.txt' });
  assert.equal(result.ok, false);
  assert.equal(g(repo.bare, 'rev-parse', 'feature/ABC-9'), before);
  assert.equal(a.calls.some((c) => c.payload?.event?.type === 'rooms_code_changes'), false);
});

test('RUN_FINISH 가 실패하면 RUN_FAIL 을 보내지 않는다', async () => {
  const a = setup({ finishError: 'VERSION_MISMATCH' });
  const { result } = await runDone(a, { FAKE_TRANSCRIPT: 'x' });
  assert.deepEqual(result, { ok: false, error: 'VERSION_MISMATCH' });
  assert.deepEqual(a.applied, []); // 서버가 받지 못했으니 맞춰 둔 상태를 기록하지 않는다
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
  a.roomState.repos[0].baseBranch = 'zzz';
  a.roomState.repos.push({ id: 2, name: 'x', remoteUrl: 'u', baseBranch: 'b', workBranch: '', code: null });
  a.roomRepoPaths[1] = '/nope';
  try {
    const { result, rec } = await r.done();
    assert.deepEqual(result, { ok: true });
    assert.deepEqual(rec.argv.filter((x, i) => rec.argv[i - 1] === '--add-dir'), [repo.wt]);
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

test('중단 신호(abort)면 CLAUDE_KILLED 로 RUN_FAIL, 변경 알림·finish 는 보내지 않는다', async () => {
  const a = setup();
  const ac = new AbortController();
  a.signal = ac.signal;
  const r = await run(a, { FAKE_TRANSCRIPT: 'x', FAKE_REPO_WRITE: 'k.txt', FAKE_SLEEP_MS: '2000' });
  for (let i = 0; i < 100 && !fs.existsSync(r.record); i++) await new Promise((x) => setTimeout(x, 50)); // claude 가 뜰 때까지
  ac.abort();
  try {
    const { result } = await r.done();
    assert.deepEqual(result, { ok: false, error: 'CLAUDE_KILLED' });
    assert.equal(a.calls.at(-1).type, MSG.RUN_FAIL);
    assert.equal(a.calls.some((c) => c.type === MSG.RUN_FINISH), false);
    assert.equal(changesOf(a).length, 0);
  } finally { run.cleanup(); }
});

test('rate_limit_event 는 서버로 보내지 않고 onRateLimit 으로 넘긴다. model·effort 는 claude 인자로', async () => {
  const a = setup();
  const got = [];
  a.onRateLimit = (ev) => got.push(ev);
  a.model = 'sonnet';
  a.effort = 'low';
  const { result, rec } = await runDone(a, { FAKE_STREAM: path.join(fx, 'stream-ratelimit.jsonl'), FAKE_TRANSCRIPT: 'x' });
  assert.equal(result.ok, true);
  assert.equal(got.length, 1);
  assert.equal(got[0].rate_limit_info.unifiedWindows.five_hour.utilization, 0.21);
  const sent = a.calls.filter((c) => c.type === MSG.RUN_EVENT).map((c) => c.payload.event.type);
  assert.deepEqual(sent, ['assistant', 'result']);
  assert.equal(argAfter(rec.argv, '--model'), 'sonnet');
  assert.equal(argAfter(rec.argv, '--effort'), 'low');
});

test('onRateLimit 이 던져도 실행은 끝까지 간다', async () => {
  const a = setup();
  a.onRateLimit = () => { throw new Error('저장 실패'); };
  const { result } = await runDone(a, { FAKE_STREAM: path.join(fx, 'stream-ratelimit.jsonl'), FAKE_TRANSCRIPT: 'x' });
  assert.equal(result.ok, true);
});

// ---- 공유 사본: 실행 전 맞추기, 실행 뒤 바뀐 것만 올리기, 승격 ----

const finishOf = (x) => x.calls.find((c) => c.type === MSG.RUN_FINISH).payload;
const eventsOf = (x, type) => x.calls.filter((c) => c.type === MSG.RUN_EVENT && c.payload.event.type === type);
const gitEnv = (...cmds) => ({ FAKE_TRANSCRIPT: 'x', FAKE_REPO_GIT: JSON.stringify(cmds) });
// 가짜 서버가 코드 상태를 받은 것처럼 반영한다
function applyEntry(a, e) {
  if (e.snapshot === null) parts = [];
  else {
    if (e.prevSnapshot === null) parts = [];
    parts.push({ seq: parts.length + 1, prevSnapshot: e.prevSnapshot, snapshot: e.snapshot, baseCommit: e.baseCommit, size: 1, file: a.uploads.get(e.uploadId) });
  }
  a.roomState.repos[0].code = parts.length ? { snapshot: parts.at(-1).snapshot, parts: parts.length } : null;
}
// 다른 사람이 원격 방 브랜치에 커밋을 올린다
function otherPush(file, text) {
  const o = path.join(tmp, `other-${file}`);
  g(tmp, 'clone', '-q', '-b', 'feature/ABC-9', repo.bare, o);
  fs.writeFileSync(path.join(o, file), text);
  g(o, 'add', '.');
  g(o, 'commit', '-q', '-m', `other ${file}`);
  g(o, 'push', '-q', 'origin', 'HEAD:refs/heads/feature/ABC-9');
  return g(repo.bare, 'rev-parse', 'feature/ABC-9');
}

test('고친 것은 codeStates 로 올린다(기준 브랜치, 처음이라 prevSnapshot null). 원본 이름표·onCodeApplied 도 기록, branchChanges 는 없다', async () => {
  const a = setup();
  const { result } = await runDone(a, { FAKE_TRANSCRIPT: 'x', FAKE_REPO_WRITE: 'src/new.txt' });
  assert.deepEqual(result, { ok: true });
  const fin = finishOf(a);
  assert.equal(fin.codeStates.length, 1);
  const e = fin.codeStates[0];
  assert.deepEqual([e.repoId, e.baseBranch, e.baseCommit, e.prevSnapshot], [1, 'feature/ABC-9', g(repo.bare, 'rev-parse', 'feature/ABC-9'), null]);
  assert.match(e.snapshot, /^[0-9a-f]{40}$/);
  assert.match(e.uploadId, /^[0-9a-f]{16}$/);
  assert.deepEqual(fin.promotedRepoIds, []);
  assert.deepEqual(a.applied, [[1, e.snapshot]]);
  assert.equal(g(repo.local, 'rev-parse', 'refs/rooms/5/1'), e.snapshot);
  assert.equal(a.calls.some((c) => c.payload?.event?.type === 'rooms_branch_changes'), false);
});

test('서버에 조각이 있으면 실행 전에 사본을 그 상태로 맞추고, 실행이 올리는 것은 그 위의 증분이다', async () => {
  const a = setup();
  // 다른 맥(별도 원본·사본)이 먼저 올린다
  const src2 = path.join(tmp, 'src2');
  g(tmp, 'clone', '-q', repo.bare, src2);
  const wt2 = path.join(tmp, 'wt2');
  await ensureWorktree({ sourcePath: src2, worktreePath: wt2, branch: 'feature/ABC-9' });
  fs.writeFileSync(path.join(wt2, 'from-other.txt'), 'o');
  const up = await uploadRepoCode({ http: a.http, roomId: 5, requestId: 1, repo: { id: 1, baseBranch: 'feature/ABC-9' }, worktree: wt2, prev: null, parts: 0, tmpDir: path.join(tmp, 'up') });
  applyEntry(a, up.entry);

  const { result } = await runDone(a, { FAKE_TRANSCRIPT: 'x', FAKE_REPO_WRITE: 'mine.txt' });
  assert.deepEqual(result, { ok: true });
  assert.equal(fs.readFileSync(path.join(repo.wt, 'from-other.txt'), 'utf8'), 'o'); // 실행 전에 맞춰졌다
  assert.equal(fs.readFileSync(path.join(repo.wt, 'mine.txt'), 'utf8'), '고친 코드');
  const [e] = finishOf(a).codeStates;
  assert.equal(e.prevSnapshot, up.entry.snapshot);
  assert.deepEqual(a.applied, [[1, e.snapshot]]);
  // 이미 맞춰 둔 사본이 바뀐 게 없으면 올리지 않고 그 스냅샷을 그대로 기록한다
  const b = setup();
  b.roomState.repos[0].code = { snapshot: e.snapshot, parts: 1 };
  parts = [{ seq: 1, prevSnapshot: null, snapshot: e.snapshot, baseCommit: e.baseCommit, size: 1, file: a.uploads.get(up.entry.uploadId) }];
  b.lastApplied = { 1: e.snapshot };
  await runDone(b, { FAKE_TRANSCRIPT: 'x' });
  assert.deepEqual(finishOf(b).codeStates, []);
  assert.deepEqual(b.applied, [[1, e.snapshot]]);
});

test('기준 브랜치와 충돌하면 CODE_CONFLICT 로 실행하지 않는다', async () => {
  const a = setup();
  await ensureWorktree({ sourcePath: repo.local, worktreePath: repo.wt, branch: repo.branch });
  fs.writeFileSync(path.join(repo.wt, 'a.txt'), 'mine');
  otherPush('a.txt', 'theirs');
  const { result, rec } = await runDone(a);
  assert.deepEqual(result, { ok: false, error: 'CODE_CONFLICT' });
  assert.equal(rec, null);
  assert.deepEqual(a.calls.at(-1), { type: MSG.RUN_FAIL, payload: { requestId: 42, reason: 'CODE_CONFLICT' } });
  assert.deepEqual(a.applied, []);
  assert.equal(fs.readFileSync(path.join(repo.wt, 'a.txt'), 'utf8'), 'mine'); // 사본은 그대로
});

test('작업 브랜치가 원격에 생겼으면(push) 승격: promotedRepoIds, 남은 게 없으면 올리지 않고 기록은 null', async () => {
  const a = setup();
  a.roomState.repos[0].workBranch = 'feature/new';
  const { result } = await runDone(a, { ...gitEnv(['add', '-A'], ['commit', '-qm', 'p'], ['push', '-q', 'origin', 'HEAD:refs/heads/feature/new']), FAKE_REPO_WRITE: 'p.txt' });
  assert.deepEqual(result, { ok: true });
  const fin = finishOf(a);
  assert.deepEqual([fin.promotedRepoIds, fin.codeStates], [[1], []]);
  assert.deepEqual(a.applied, [[1, null]]);
  assert.equal(eventsOf(a, 'rooms_code_changes').length, 0); // push 한 그대로라 바뀐 코드 카드도 없다
});

test('승격 뒤에도 사본에 남은 변경이 있으면 작업 브랜치를 기준으로 올린다. 원격에 없으면 승격하지 않는다', async () => {
  const a = setup();
  a.roomState.repos[0].workBranch = 'feature/new';
  await runDone(a, { ...gitEnv(['add', '-A'], ['commit', '-qm', 'p'], ['push', '-q', 'origin', 'HEAD:refs/heads/feature/new'], ['mv', 'a.txt', 'a2.txt']), FAKE_REPO_WRITE: 'p.txt' });
  const fin = finishOf(a);
  assert.deepEqual(fin.promotedRepoIds, [1]);
  assert.equal(fin.codeStates.length, 1);
  assert.deepEqual([fin.codeStates[0].baseBranch, fin.codeStates[0].prevSnapshot, fin.codeStates[0].baseCommit], ['feature/new', null, g(repo.bare, 'rev-parse', 'feature/new')]);
  const [card] = eventsOf(a, 'rooms_code_changes')[0].payload.event.results;
  assert.equal(card.branch, 'feature/new'); // 바뀐 코드 카드도 작업 브랜치 기준

  const b = setup();
  b.roomState.repos[0].workBranch = 'feature/not-pushed';
  await runDone(b, { FAKE_TRANSCRIPT: 'x', FAKE_REPO_WRITE: 'q.txt' });
  const fb = finishOf(b);
  assert.deepEqual([fb.promotedRepoIds, fb.codeStates[0].baseBranch], [[], 'feature/ABC-9']);
});

test('변경이 너무 커서 올리지 못하면 rooms_code_too_big 로 알리고, 실행은 성공한다', async () => {
  const a = setup();
  a.http.bundleError = 'BUNDLE_TOO_BIG';
  const { result } = await runDone(a, { FAKE_TRANSCRIPT: 'x', FAKE_REPO_WRITE: 'big.txt' });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(eventsOf(a, 'rooms_code_too_big').map((c) => c.payload.event.repos), [['r']]);
  assert.deepEqual([finishOf(a).codeStates, a.applied], [[], [[1, null]]]);
  const types = a.calls.map((c) => c.type);
  assert.equal(types.at(-1), MSG.RUN_FINISH);
});

test('내 PC 에 원본이 없는 레포는 ensureSource 로 받아 오고, 못 받으면 CLONE_FAILED', async () => {
  const a = setup();
  a.roomRepoPaths = {};
  const asked = [];
  a.ensureSource = async (r) => { asked.push(r.id); return repo.local; };
  assert.equal((await runDone(a, { FAKE_TRANSCRIPT: 'x' })).result.ok, true);
  assert.deepEqual(asked, [1]);

  const b = setup();
  b.roomRepoPaths = {};
  b.ensureSource = async () => { throw new Error('DEST_EXISTS'); };
  assert.deepEqual((await runDone(b)).result, { ok: false, error: 'CLONE_FAILED' });
  const c = setup();
  c.roomRepoPaths = {};
  assert.deepEqual((await runDone(c)).result, { ok: false, error: 'PREFLIGHT:MISSING' }); // ensureSource 가 없으면 지금처럼
});

test('Claude Code 가 오래돼 모델을 못 쓴다는 오류면 onClaudeOutdated 를 부른다', async () => {
  const s = setup();
  let outdated = 0;
  await runDone({ ...s, onClaudeOutdated: () => { outdated++; } }, { FAKE_STREAM: path.join(fx, 'stream-outdated.jsonl') });
  assert.equal(outdated, 1);
  const s2 = setup();
  let other = 0;
  await runDone({ ...s2, onClaudeOutdated: () => { other++; } }, { FAKE_STREAM: path.join(fx, 'stream-error.jsonl') });
  assert.equal(other, 0);
});
