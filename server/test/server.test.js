import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { MSG } from '@rooms/shared/protocol.js';
import { startServer } from '../src/index.js';

let srv;
let dataDir;
const base = () => `http://localhost:${srv.port}`;

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rooms-server-'));
  srv = await startServer({ port: 0, dataDir });
});
after(async () => {
  await srv.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function post(p, body) {
  const r = await fetch(base() + p, { method: 'POST', body: JSON.stringify(body) });
  return { status: r.status, json: await r.json() };
}
const signup = async (n) => (await post('/signup', { email: `${n}@x.com`, password: 'password1', name: n })).json;
const get = (p, token) => fetch(base() + p, { headers: token ? { authorization: `Bearer ${token}` } : {} });

// 요청 id 로 reply 를 기다리고, 알림은 따로 쌓는 작은 클라이언트
async function connect() {
  const ws = new WebSocket(`ws://localhost:${srv.port}/ws`);
  const c = { ws, pushes: [], waiters: [], pending: new Map(), nextId: 1 };
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type === 'reply') return c.pending.get(m.replyTo)?.(m);
    const w = c.waiters.findIndex((x) => x.match(m));
    if (w >= 0) c.waiters.splice(w, 1)[0].resolve(m);
    else c.pushes.push(m);
  });
  await new Promise((resolve) => ws.once('open', resolve));
  c.req = (type, payload = {}) => new Promise((resolve) => {
    const id = c.nextId++;
    c.pending.set(id, resolve);
    ws.send(JSON.stringify({ type, id, ...payload }));
  });
  c.ok = async (type, payload) => {
    const r = await c.req(type, payload);
    assert.equal(r.ok, true, `${type}: ${r.error}`);
    return r.data;
  };
  // 알림을 기다린다(이미 와 있으면 바로)
  c.next = (match) => {
    const i = c.pushes.findIndex(match);
    if (i >= 0) return Promise.resolve(c.pushes.splice(i, 1)[0]);
    return new Promise((resolve) => c.waiters.push({ match, resolve }));
  };
  c.close = () => new Promise((resolve) => { ws.once('close', resolve); ws.close(); });
  return c;
}
const login = async (token) => {
  const c = await connect();
  const r = await c.req(MSG.AUTH, { token });
  assert.equal(r.ok, true);
  return c;
};
const timeout = (p, ms = 3000) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

test('HTTP 인증 입력 검사', async () => {
  assert.equal((await post('/signup', { email: 'z@x.com', password: 'short', name: 'z' })).json.error, 'WEAK_PASSWORD');
  const r = await post('/login', { email: 'no@x.com', password: 'password1' });
  assert.equal(r.status, 401);
  const bad = await fetch(base() + '/login', { method: 'POST', body: 'not json' });
  assert.equal(bad.status, 400);
  const big = await fetch(base() + '/login', { method: 'POST', body: 'x'.repeat(1024 * 1024 + 10) }).catch(() => null);
  assert.ok(big === null || big.status === 413);
  assert.equal((await fetch(base() + '/nope')).status, 404);
});

test('인증 없이 room.list 는 UNAUTHENTICATED 후 연결이 끊긴다', async () => {
  const c = await connect();
  const r = await c.req(MSG.ROOM_LIST);
  assert.deepEqual([r.ok, r.error], [false, 'UNAUTHENTICATED']);
  await timeout(new Promise((resolve) => (c.ws.readyState === c.ws.CLOSED ? resolve() : c.ws.once('close', resolve))));
  const d = await connect();
  assert.equal((await d.req(MSG.AUTH, { token: 'wrong' })).error, 'UNAUTHENTICATED');
});

test('방·채팅·@claude·실행 결과·파일·삭제 전체 흐름', async () => {
  const a = await signup('alice');
  const b = await signup('bob');
  const c = await signup('carol');
  const A = await login(a.token);
  const B = await login(b.token);

  // 방 만들기, 참가 → 상태 방송
  const room = await A.ok(MSG.ROOM_CREATE, { name: '방' });
  const stateP = A.next((m) => m.type === MSG.ROOM_STATE && m.state.members.length === 2);
  await B.ok(MSG.ROOM_JOIN, { inviteCode: room.inviteCode.toLowerCase() });
  assert.equal((await timeout(stateP)).state.room.id, room.id);
  const opened = await B.ok(MSG.ROOM_OPEN, { roomId: room.id });
  assert.equal(opened.state.members.length, 2);

  // 채팅
  const chatP = B.next((m) => m.type === MSG.MESSAGE_NEW && m.message.kind === 'chat');
  await A.ok(MSG.CHAT_SEND, { roomId: room.id, text: '안녕' });
  assert.equal((await timeout(chatP)).message.body, '안녕');

  // @claude → A 연결만 run.start
  const startP = A.next((m) => m.type === MSG.RUN_START);
  const msg = await A.ok(MSG.CHAT_SEND, { roomId: room.id, text: '@claude 하나' });
  const { runStart } = await timeout(startP);
  assert.equal(runStart.requestId, msg.id);
  assert.deepEqual(runStart.chatsSince, [{ name: 'alice', body: '안녕' }]);
  assert.equal(B.pushes.some((m) => m.type === MSG.RUN_START), false);

  // 남의 요청에는 FORBIDDEN
  const forbid = await B.req(MSG.RUN_FINISH, { requestId: msg.id, transcriptVersion: 0, transcript: 'x', sharedChanges: [] });
  assert.equal(forbid.error, 'FORBIDDEN');

  // 이벤트·승인 방송
  const evP = B.next((m) => m.type === MSG.MESSAGE_NEW && m.message.kind === 'claude_event');
  await A.ok(MSG.RUN_EVENT, { requestId: msg.id, event: { type: 'text', text: '답' } });
  assert.deepEqual(JSON.parse((await timeout(evP)).message.body), { type: 'text', text: '답' });
  const apP = B.next((m) => m.type === MSG.RUN_APPROVAL);
  await A.ok(MSG.RUN_APPROVAL, { requestId: msg.id, state: 'pending', toolName: 'Bash' });
  const ap = await timeout(apP);
  assert.deepEqual([ap.state, ap.toolName, ap.userName], ['pending', 'Bash', 'alice']);

  // finish 입력 검사, 성공
  assert.equal((await A.req(MSG.RUN_FINISH, { requestId: msg.id, transcriptVersion: 0, transcript: 5, sharedChanges: [] })).error, 'INVALID_INPUT');
  // 세션 ID 는 다른 멤버 맥의 파일 이름이 되므로 UUID 가 아니면 거부
  assert.equal((await A.req(MSG.RUN_FINISH, {
    requestId: msg.id, transcriptVersion: 0, sessionId: '../../evil', transcript: '', sharedChanges: [],
  })).error, 'INVALID_INPUT');
  const done = await A.ok(MSG.RUN_FINISH, {
    requestId: msg.id, transcriptVersion: 0, sessionId: '11111111-2222-4333-8444-555555555555', transcript: '{"t":"한글"}\n',
    sharedChanges: [{ path: 'memory/INDEX.md', contentBase64: Buffer.from('# 목차').toString('base64') }],
  });
  assert.deepEqual(done, { newVersion: 1 });
  const tr = await get(`/rooms/${room.id}/transcript`, b.token);
  assert.equal(tr.status, 200);
  assert.equal(await tr.text(), '{"t":"한글"}\n');
  const mf = await (await get(`/rooms/${room.id}/shared-manifest`, b.token)).json();
  assert.deepEqual(mf.map((x) => x.path), ['memory/INDEX.md']);
  const sh = await get(`/rooms/${room.id}/shared?path=${encodeURIComponent('memory/INDEX.md')}`, b.token);
  assert.equal(await sh.text(), '# 목차');
  assert.equal((await get(`/rooms/${room.id}/shared?path=${encodeURIComponent('../x')}`, b.token)).status, 400);
  assert.equal((await get(`/rooms/${room.id}/shared?path=no.md`, b.token)).status, 404);

  // 파일 요청 권한
  assert.equal((await get(`/rooms/${room.id}/transcript`)).status, 401);
  assert.equal((await get(`/rooms/${room.id}/transcript`, c.token)).status, 403);
  assert.equal((await get(`/rooms/9999/transcript`, c.token)).status, 404);

  // 나쁜 경로로 finish → BAD_PATH, 요청 failed(APPLY_FAILED), 대화 원본 그대로
  const req2 = await A.ok(MSG.CHAT_SEND, { roomId: room.id, text: '@claude 둘' });
  assert.equal(req2.status, 'running');
  const evil = await A.req(MSG.RUN_FINISH, {
    requestId: req2.id, transcriptVersion: 1, transcript: 'NEW',
    sharedChanges: [{ path: '../evil', contentBase64: 'eA==' }],
  });
  assert.deepEqual([evil.ok, evil.error], [false, 'BAD_PATH']);
  const after = (await B.ok(MSG.ROOM_OPEN, { roomId: room.id })).messages.find((m) => m.id === req2.id);
  assert.deepEqual([after.status, after.error], ['failed', 'APPLY_FAILED']);
  assert.equal(await (await get(`/rooms/${room.id}/transcript`, b.token)).text(), '{"t":"한글"}\n');

  // 방 삭제 → B 가 알림, 폴더 삭제
  const delP = B.next((m) => m.type === MSG.ROOM_DELETE);
  assert.equal((await B.req(MSG.ROOM_DELETE, { roomId: room.id })).error, 'FORBIDDEN');
  await A.ok(MSG.ROOM_DELETE, { roomId: room.id });
  assert.equal((await timeout(delP)).roomId, room.id);
  assert.equal(fs.existsSync(path.join(dataDir, 'rooms', String(room.id))), false);

  await A.close();
  await B.close();
});

test('request.cancel: 실행 중 요청은 요청자 연결에 run.cancel, 다음 요청이 시작된다', async () => {
  const a = await signup('cancel-a');
  const b = await signup('cancel-b');
  const A = await login(a.token);
  const B = await login(b.token);
  const room = await A.ok(MSG.ROOM_CREATE, { name: '취소' });
  await B.ok(MSG.ROOM_JOIN, { inviteCode: room.inviteCode });

  const startA = A.next((m) => m.type === MSG.RUN_START);
  const r1 = await A.ok(MSG.CHAT_SEND, { roomId: room.id, text: '@claude 하나' });
  await timeout(startA);
  const startB = B.next((m) => m.type === MSG.RUN_START);
  const r2 = await B.ok(MSG.CHAT_SEND, { roomId: room.id, text: '@claude 둘' });
  assert.equal(r2.status, 'queued');

  // 남의 실행 중 요청: 방장이 아니면 FORBIDDEN
  assert.equal((await B.req(MSG.REQUEST_CANCEL, { requestId: r1.id })).error, 'FORBIDDEN');
  const cancelP = A.next((m) => m.type === MSG.RUN_CANCEL);
  const upd = B.next((m) => m.type === MSG.MESSAGE_UPDATE && m.message.id === r1.id && m.message.status === 'cancelled');
  await A.ok(MSG.REQUEST_CANCEL, { requestId: r1.id });
  assert.equal((await timeout(cancelP)).requestId, r1.id);
  await timeout(upd);
  assert.equal((await timeout(startB)).runStart.requestId, r2.id);
  assert.equal(B.pushes.some((m) => m.type === MSG.RUN_CANCEL), false);

  // 중단된 실행의 늦은 finish 는 거부된다
  const late = await A.req(MSG.RUN_FINISH, { requestId: r1.id, transcriptVersion: 0, transcript: 'x', sharedChanges: [] });
  assert.equal(late.error, 'NOT_RUNNING');
  await A.close();
  await B.close();
});

test('member.status: 저장·방송·room.open 포함, 크기 제한, 비멤버 거부', async () => {
  const a = await signup('ms-a');
  const b = await signup('ms-b');
  const c = await signup('ms-c');
  const A = await login(a.token);
  const B = await login(b.token);
  const C = await login(c.token);
  const room = await A.ok(MSG.ROOM_CREATE, { name: '상태' });
  await B.ok(MSG.ROOM_JOIN, { inviteCode: room.inviteCode });

  const pushed = B.next((m) => m.type === MSG.MEMBER_STATUS);
  const status = { repos: ['payment-api'], readDirs: ['work'], claude: true };
  await A.ok(MSG.MEMBER_STATUS, { roomId: room.id, status });
  const m = await timeout(pushed);
  assert.deepEqual([m.roomId, m.userId, m.status], [room.id, a.user.id, status]);

  const opened = await B.ok(MSG.ROOM_OPEN, { roomId: room.id });
  assert.deepEqual(opened.memberStatus, { [a.user.id]: status });

  // 20개·100자까지만 저장
  await B.ok(MSG.MEMBER_STATUS, { roomId: room.id, status: { repos: Array.from({ length: 30 }, () => 'x'.repeat(150)), readDirs: [], claude: false } });
  const st = (await A.ok(MSG.ROOM_OPEN, { roomId: room.id })).memberStatus[b.user.id];
  assert.equal(st.repos.length, 20);
  assert.equal(st.repos[0].length, 100);

  assert.equal((await A.req(MSG.MEMBER_STATUS, { roomId: room.id, status: { repos: 'x', readDirs: [], claude: true } })).error, 'INVALID_INPUT');
  assert.equal((await C.req(MSG.MEMBER_STATUS, { roomId: room.id, status })).error, 'FORBIDDEN');
  await A.close();
  await B.close();
  await C.close();
});

test('room.settings: 방장만, 값 검증, 방 상태 방송', async () => {
  const a = await signup('set-a');
  const b = await signup('set-b');
  const A = await login(a.token);
  const B = await login(b.token);
  const room = await A.ok(MSG.ROOM_CREATE, { name: '설정' });
  await B.ok(MSG.ROOM_JOIN, { inviteCode: room.inviteCode });
  assert.deepEqual([room.defaultModel, room.defaultEffort], ['', '']);

  const pushed = B.next((m) => m.type === MSG.ROOM_STATE && m.state.room.defaultModel === 'opus');
  await A.ok(MSG.ROOM_SETTINGS, { roomId: room.id, defaultModel: 'opus', defaultEffort: 'high' });
  const st = (await timeout(pushed)).state.room;
  assert.deepEqual([st.defaultModel, st.defaultEffort], ['opus', 'high']);
  assert.equal((await B.ok(MSG.ROOM_OPEN, { roomId: room.id })).state.room.defaultEffort, 'high');

  assert.equal((await B.req(MSG.ROOM_SETTINGS, { roomId: room.id, defaultModel: 'sonnet' })).error, 'FORBIDDEN');
  for (const bad of [{ defaultModel: 'gpt-4' }, { defaultModel: 'claude-X' }, { defaultEffort: 'ultra' }, { defaultModel: 5 }]) {
    assert.equal((await A.req(MSG.ROOM_SETTINGS, { roomId: room.id, ...bad })).error, 'INVALID_INPUT', JSON.stringify(bad));
  }
  // 허용 값: 풀 모델 이름, 빈 값(= 각자 설정). 주지 않은 값은 유지
  await A.ok(MSG.ROOM_SETTINGS, { roomId: room.id, defaultModel: 'claude-opus-4-7', defaultEffort: '' });
  const now = (await A.ok(MSG.ROOM_OPEN, { roomId: room.id })).state.room;
  assert.deepEqual([now.defaultModel, now.defaultEffort], ['claude-opus-4-7', '']);
  await A.ok(MSG.ROOM_SETTINGS, { roomId: room.id, defaultEffort: 'max' });
  assert.equal((await A.ok(MSG.ROOM_OPEN, { roomId: room.id })).state.room.defaultModel, 'claude-opus-4-7');
  await A.close();
  await B.close();
});

test('GET /version: 서버 시작 때 정한 commit', async () => {
  const r = await (await fetch(`${base()}/version`)).json();
  assert.ok(r.commit === null || /^[0-9a-f]{4,}$/.test(r.commit));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rooms-ver-'));
  const s2 = await startServer({ port: 0, dataDir: dir, commit: 'abc1234' });
  try {
    assert.deepEqual(await (await fetch(`http://localhost:${s2.port}/version`)).json(), { commit: 'abc1234' });
    assert.equal(s2.running(), 0);
  } finally {
    await s2.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('shared.put: 멤버만 올리고, 반영되면 방 멤버에게 shared.changed', async () => {
  const a = await signup('sp-a');
  const b = await signup('sp-b');
  const c = await signup('sp-c');
  const A = await login(a.token);
  const B = await login(b.token);
  const C = await login(c.token);
  const room = await A.ok(MSG.ROOM_CREATE, { name: '공유' });
  await B.ok(MSG.ROOM_JOIN, { inviteCode: room.inviteCode });
  const b64 = (s) => Buffer.from(s).toString('base64');

  const changed = B.next((m) => m.type === MSG.SHARED_CHANGED);
  const r = await A.ok(MSG.SHARED_PUT, { roomId: room.id, changes: [{ path: 'outputs/a.md', baseSha: null, contentBase64: b64('hi') }] });
  assert.deepEqual(r, { applied: ['outputs/a.md'], conflicts: [] });
  assert.deepEqual([(await timeout(changed)).roomId], [room.id]);
  assert.equal(await (await get(`/rooms/${room.id}/shared?path=outputs/a.md`, b.token)).text(), 'hi');

  assert.equal((await C.req(MSG.SHARED_PUT, { roomId: room.id, changes: [{ path: 'x.md', baseSha: null, contentBase64: b64('x') }] })).error, 'FORBIDDEN');
  assert.equal((await A.req(MSG.SHARED_PUT, { roomId: room.id, changes: [{ path: 'x.md', baseSha: 1, contentBase64: 'x' }] })).error, 'INVALID_INPUT');
  assert.equal((await A.req(MSG.SHARED_PUT, { roomId: room.id, changes: [] })).error, 'INVALID_INPUT');
  await Promise.all([A.close(), B.close(), C.close()]);
});

test('방 상태에 컨텍스트 크기: 실행이 끝나면 모두에게 같은 값', async () => {
  const a = await signup('ctx-a');
  const b = await signup('ctx-b');
  const A = await login(a.token);
  const B = await login(b.token);
  const room = await A.ok(MSG.ROOM_CREATE, { name: '컨텍스트' });
  await B.ok(MSG.ROOM_JOIN, { inviteCode: room.inviteCode });
  assert.equal((await B.ok(MSG.ROOM_OPEN, { roomId: room.id })).state.context, null);

  const startP = A.next((m) => m.type === MSG.RUN_START);
  const msg = await A.ok(MSG.CHAT_SEND, { roomId: room.id, text: '@claude 해 줘' });
  await timeout(startP);
  const stateP = B.next((m) => m.type === MSG.ROOM_STATE && m.state.room.id === room.id && m.state.context);
  const transcript = `${JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-5-5', usage: { input_tokens: 3, cache_read_input_tokens: 120000, output_tokens: 97 } } })}\n`;
  await A.ok(MSG.RUN_FINISH, { requestId: msg.id, transcriptVersion: 0, sessionId: '11111111-2222-4333-8444-555555555555', transcript, sharedChanges: [] });
  assert.deepEqual((await timeout(stateP)).state.context, { tokens: 120100, model: 'claude-opus-5-5' });
  assert.deepEqual((await A.ok(MSG.ROOM_OPEN, { roomId: room.id })).state.context, { tokens: 120100, model: 'claude-opus-5-5' });
  await Promise.all([A.close(), B.close()]);
});

test('실행이 끝날 때 branchChanges: 요청자만, 이 방 레포·올바른 이름만, 방장이 아니어도 반영되고 모두에게 방송', async () => {
  const a = await signup('br-a');
  const b = await signup('br-b');
  const A = await login(a.token);
  const B = await login(b.token);
  const room = await A.ok(MSG.ROOM_CREATE, { name: '브랜치' });
  const other = await A.ok(MSG.ROOM_CREATE, { name: '다른 방' });
  await B.ok(MSG.ROOM_JOIN, { inviteCode: room.inviteCode });
  const repo = await A.ok(MSG.REPO_ADD, { roomId: room.id, name: 'r', remoteUrl: 'git@h:a/r.git', branch: 'develop' });
  const foreign = await A.ok(MSG.REPO_ADD, { roomId: other.id, name: 'x', remoteUrl: 'git@h:a/x.git', branch: 'main' });

  const startP = B.next((m) => m.type === MSG.RUN_START);
  const msg = await B.ok(MSG.CHAT_SEND, { roomId: room.id, text: '@claude 브랜치 옮겨' });
  await timeout(startP);
  const sid = '11111111-2222-4333-8444-555555555555';
  const fin = (who, branchChanges, extra = {}) => who.req(MSG.RUN_FINISH, {
    requestId: msg.id, transcriptVersion: 0, sessionId: sid, transcript: '', sharedChanges: [], branchChanges, ...extra,
  });
  const branchOf = async () => (await A.ok(MSG.ROOM_OPEN, { roomId: room.id })).state.repos[0].branch;

  // 요청자가 아니면(방장이어도) FORBIDDEN
  assert.equal((await fin(A, [{ repoId: repo.id, branch: 'feature/X' }])).error, 'FORBIDDEN');
  // 잘못된 값은 INVALID_INPUT, 아무것도 바뀌지 않고 요청은 계속 실행 중
  for (const bad of ['x', {}, [{ repoId: foreign.id, branch: 'feature/X' }], [{ repoId: 999, branch: 'feature/X' }],
    [{ repoId: repo.id, branch: '' }], [{ repoId: repo.id, branch: '-x' }], [{ repoId: repo.id, branch: 5 }], [null],
    [{ repoId: repo.id, branch: 'ok' }, { repoId: foreign.id, branch: 'no' }]]) {
    assert.equal((await fin(B, bad)).error, 'INVALID_INPUT', JSON.stringify(bad));
  }
  assert.equal(await branchOf(), 'develop');

  // 정상: 방장 아닌 요청자도 바꾸고, 방 전원이 상태를 받는다
  const aState = A.next((m) => m.type === MSG.ROOM_STATE && m.state.repos[0]?.branch === 'feature/X');
  const bState = B.next((m) => m.type === MSG.ROOM_STATE && m.state.repos[0]?.branch === 'feature/X');
  assert.deepEqual(await B.ok(MSG.RUN_FINISH, {
    requestId: msg.id, transcriptVersion: 0, sessionId: sid, transcript: '', sharedChanges: [], branchChanges: [{ repoId: repo.id, branch: ' feature/X ' }],
  }), { newVersion: 1 });
  await timeout(aState);
  await timeout(bState);
  assert.equal(await branchOf(), 'feature/X');
  assert.equal((await A.ok(MSG.ROOM_OPEN, { roomId: other.id })).state.repos[0].branch, 'main'); // 다른 방은 그대로

  // 보내지 않아도(옛 앱) 된다. 화면의 레포 [수정]은 여전히 방장만
  const start2 = B.next((m) => m.type === MSG.RUN_START);
  const m2 = await B.ok(MSG.CHAT_SEND, { roomId: room.id, text: '@claude 하나 더' });
  await timeout(start2);
  await B.ok(MSG.RUN_FINISH, { requestId: m2.id, transcriptVersion: 1, transcript: '', sharedChanges: [] });
  assert.equal((await B.req(MSG.REPO_UPDATE, { repoId: repo.id, branch: 'y' })).error, 'FORBIDDEN');
  await Promise.all([A.close(), B.close()]);
});

const SID1 = '11111111-2222-4333-8444-555555555555';
const SID2 = '99999999-2222-4333-8444-555555555555';

test('공개 방: 목록에 보이고 바로 참가, 비공개는 거부, 목록이 바뀌면 모두에게 rooms.changed', async () => {
  const a = await signup('pub-a');
  const b = await signup('pub-b');
  const A = await login(a.token);
  const B = await login(b.token);
  const isChanged = (m) => m.type === MSG.ROOMS_CHANGED;

  const created = B.next(isChanged);
  const room = await A.ok(MSG.ROOM_CREATE, { name: '열린 방' });
  await timeout(created);
  assert.equal(room.isPublic, true);
  let pub = (await B.ok(MSG.ROOM_LIST)).publicRooms.filter((r) => r.id === room.id);
  assert.deepEqual(pub, [{ id: room.id, name: '열린 방', memberCount: 1, createdAt: room.createdAt }]);
  assert.equal((await A.ok(MSG.ROOM_LIST)).publicRooms.some((r) => r.id === room.id), false);

  // 비공개로 바꾸면 목록에서 사라지고 공개 참가는 FORBIDDEN, 방장 아니면 못 바꿈
  assert.equal((await B.req(MSG.ROOM_SETTINGS, { roomId: room.id, isPublic: false })).error, 'FORBIDDEN');
  const toggled = B.next(isChanged);
  await A.ok(MSG.ROOM_SETTINGS, { roomId: room.id, isPublic: false });
  await timeout(toggled);
  assert.equal((await B.ok(MSG.ROOM_LIST)).publicRooms.some((r) => r.id === room.id), false);
  assert.equal((await B.req(MSG.ROOM_JOIN_PUBLIC, { roomId: room.id })).error, 'FORBIDDEN');

  // 다시 공개 → 참가 → 방장에게 상태 방송, 이미 멤버여도 성공
  const back = B.next(isChanged);
  await A.ok(MSG.ROOM_SETTINGS, { roomId: room.id, isPublic: true });
  await timeout(back);
  const stateP = A.next((m) => m.type === MSG.ROOM_STATE && m.state.members.length === 2);
  assert.equal((await B.ok(MSG.ROOM_JOIN_PUBLIC, { roomId: room.id })).id, room.id);
  await timeout(stateP);
  await B.ok(MSG.ROOM_JOIN_PUBLIC, { roomId: room.id });
  assert.equal((await B.ok(MSG.ROOM_LIST)).rooms.some((r) => r.id === room.id), true);
  assert.equal((await B.ok(MSG.ROOM_LIST)).publicRooms.some((r) => r.id === room.id), false);

  // 방 삭제도 알린다
  const c = await signup('pub-c');
  const C = await login(c.token);
  const deleted = C.next(isChanged);
  await A.ok(MSG.ROOM_DELETE, { roomId: room.id });
  await timeout(deleted);
  await Promise.all([A.close(), B.close(), C.close()]);
});

test('room.fork: 멤버만, 복사·방장·안내, 첫 실행은 fork 로 이어 받고 끝나면 새 세션', async () => {
  const a = await signup('fork-a');
  const b = await signup('fork-b');
  const c = await signup('fork-c');
  const A = await login(a.token);
  const B = await login(b.token);
  const C = await login(c.token);
  const room = await A.ok(MSG.ROOM_CREATE, { name: '원래 방' });
  await B.ok(MSG.ROOM_JOIN, { inviteCode: room.inviteCode });
  await A.ok(MSG.REPO_ADD, { roomId: room.id, name: 'r', remoteUrl: 'git@h:a/r.git', branch: 'dev' });
  await A.ok(MSG.ROOM_SETTINGS, { roomId: room.id, defaultModel: 'sonnet', defaultEffort: 'low' });

  // 원래 방에서 한 번 실행해 세션·대화 원본·공유 파일을 만든다
  const startP = A.next((m) => m.type === MSG.RUN_START);
  const msg = await A.ok(MSG.CHAT_SEND, { roomId: room.id, text: '@claude 기억해' });
  assert.equal((await timeout(startP)).runStart.fork, false);
  await A.ok(MSG.RUN_FINISH, {
    requestId: msg.id, transcriptVersion: 0, sessionId: SID1, transcript: '{"t":"원본"}\n',
    sharedChanges: [{ path: 'memory/INDEX.md', contentBase64: Buffer.from('# 목차').toString('base64') }],
  });

  assert.equal((await C.req(MSG.ROOM_FORK, { roomId: room.id, name: '갈래' })).error, 'FORBIDDEN');
  assert.equal((await B.req(MSG.ROOM_FORK, { roomId: room.id, name: ' ' })).error, 'INVALID_INPUT');
  const changed = C.next((m) => m.type === MSG.ROOMS_CHANGED);
  const f = await B.ok(MSG.ROOM_FORK, { roomId: room.id, name: '갈래' });
  await timeout(changed);
  assert.deepEqual([f.name, f.ownerId, f.isPublic, f.defaultModel, f.defaultEffort, f.claudeSessionId, f.transcriptVersion],
    ['갈래', b.user.id, true, 'sonnet', 'low', SID1, 1]);

  // 새 방 멤버 둘 모두 목록에 있고, 대화 원본·공유 파일이 복사됨, 안내 한 줄뿐
  assert.equal((await A.ok(MSG.ROOM_LIST)).rooms.some((r) => r.id === f.id), true);
  const opened = await A.ok(MSG.ROOM_OPEN, { roomId: f.id });
  assert.deepEqual(opened.state.repos.map((r) => [r.name, r.branch]), [['r', 'dev']]);
  assert.deepEqual(opened.state.members.map((m) => [m.name, m.isOwner]), [['fork-a', false], ['fork-b', true]]);
  assert.deepEqual(opened.messages.map((m) => [m.kind, m.body]), [['notice', '원래 방 방에서 갈라졌어요']]);
  assert.equal(await (await get(`/rooms/${f.id}/transcript`, a.token)).text(), '{"t":"원본"}\n');
  assert.equal(await (await get(`/rooms/${f.id}/shared?path=memory%2FINDEX.md`, a.token)).text(), '# 목차');

  // 첫 실행은 fork: true + 원래 세션, 끝나면 새 세션으로 바뀌고 다음 실행은 fork 아님
  const s2 = B.next((m) => m.type === MSG.RUN_START);
  const r1 = await B.ok(MSG.CHAT_SEND, { roomId: f.id, text: '@claude 이어서' });
  const rs1 = (await timeout(s2)).runStart;
  assert.deepEqual([rs1.fork, rs1.sessionId], [true, SID1]);
  await B.ok(MSG.RUN_FINISH, { requestId: r1.id, transcriptVersion: 1, sessionId: SID2, transcript: '{"t":"갈래"}\n', sharedChanges: [] });
  const s3 = B.next((m) => m.type === MSG.RUN_START);
  const r2 = await B.ok(MSG.CHAT_SEND, { roomId: f.id, text: '@claude 또' });
  const rs2 = (await timeout(s3)).runStart;
  assert.deepEqual([rs2.fork, rs2.sessionId], [false, SID2]);
  await B.ok(MSG.RUN_FAIL, { requestId: r2.id, reason: 'X' });

  // 두 방은 서로 영향 없음: 원래 방 대화 원본·세션 그대로
  assert.equal(await (await get(`/rooms/${room.id}/transcript`, a.token)).text(), '{"t":"원본"}\n');
  assert.equal((await A.ok(MSG.ROOM_OPEN, { roomId: room.id })).state.room.claudeSessionId, SID1);
  await Promise.all([A.close(), B.close(), C.close()]);
});

test('room.fork: 실행이 실패하면 fork 가 유지되고, 세션 없는 방은 fork 아님', async () => {
  const a = await signup('fork2-a');
  const A = await login(a.token);
  const room = await A.ok(MSG.ROOM_CREATE, { name: '빈 방' });
  const empty = await A.ok(MSG.ROOM_FORK, { roomId: room.id, name: '빈 갈래' });
  const s0 = A.next((m) => m.type === MSG.RUN_START);
  const q0 = await A.ok(MSG.CHAT_SEND, { roomId: empty.id, text: '@claude 해' });
  const rs0 = (await timeout(s0)).runStart;
  assert.deepEqual([rs0.fork, rs0.sessionId], [false, null]);
  await A.ok(MSG.RUN_FAIL, { requestId: q0.id, reason: 'X' });

  const startP = A.next((m) => m.type === MSG.RUN_START);
  const msg = await A.ok(MSG.CHAT_SEND, { roomId: room.id, text: '@claude 하나' });
  await timeout(startP);
  await A.ok(MSG.RUN_FINISH, { requestId: msg.id, transcriptVersion: 0, sessionId: SID1, transcript: 'T\n', sharedChanges: [] });
  const f = await A.ok(MSG.ROOM_FORK, { roomId: room.id, name: '갈래' });
  const s1 = A.next((m) => m.type === MSG.RUN_START);
  const r1 = await A.ok(MSG.CHAT_SEND, { roomId: f.id, text: '@claude 실패할 것' });
  assert.equal((await timeout(s1)).runStart.fork, true);
  const s2 = A.next((m) => m.type === MSG.RUN_START);
  await A.ok(MSG.RUN_FAIL, { requestId: r1.id, reason: 'CLAUDE_EXIT_1' });
  await A.ok(MSG.REQUEST_RETRY, { requestId: r1.id });
  const rs = (await timeout(s2)).runStart;
  assert.deepEqual([rs.fork, rs.sessionId], [true, SID1]);
  await A.close();
});
