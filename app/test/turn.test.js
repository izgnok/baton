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
import { worktreePath, syncWorktree, currentBranch } from '../main/runner/worktree.js';

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
  const pendingSaved = [];
  return {
    calls, client, http, runStart, roomState, closed, pendingSaved,
    pendingBranches: {},
    onPendingBranches: (p) => pendingSaved.push(p),
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
  // 레포 이름·방 브랜치·방 작업 폴더(상대 경로)·push 명령, 커밋 전에 묻기
  assert.ok(sys.includes('r: 방 브랜치 feature/ABC-9') && sys.includes('./repos/1-r'));
  assert.ok(sys.includes('"커밋·push 할까요?"') && sys.includes('git -C ./repos/1-r push origin HEAD:refs/heads/feature/ABC-9'));
  assert.ok(sys.includes('A 님의 PC'));
  assert.ok(sys.includes('mcp__rooms__git_read') && !sys.includes('자동으로'));
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

test('원격에 없는 방 브랜치면 신호 뒤 RUN_FAIL 만 보내고 claude 는 실행되지 않는다', async () => {
  const a = setup();
  a.roomState.repos[0].branch = 'nope';
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
  await syncWorktree({ sourcePath: repo.local, worktreePath: repo.wt, branch: repo.branch });
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
  assert.deepEqual(tools, ['mcp__rooms__git_read', ...rules(idxRepo), ...rules(notes)]);
  assert.ok(tools[1].startsWith('Read(//') && !tools[1].startsWith('Read(///'));

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

// ---- Claude 가 작업 중 브랜치를 옮기면 방 브랜치가 따라간다 ----

const gitEnv = (...cmds) => ({ FAKE_TRANSCRIPT: 'x', FAKE_REPO_GIT: JSON.stringify(cmds) });
const branchEvents = (x) => x.calls.filter((c) => c.type === MSG.RUN_EVENT && c.payload.event.type === 'rooms_branch_changes');
const finishOf = (x) => x.calls.find((c) => c.type === MSG.RUN_FINISH).payload;
const remoteBranch = (name) => { // 원격에 있는 다른 브랜치(내 원본 폴더도 받아 둔다)
  g(repo.bare, 'branch', name, 'feature/ABC-9');
  g(repo.local, 'fetch', '-q', 'origin');
};

test('원격에 있는 브랜치로 옮기면 branchChanges 에 싣고 작업 폴더는 detached 로 돌아온다', async () => {
  remoteBranch('feature/other');
  const a = setup();
  const { result } = await runDone(a, { ...gitEnv(['switch', '-c', 'feature/other', '--no-track', 'origin/feature/other']), FAKE_REPO_WRITE: 'w.txt' });
  assert.deepEqual(result, { ok: true });

  const types = a.calls.map((c) => c.type);
  const ev = branchEvents(a);
  assert.equal(ev.length, 1);
  assert.deepEqual(ev[0].payload.event.results, [{ repoId: 1, repoName: 'r', branch: 'feature/other', pending: false }]);
  assert.ok(a.calls.indexOf(ev[0]) < types.indexOf(MSG.RUN_FINISH));
  assert.deepEqual(finishOf(a).branchChanges, [{ repoId: 1, branch: 'feature/other' }]);
  assert.equal(await currentBranch(repo.wt), '');
  assert.equal(fs.readFileSync(path.join(repo.wt, 'w.txt'), 'utf8'), '고친 코드'); // 고친 파일은 그대로
  assert.deepEqual(a.pendingSaved, []); // 대기는 없었고 만들어지지도 않았다
});

test('옮기지 않으면 branchChanges 는 비어 있고 알림도 없다', async () => {
  const a = setup();
  await runDone(a, { FAKE_TRANSCRIPT: 'x' });
  assert.deepEqual(finishOf(a).branchChanges, []);
  assert.equal(branchEvents(a).length, 0);
});

test('원격에 없는 새 브랜치: 대기로 저장, 다음 실행 전 동기화는 rebase 하지 않고, push 한 뒤 실행이 끝나면 따라간다', async () => {
  // 1) 새 브랜치로 옮김 → 대기
  const a = setup();
  const r1 = await runDone(a, gitEnv(['switch', '-c', 'feature/new']));
  assert.equal(r1.result.ok, true);
  assert.deepEqual(branchEvents(a)[0].payload.event.results, [{ repoId: 1, repoName: 'r', branch: 'feature/new', pending: true }]);
  assert.deepEqual(finishOf(a).branchChanges, []);
  assert.deepEqual(a.pendingSaved, [{ 1: 'feature/new' }]);
  assert.equal(await currentBranch(repo.wt), 'feature/new'); // 이 맥의 작업 폴더는 그 브랜치 그대로

  // 2) 방 브랜치(원격)가 앞서 가도 다음 실행은 rebase 하지 않는다. 안내문에 대기 표시, 알림 반복 없음
  g(repo.bare, 'update-ref', 'refs/heads/feature/ABC-9', g(repo.bare, 'commit-tree', '-m', 'ahead', '-p', 'feature/ABC-9', 'feature/ABC-9^{tree}'));
  const head = g(repo.wt, 'rev-parse', 'HEAD');
  const b = setup();
  b.pendingBranches = { 1: 'feature/new' };
  const r2 = await runDone(b, { FAKE_TRANSCRIPT: 'x' });
  assert.equal(r2.result.ok, true);
  assert.equal(g(repo.wt, 'rev-parse', 'HEAD'), head);
  assert.equal(await currentBranch(repo.wt), 'feature/new');
  assert.ok(argAfter(r2.rec.argv, '--append-system-prompt').includes('지금 브랜치 feature/new, 아직 원격에 없음'));
  assert.equal(branchEvents(b).length, 0);
  assert.deepEqual(finishOf(b).branchChanges, []);
  assert.deepEqual(b.pendingSaved, []); // 바뀐 게 없으면 저장하지 않는다

  // 3) 사람이 push → 다음 실행이 끝날 때 방 브랜치 변경 + 대기 지움 + detached
  g(repo.wt, 'push', '-q', 'origin', 'feature/new');
  const c = setup();
  c.pendingBranches = { 1: 'feature/new' };
  const r3 = await runDone(c, { FAKE_TRANSCRIPT: 'x' });
  assert.equal(r3.result.ok, true);
  assert.deepEqual(finishOf(c).branchChanges, [{ repoId: 1, branch: 'feature/new' }]);
  assert.deepEqual(branchEvents(c)[0].payload.event.results, [{ repoId: 1, repoName: 'r', branch: 'feature/new', pending: false }]);
  assert.deepEqual(c.pendingSaved, [{}]);
  assert.equal(await currentBranch(repo.wt), '');
});

test('방 브랜치로 돌아오면 대기를 지운다', async () => {
  const a = setup();
  await runDone(a, gitEnv(['switch', '-c', 'feature/new']));
  const b = setup();
  b.pendingBranches = { 1: 'feature/new' };
  const { result } = await runDone(b, gitEnv(['switch', '-c', 'feature/ABC-9', '--no-track', 'origin/feature/ABC-9']));
  assert.equal(result.ok, true);
  assert.deepEqual(finishOf(b).branchChanges, []);
  assert.equal(branchEvents(b).length, 0);
  assert.deepEqual(b.pendingSaved, [{}]);
  assert.equal(await currentBranch(repo.wt), '');
});

test('대기 브랜치가 사라진 작업 폴더(detached)면 대기를 무시하고 방 브랜치로 맞춘다', async () => {
  const a = setup();
  a.pendingBranches = { 1: 'feature/gone' };
  const { result } = await runDone(a, { FAKE_TRANSCRIPT: 'x' });
  assert.equal(result.ok, true);
  assert.deepEqual(a.pendingSaved, [{}]);
  assert.equal(g(repo.wt, 'rev-parse', 'HEAD'), g(repo.bare, 'rev-parse', 'feature/ABC-9'));
});

test('실패한 실행도 옮겨 둔 브랜치를 대기로 적고, 알림·branchChanges 는 보내지 않는다', async () => {
  remoteBranch('feature/other');
  const a = setup();
  const { result } = await runDone(a, { FAKE_STREAM: path.join(fx, 'stream-crash.jsonl'), FAKE_EXIT: '1', FAKE_REPO_GIT: JSON.stringify([['switch', '-c', 'feature/other', '--no-track', 'origin/feature/other']]) });
  assert.equal(result.ok, false);
  assert.deepEqual(a.pendingSaved, [{ 1: 'feature/other' }]);
  assert.equal(branchEvents(a).length, 0);
  assert.equal(await currentBranch(repo.wt), 'feature/other');
});

test('RUN_FINISH 가 거절되면 옮겨 둔 브랜치를 대기로 적고 작업 폴더는 그대로 둔다', async () => {
  remoteBranch('feature/other');
  const a = setup({ finishError: 'VERSION_MISMATCH' });
  const { result } = await runDone(a, gitEnv(['switch', '-c', 'feature/other', '--no-track', 'origin/feature/other']));
  assert.equal(result.error, 'VERSION_MISMATCH');
  assert.deepEqual(a.pendingSaved, [{ 1: 'feature/other' }]);
  assert.equal(await currentBranch(repo.wt), 'feature/other');
});
