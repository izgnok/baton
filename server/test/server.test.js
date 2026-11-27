import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
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

// ── 공유 사본(코드 상태) ──
const H1 = '1'.repeat(40);
const H2 = '2'.repeat(40);
const bundleOf = (s) => Buffer.from(`# v2 git bundle\n${s}`);
const upload = (token, roomId, requestId, body) => fetch(`${base()}/rooms/${roomId}/code-upload?requestId=${requestId}`, {
  method: 'PUT', headers: { authorization: `Bearer ${token}` }, body,
});
const partFileOf = (roomId, repoId, seq = 1) => path.join(dataDir, 'rooms', String(roomId), 'code', `${repoId}-${seq}.bundle`);
const uploadsOf = (roomId, dir = dataDir) => {
  try { return fs.readdirSync(path.join(dir, 'rooms', String(roomId), 'code')).filter((n) => n.startsWith('.upload-')); } catch { return []; }
};

// A(방장)·B 가 있는 방과, 요청자를 정해 실행을 시작·끝내는 도우미
async function codeRoom(prefix) {
  const a = await signup(`${prefix}-a`);
  const b = await signup(`${prefix}-b`);
  const c = await signup(`${prefix}-c`);
  const A = await login(a.token);
  const B = await login(b.token);
  const room = await A.ok(MSG.ROOM_CREATE, { name: '코드' });
  await B.ok(MSG.ROOM_JOIN, { inviteCode: room.inviteCode });
  A.token = a.token;
  B.token = b.token;
  const ctx = { a, b, c, A, B, room, version: 0 };
  // 조각을 HTTP 로 올리고 RUN_FINISH 의 codeStates 항목을 돌려준다
  // prev: 이어 붙일 이전 스냅샷(null 이면 체인을 새로 시작)
  ctx.entry = async (who, requestId, repoId, baseBranch, buf, { prev = null, snapshot = H2 } = {}) => {
    const r = await upload(who.token, room.id, requestId, buf);
    assert.equal(r.status, 200);
    return { repoId, baseBranch, baseCommit: H1, snapshot, prevSnapshot: prev, uploadId: (await r.json()).uploadId };
  };
  ctx.run = async (who) => {
    const p = who.next((m) => m.type === MSG.RUN_START);
    const msg = await who.ok(MSG.CHAT_SEND, { roomId: room.id, text: '@claude 하나' });
    await timeout(p);
    return msg.id;
  };
  ctx.finish = (who, requestId, extra = {}) => who.req(MSG.RUN_FINISH, {
    requestId, transcriptVersion: ctx.version, transcript: '', sharedChanges: [], ...extra,
  });
  ctx.finishOk = async (who, requestId, extra) => {
    const r = await who.req(MSG.RUN_FINISH, { requestId, transcriptVersion: ctx.version, transcript: '', sharedChanges: [], ...extra });
    assert.equal(r.ok, true, r.error);
    ctx.version += 1;
  };
  ctx.repos = async () => (await A.ok(MSG.ROOM_OPEN, { roomId: room.id })).state.repos;
  return ctx;
}

test('room.repo_set·room.repo_remove: 실행 중 요청의 요청자만(방장도 남의 요청은 안 됨), 추가·수정·검사·같은 원격 두 번', async () => {
  const { A, B, room, run, finishOk, repos } = await codeRoom('rs');
  const id = await run(B); // 방장이 아닌 B 의 요청
  const set = (who, p, requestId = id) => who.req(MSG.ROOM_REPO_SET, { requestId, ...p });
  const url = 'git@h:a/insight.git';

  // 요청자가 아니면(방장이어도) FORBIDDEN, 없는 요청도 FORBIDDEN
  assert.equal((await set(A, { remoteUrl: url, baseBranch: 'dev' })).error, 'FORBIDDEN');
  assert.equal((await set(B, { remoteUrl: url, baseBranch: 'dev' }, 99999)).error, 'FORBIDDEN');
  assert.deepEqual(await repos(), []);

  // 추가: 이름 기본값, 브랜치 3개, 별칭 branch, 방 전원에게 상태 방송
  const aState = A.next((m) => m.type === MSG.ROOM_STATE && m.state.repos.length === 1);
  const one = await B.ok(MSG.ROOM_REPO_SET, { requestId: id, remoteUrl: url, baseBranch: ' release/15.7.0 ', workBranch: 'feature/X' });
  await timeout(aState);
  assert.deepEqual([one.name, one.baseBranch, one.workBranch, one.originBranch, one.branch, one.code],
    ['insight', 'release/15.7.0', 'feature/X', 'release/15.7.0', 'release/15.7.0', null]);
  // 같은 원격을 다른 기준으로 한 번 더 추가할 수 있다, 작업 브랜치는 빈 문자열 허용
  const two = await B.ok(MSG.ROOM_REPO_SET, { requestId: id, remoteUrl: url, name: 'insight-dev', baseBranch: 'develop', workBranch: '' });
  assert.deepEqual([two.id !== one.id, two.name, two.workBranch], [true, 'insight-dev', '']);

  // 검사: 이름·브랜치 규칙, 다른 방 레포
  const other = await A.ok(MSG.ROOM_CREATE, { name: '다른 방' });
  const foreign = await A.ok(MSG.REPO_ADD, { roomId: other.id, name: 'x', remoteUrl: 'u', branch: 'main' });
  for (const p of [{ remoteUrl: url, baseBranch: '-x' }, { remoteUrl: url, baseBranch: ' ' }, { remoteUrl: '', baseBranch: 'b' },
    { remoteUrl: url, baseBranch: 'b', workBranch: '-y' }, { remoteUrl: url, baseBranch: 'b', name: ' ' },
    { remoteUrl: url, baseBranch: 'b', repoId: foreign.id }, { remoteUrl: url, baseBranch: 'b', repoId: 999 }]) {
    assert.equal((await set(B, p)).error, 'INVALID_INPUT', JSON.stringify(p));
  }
  assert.equal((await repos()).length, 2);

  // 수정: 기준이 같고 작업 브랜치만 바꾸기
  const upd = await B.ok(MSG.ROOM_REPO_SET, { requestId: id, repoId: two.id, remoteUrl: url, baseBranch: 'develop', workBranch: 'feature/Z' });
  assert.deepEqual([upd.id, upd.name, upd.workBranch], [two.id, 'insight-dev', 'feature/Z']);

  // 빼기: 요청자만, 이 방 레포만
  assert.equal((await A.req(MSG.ROOM_REPO_REMOVE, { requestId: id, repoId: two.id })).error, 'FORBIDDEN');
  assert.equal((await B.req(MSG.ROOM_REPO_REMOVE, { requestId: id, repoId: foreign.id })).error, 'INVALID_INPUT');
  await B.ok(MSG.ROOM_REPO_REMOVE, { requestId: id, repoId: two.id });
  assert.deepEqual((await repos()).map((r) => r.id), [one.id]);

  // 실행이 끝난 요청으로는 바꿀 수 없다
  await finishOk(B, id, {});
  assert.equal((await set(B, { remoteUrl: url, baseBranch: 'dev' })).error, 'FORBIDDEN');
  assert.equal((await B.req(MSG.ROOM_REPO_REMOVE, { requestId: id, repoId: one.id })).error, 'FORBIDDEN');
  assert.equal((await repos()).length, 1);
  await Promise.all([A.close(), B.close()]);
});

test('RUN_FINISH codeStates: 조각 체인(이어 붙이기·새로 시작·어긋남 건너뜀·비우기), 목록·조각 받기, CODE_CHANGED 방송', async () => {
  const { a, b, c, A, B, room, run, finishOk, repos, entry } = await codeRoom('cs');
  const id0 = await run(A);
  const repo = await A.ok(MSG.ROOM_REPO_SET, { requestId: id0, remoteUrl: 'git@h:a/r.git', baseBranch: 'develop', workBranch: 'feature/X' });
  const bin = Buffer.concat([bundleOf(''), Buffer.from([0, 1, 2, 255, 254])]);
  const base = `/rooms/${room.id}/code/${repo.id}`;
  const parts = async (token = b.token) => (await (await get(base, token)).json()).parts;
  const H3 = '3'.repeat(64);
  const H4 = '4'.repeat(40);

  // 올리기 전엔 빈 목록(200), 조각 하나는 404
  const empty = await get(base, b.token);
  assert.deepEqual([empty.status, await empty.json()], [200, { parts: [] }]);
  assert.equal((await get(`${base}/1`, b.token)).status, 404);

  // seq 1: prev null
  const bChanged = B.next((m) => m.type === MSG.CODE_CHANGED);
  await finishOk(A, id0, { codeStates: [await entry(A, id0, repo.id, 'develop', bin)] });
  assert.deepEqual(await timeout(bChanged), { type: MSG.CODE_CHANGED, roomId: room.id, repoId: repo.id, userId: a.user.id });
  let [r] = await repos();
  assert.deepEqual(r.code, { baseCommit: H1, snapshot: H2, size: bin.length, parts: 1, updatedBy: a.user.id, updatedAt: r.code.updatedAt });
  assert.deepEqual(await parts(), [{ seq: 1, prevSnapshot: null, snapshot: H2, baseCommit: H1, size: bin.length }]);
  const got = await get(`${base}/1`, b.token);
  assert.deepEqual([got.status, got.headers.get('content-type'), Number(got.headers.get('content-length'))], [200, 'application/octet-stream', bin.length]);
  assert.deepEqual(Buffer.from(await got.arrayBuffer()), bin);

  // 다른 멤버의 다음 실행이 이어 붙인다(prev = 서버의 snapshot, 스냅샷 64자리도 허용): seq 2, 크기는 체인 합
  const id1 = await run(B);
  const next = bundleOf('second');
  await finishOk(B, id1, { codeStates: [await entry(B, id1, repo.id, 'develop', next, { prev: H2, snapshot: H3 })] });
  [r] = await repos();
  assert.deepEqual([r.code.snapshot, r.code.size, r.code.parts, r.code.updatedBy], [H3, bin.length + next.length, 2, b.user.id]);
  assert.deepEqual((await parts(a.token)).map((p) => [p.seq, p.prevSnapshot, p.snapshot, p.size]), [[1, null, H2, bin.length], [2, H2, H3, next.length]]);
  assert.deepEqual(Buffer.from(await (await get(`${base}/2`, a.token)).arrayBuffer()), next);
  assert.deepEqual(Buffer.from(await (await get(`${base}/1`, a.token)).arrayBuffer()), bin); // 앞 조각은 그대로
  assert.equal((await get(`${base}/3`, a.token)).status, 404);

  // 어긋난 prev(서버 snapshot 이 아님)는 그 항목만 건너뛰고 임시 파일도 지운다
  const id2 = await run(A);
  B.pushes.length = 0;
  await finishOk(A, id2, { codeStates: [await entry(A, id2, repo.id, 'develop', bundleOf('stale'), { prev: H2, snapshot: H4 })] });
  [r] = await repos();
  assert.deepEqual([r.code.snapshot, r.code.parts], [H3, 2]);
  assert.equal((await get(`${base}/3`, a.token)).status, 404);
  assert.deepEqual(uploadsOf(room.id), []);
  assert.equal(B.pushes.some((m) => m.type === MSG.CODE_CHANGED), false);

  // prev null 이면 옛 체인을 모두 지우고 seq 1 로 새로 시작
  const id3 = await run(A);
  const fresh = bundleOf('fresh');
  await finishOk(A, id3, { codeStates: [await entry(A, id3, repo.id, 'develop', fresh, { snapshot: H4 })] });
  [r] = await repos();
  assert.deepEqual([r.code.snapshot, r.code.size, r.code.parts], [H4, fresh.length, 1]);
  assert.deepEqual((await parts()).map((p) => [p.seq, p.prevSnapshot, p.snapshot]), [[1, null, H4]]);
  assert.deepEqual(Buffer.from(await (await get(`${base}/1`, b.token)).arrayBuffer()), fresh);
  assert.equal(fs.existsSync(partFileOf(room.id, repo.id, 2)), false);
  assert.equal((await get(`${base}/2`, b.token)).status, 404);

  // 비우기: 체인 전체(행·파일) 삭제, 기준 브랜치는 그대로
  const id4 = await run(A);
  await finishOk(A, id4, { codeStates: [await entry(A, id4, repo.id, 'develop', bundleOf('t'), { prev: H4, snapshot: H3 })] });
  assert.equal((await repos())[0].code.parts, 2);
  const id5 = await run(A);
  const cleared = B.next((m) => m.type === MSG.CODE_CHANGED);
  await finishOk(A, id5, { codeStates: [{ repoId: repo.id, baseBranch: 'develop', snapshot: null, uploadId: null }] });
  await timeout(cleared);
  [r] = await repos();
  assert.deepEqual([r.code, r.baseBranch], [null, 'develop']);
  assert.deepEqual(await parts(), []);
  assert.deepEqual([1, 2].map((n) => fs.existsSync(partFileOf(room.id, repo.id, n))), [false, false]);

  // HTTP: 로그인 없음 401, 비멤버 403, 다른 방 레포 404(목록·조각 모두), 숫자 아닌 seq 는 라우트 없음
  assert.equal((await get(base, undefined)).status, 401);
  assert.equal((await get(base, c.token)).status, 403);
  assert.equal((await get(`${base}/1`, c.token)).status, 403);
  const other = await A.ok(MSG.ROOM_CREATE, { name: '다른 방' });
  const foreign = await A.ok(MSG.REPO_ADD, { roomId: other.id, name: 'x', remoteUrl: 'u', branch: 'main' });
  for (const p of [`/rooms/${room.id}/code/${foreign.id}`, `/rooms/${room.id}/code/${foreign.id}/1`, `/rooms/${room.id}/code/9999`,
    `/rooms/${room.id}/code/${repo.id}/x`]) {
    const nf = await get(p, a.token);
    assert.deepEqual([nf.status, (await nf.json()).error], [404, 'NOT_FOUND'], p);
  }
  await Promise.all([A.close(), B.close()]);
});

test('RUN_FINISH codeStates 입력 검사: 잘못된 값·없는 uploadId 는 INVALID_INPUT, 묶음은 그대로이고 요청은 계속 실행 중', async () => {
  const { A, B, room, run, finish, finishOk, repos, entry } = await codeRoom('cv');
  const id = await run(A);
  const repo = await A.ok(MSG.ROOM_REPO_SET, { requestId: id, remoteUrl: 'u', baseBranch: 'develop' });
  const good = await entry(A, id, repo.id, 'develop', bundleOf('x'));
  const dup = { ...good, repoId: repo.id };
  for (const bad of ['x', {}, [null], [{ ...good, repoId: 'a' }], [{ ...good, baseCommit: 'zz' }], [{ ...good, snapshot: '12' }],
    [{ ...good, uploadId: 7 }], [{ ...good, uploadId: '../../x' }], [{ ...good, uploadId: 'abc' }],
    [{ ...good, uploadId: 'f'.repeat(32) }], // 형식은 맞지만 올라온 적 없음
    [{ ...good, prevSnapshot: undefined }], [{ ...good, prevSnapshot: 'zz' }], [{ ...good, prevSnapshot: 5 }],
    [{ ...good, snapshot: null }], [{ ...good, uploadId: null }], [good, dup], // 같은 uploadId 두 번
    [good, { ...good, repoId: 'a' }]]) { // 앞 항목이 좋아도 하나라도 나쁘면 아무것도 안 옮긴다
    assert.equal((await finish(A, id, { codeStates: bad })).error, 'INVALID_INPUT', JSON.stringify(bad));
  }
  assert.equal((await finish(A, id, { promotedRepoIds: ['1'] })).error, 'INVALID_INPUT');
  assert.equal((await finish(A, id, { promotedRepoIds: 'x' })).error, 'INVALID_INPUT');
  assert.equal(fs.existsSync(partFileOf(room.id, repo.id)), false);
  assert.equal((await repos())[0].code, null);
  assert.equal(uploadsOf(room.id).length, 1); // 올린 파일은 아직 그대로

  // 실패한 뒤에도 요청은 실행 중이라 올려 둔 묶음으로 끝낼 수 있다
  await finishOk(A, id, { codeStates: [good] });
  assert.equal((await repos())[0].code.size, bundleOf('x').length);
  assert.deepEqual(uploadsOf(room.id), []); // 묶음 파일로 옮겨져 임시 파일은 없다
  await Promise.all([A.close(), B.close()]);
});

test('PUT code-upload: 요청자·실행 중·그 요청의 방만 허용, 헤더가 git bundle 이 아니면 400, 끊기면 임시 파일 없음', async () => {
  const { a, b, c, A, B, room, run, finishOk } = await codeRoom('cu');
  const idB = await run(B); // 방장이 아닌 B 의 요청
  const other = await A.ok(MSG.ROOM_CREATE, { name: '다른 방' });
  const ok = bundleOf('ok');
  // 인증 없음 401, 요청자가 아니면(방장이어도·비멤버여도) 403, 없는/잘못된 requestId 도 403, 다른 방 id 도 403
  assert.equal((await fetch(`${base()}/rooms/${room.id}/code-upload?requestId=${idB}`, { method: 'PUT', body: ok })).status, 401);
  for (const [tok, rid, rm] of [[a.token, idB, room.id], [c.token, idB, room.id], [b.token, 999999, room.id], [b.token, 'x', room.id],
    [b.token, undefined, room.id], [b.token, idB, other.id], [b.token, idB, 999999]]) {
    const r = await upload(tok, rm, rid, ok);
    assert.deepEqual([r.status, (await r.json()).error], [403, 'FORBIDDEN'], JSON.stringify([rid, rm]));
  }
  assert.deepEqual(uploadsOf(room.id), []);
  // 앞부분이 git bundle 이 아니면 400, 빈 본문도 400, 파일은 남지 않는다
  for (const body of [Buffer.from('PACK....'), Buffer.alloc(0), Buffer.from('# v1 git bundle\n')]) {
    const r = await upload(b.token, room.id, idB, body);
    assert.deepEqual([r.status, (await r.json()).error], [400, 'INVALID_INPUT']);
  }
  assert.deepEqual(uploadsOf(room.id), []);
  // v3 헤더·이진 본문은 그대로 받는다(응답 uploadId 는 16~64자 hex)
  const bin = Buffer.concat([Buffer.from('# v3 git bundle\n'), Buffer.from([0, 255, 13, 10, 7])]);
  const good = await upload(b.token, room.id, idB, bin);
  const { uploadId, size } = await good.json();
  assert.deepEqual([good.status, size, /^[0-9a-f]{16,64}$/.test(uploadId)], [200, bin.length, true]);
  assert.deepEqual(fs.readFileSync(path.join(dataDir, 'rooms', String(room.id), 'code', `.upload-${uploadId}`)), bin);

  // 올리다 끊기면 임시 파일이 남지 않는다
  await new Promise((resolve) => {
    const req = http.request(`${base()}/rooms/${room.id}/code-upload?requestId=${idB}`, {
      method: 'PUT', headers: { authorization: `Bearer ${b.token}`, 'content-length': '1000' },
    });
    req.on('error', () => {});
    req.write('# v2 git bundle\n');
    setTimeout(() => { req.destroy(); setTimeout(resolve, 200); }, 100);
  });
  assert.deepEqual(uploadsOf(room.id), [`.upload-${uploadId}`]); // 끊긴 업로드 것은 없고 앞서 성공한 것만

  // 실행이 끝난 요청으로는 올릴 수 없다
  await finishOk(B, idB, {});
  const late = await upload(b.token, room.id, idB, ok);
  assert.deepEqual([late.status, (await late.json()).error], [403, 'FORBIDDEN']);
  await Promise.all([A.close(), B.close()]);
});

test('PUT code-upload: 상한(maxBundle)을 넘으면 413 BUNDLE_TOO_BIG·임시 파일 삭제, 상한 이하는 통과', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rooms-small-'));
  const small = await startServer({ port: 0, dataDir: dir, maxBundle: 64 });
  const main = srv;
  srv = small;
  try {
    const { A, B, room, run } = await codeRoom('cb');
    const id = await run(A);
    const head = '# v2 git bundle\n'; // 16자
    const big = await upload(A.token, room.id, id, Buffer.from(head + 'x'.repeat(49))); // 65자
    assert.deepEqual([big.status, (await big.json()).error], [413, 'BUNDLE_TOO_BIG']);
    assert.deepEqual(uploadsOf(room.id, dir), []);
    // Content-Length 없이(chunked) 올려도 읽으면서 상한을 넘는 순간 413
    const status = await new Promise((resolve) => {
      const req = http.request(`${base()}/rooms/${room.id}/code-upload?requestId=${id}`, {
        method: 'PUT', headers: { authorization: `Bearer ${A.token}` },
      }, (res) => { res.resume(); resolve(res.statusCode); });
      req.on('error', () => resolve('error'));
      req.end(Buffer.from(head + 'x'.repeat(49)));
    });
    assert.equal(status, 413);
    assert.deepEqual(uploadsOf(room.id, dir), []);
    const edge = await upload(A.token, room.id, id, Buffer.from(head + 'x'.repeat(48))); // 딱 64자
    assert.equal(edge.status, 200);
    await Promise.all([A.close(), B.close()]);
  } finally {
    srv = main;
    await small.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('서버를 시작하면 모든 방의 남은 임시 업로드 파일(.upload-*)을 지우고 묶음 파일은 둔다', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rooms-purge-'));
  try {
    for (const r of [1, 2]) {
      fs.mkdirSync(path.join(dir, 'rooms', String(r), 'code'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'rooms', String(r), 'code', '.upload-' + 'a'.repeat(32)), 'x');
      fs.writeFileSync(path.join(dir, 'rooms', String(r), 'code', '7.bundle'), 'keep');
    }
    const s2 = await startServer({ port: 0, dataDir: dir });
    await s2.close();
    assert.deepEqual([uploadsOf(1, dir), uploadsOf(2, dir)], [[], []]);
    assert.equal(fs.readFileSync(path.join(dir, 'rooms', '2', 'code', '7.bundle'), 'utf8'), 'keep');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('RUN_FINISH codeStates: 기준 브랜치가 다르거나 다른 방 레포면 조용히 건너뛰고 알리지 않는다', async () => {
  const { A, B, room, run, finishOk, repos, entry } = await codeRoom('ck');
  const id0 = await run(A);
  const repo = await A.ok(MSG.ROOM_REPO_SET, { requestId: id0, remoteUrl: 'u', baseBranch: 'develop' });
  const good = await A.ok(MSG.ROOM_REPO_SET, { requestId: id0, remoteUrl: 'u2', baseBranch: 'main' });
  const other = await A.ok(MSG.ROOM_CREATE, { name: '다른 방' });
  const foreign = await A.ok(MSG.REPO_ADD, { roomId: other.id, name: 'x', remoteUrl: 'u', branch: 'main' });
  B.pushes.length = 0;
  await finishOk(A, id0, {
    codeStates: [await entry(A, id0, repo.id, 'release/old', bundleOf('a')), await entry(A, id0, foreign.id, 'main', bundleOf('b')),
      await entry(A, id0, good.id, 'main', bundleOf('c'))],
  });
  assert.deepEqual((await repos()).map((r) => r.code !== null), [false, true]);
  assert.equal(fs.existsSync(partFileOf(room.id, repo.id)), false);
  assert.equal(fs.existsSync(partFileOf(other.id, foreign.id)), false);
  assert.equal(fs.existsSync(partFileOf(room.id, good.id)), true);
  assert.deepEqual(uploadsOf(room.id), []); // 건너뛴 항목의 임시 파일도 지워진다
  await B.ok(MSG.ROOM_OPEN, { roomId: room.id }); // 앞선 방송이 모두 도착한 뒤에 확인한다
  assert.deepEqual(B.pushes.filter((m) => m.type === MSG.CODE_CHANGED).map((m) => m.repoId), [good.id]);
  await Promise.all([A.close(), B.close()]);
});

test('RUN_FINISH promotedRepoIds: 기준 = 작업 브랜치·작업 비움·처음 갈라진 곳 유지, 같은 finish 의 codeStates 는 바뀐 기준으로 비교', async () => {
  const { A, B, room, run, finishOk, repos, entry } = await codeRoom('pr');
  const id0 = await run(A);
  const x = await A.ok(MSG.ROOM_REPO_SET, { requestId: id0, remoteUrl: 'u', baseBranch: 'release/15.7.0', workBranch: 'feature/X' });
  const noWork = await A.ok(MSG.ROOM_REPO_SET, { requestId: id0, remoteUrl: 'u2', baseBranch: 'main' });
  const other = await A.ok(MSG.ROOM_CREATE, { name: '다른 방' });
  const foreign = await A.ok(MSG.REPO_ADD, { roomId: other.id, name: 'x', remoteUrl: 'u', branch: 'main' });
  await finishOk(A, id0, { codeStates: [await entry(A, id0, x.id, 'release/15.7.0', bundleOf('before'))] });

  const id1 = await run(A);
  // 작업 브랜치가 없는 레포·다른 방 레포·없는 id 는 건너뛴다
  const promoted = [x.id, noWork.id, foreign.id, 9999];
  // 승격하면 그 레포의 체인은 지워진다(다음 업로드가 새 기준에서 새로 시작). 승격 뒤 기준은 feature/X 라
  // 옛 기준 이름으로 올린 코드 상태는 건너뛰고, 새 기준 이름이면 저장
  assert.equal(fs.existsSync(partFileOf(room.id, x.id)), true);
  const cleared = B.next((m) => m.type === MSG.CODE_CHANGED && m.repoId === x.id);
  await finishOk(A, id1, { promotedRepoIds: promoted, codeStates: [await entry(A, id1, x.id, 'release/15.7.0', bundleOf('stale'))] });
  let [r, s] = await repos();
  assert.deepEqual([r.baseBranch, r.workBranch, r.originBranch, r.branch], ['feature/X', '', 'release/15.7.0', 'feature/X']);
  assert.deepEqual([s.baseBranch, s.workBranch], ['main', '']);
  await timeout(cleared);
  assert.deepEqual([r.code, fs.existsSync(partFileOf(room.id, x.id)), uploadsOf(room.id)], [null, false, []]);
  assert.equal((await A.ok(MSG.ROOM_OPEN, { roomId: other.id })).state.repos[0].baseBranch, 'main');

  const id2 = await run(B);
  await finishOk(B, id2, { codeStates: [await entry(B, id2, x.id, 'feature/X', bundleOf('after'))] });
  [r] = await repos();
  assert.deepEqual([r.code.size, r.code.parts], [bundleOf('after').length, 1]);

  // 한 finish 안에서 승격과 새 기준의 코드 상태를 같이 올린다
  const id3 = await run(A);
  await A.ok(MSG.ROOM_REPO_SET, { requestId: id3, repoId: noWork.id, remoteUrl: 'u2', baseBranch: 'main', workBranch: 'feature/Y' });
  await finishOk(A, id3, { promotedRepoIds: [noWork.id], codeStates: [await entry(A, id3, noWork.id, 'feature/Y', bundleOf('y'))] });
  [, s] = await repos();
  assert.deepEqual([s.baseBranch, s.workBranch, s.originBranch, s.code !== null], ['feature/Y', '', 'main', true]);
  await Promise.all([A.close(), B.close()]);
});

test('기준 브랜치가 바뀌면 코드 상태·묶음 파일 삭제 + CODE_CHANGED (room.repo_set, 옛 repo.update)', async () => {
  const { b, A, B, room, run, finishOk, repos, entry } = await codeRoom('cc');
  const id0 = await run(A);
  const mk = async (url) => A.ok(MSG.ROOM_REPO_SET, { requestId: id0, remoteUrl: url, baseBranch: 'develop', workBranch: 'feature/X' });
  const [r1, r2, r3] = [await mk('u1'), await mk('u2'), await mk('u3')];
  await finishOk(A, id0, { codeStates: await Promise.all([r1, r2, r3].map((r) => entry(A, id0, r.id, 'develop', bundleOf(String(r.id))))) });
  const exists = (r) => fs.existsSync(partFileOf(room.id, r.id));
  assert.deepEqual([r1, r2, r3].map(exists), [true, true, true]);

  // room.repo_set: 작업 브랜치만 바꾸면 그대로, 기준을 바꾸면 삭제 + 알림
  const id1 = await run(B);
  A.pushes.length = 0; // 앞서 코드 상태를 올릴 때 온 알림은 버린다
  B.pushes.length = 0;
  await B.ok(MSG.ROOM_REPO_SET, { requestId: id1, repoId: r1.id, remoteUrl: 'u1', baseBranch: 'develop', workBranch: 'feature/Y' });
  assert.equal(exists(r1), true);
  const n1 = A.next((m) => m.type === MSG.CODE_CHANGED && m.repoId === r1.id);
  const moved = await B.ok(MSG.ROOM_REPO_SET, { requestId: id1, repoId: r1.id, remoteUrl: 'u1', baseBranch: 'release/15.7.0' });
  assert.deepEqual(await timeout(n1), { type: MSG.CODE_CHANGED, roomId: room.id, repoId: r1.id, userId: b.user.id });
  assert.deepEqual([moved.baseBranch, moved.originBranch, moved.code], ['release/15.7.0', 'release/15.7.0', null]);
  assert.equal(exists(r1), false);

  // 옛 방장 전용 repo.update 도 같다
  const n2 = B.next((m) => m.type === MSG.CODE_CHANGED && m.repoId === r2.id);
  await A.ok(MSG.REPO_UPDATE, { repoId: r2.id, name: '이름만' });
  assert.equal(exists(r2), true);
  await A.ok(MSG.REPO_UPDATE, { repoId: r2.id, branch: 'main' });
  await timeout(n2);
  assert.equal(exists(r2), false);

  await finishOk(B, id1, {});
  assert.deepEqual((await repos()).map((r) => [r.baseBranch, r.code !== null]), [['release/15.7.0', false], ['main', false], ['develop', true]]); // r3 은 그대로
  await Promise.all([A.close(), B.close()]);
});

test('레포 빼기(room.repo_remove·옛 repo.remove)와 방 삭제는 조각 체인 전체를 지운다', async () => {
  const { A, B, room, run, finishOk, repos, entry } = await codeRoom('rm');
  const id0 = await run(A);
  const r1 = await A.ok(MSG.ROOM_REPO_SET, { requestId: id0, remoteUrl: 'u1', baseBranch: 'dev' });
  const r2 = await A.ok(MSG.ROOM_REPO_SET, { requestId: id0, remoteUrl: 'u2', baseBranch: 'dev' });
  const r3 = await A.ok(MSG.ROOM_REPO_SET, { requestId: id0, remoteUrl: 'u3', baseBranch: 'dev' });
  await finishOk(A, id0, { codeStates: await Promise.all([r1, r2, r3].map((r) => entry(A, id0, r.id, 'dev', bundleOf('x')))) });
  const idN = await run(A); // r1, r2 는 조각 둘
  await finishOk(A, idN, { codeStates: await Promise.all([r1, r2].map((r) => entry(A, idN, r.id, 'dev', bundleOf('y'), { prev: H2, snapshot: '5'.repeat(40) }))) });
  const exists = (r) => [1, 2].map((n) => fs.existsSync(partFileOf(room.id, r.id, n)));
  assert.deepEqual([exists(r1), exists(r2), exists(r3)], [[true, true], [true, true], [true, false]]);
  const id1 = await run(B);
  await B.ok(MSG.ROOM_REPO_REMOVE, { requestId: id1, repoId: r1.id });
  assert.deepEqual([exists(r1), exists(r2)], [[false, false], [true, true]]);
  await A.ok(MSG.REPO_REMOVE, { repoId: r2.id });
  assert.deepEqual([exists(r2), exists(r3)], [[false, false], [true, false]]);
  assert.deepEqual((await repos()).map((r) => r.id), [r3.id]);
  await finishOk(B, id1, {});
  await A.ok(MSG.ROOM_DELETE, { roomId: room.id });
  assert.equal(fs.existsSync(path.join(dataDir, 'rooms', String(room.id))), false);
  await Promise.all([A.close(), B.close()]);
});

test('room.fork: 레포 브랜치 3개·코드 상태·조각 체인(행·파일)이 새 레포 id 로 복사되고 원래 방은 그대로', async () => {
  const { a, b, A, B, room, run, finishOk, entry } = await codeRoom('fk');
  const id0 = await run(A);
  const r1 = await A.ok(MSG.ROOM_REPO_SET, { requestId: id0, remoteUrl: 'u1', baseBranch: 'release/1', workBranch: 'feature/X' });
  const r2 = await A.ok(MSG.ROOM_REPO_SET, { requestId: id0, remoteUrl: 'u2', baseBranch: 'main' });
  const bin1 = Buffer.concat([bundleOf(''), Buffer.from([9, 8, 7])]);
  const bin2 = bundleOf('two');
  const H3 = '3'.repeat(40);
  await finishOk(A, id0, { codeStates: [await entry(A, id0, r1.id, 'release/1', bin1)], promotedRepoIds: [] });
  const id1 = await run(A);
  await finishOk(A, id1, { codeStates: [await entry(A, id1, r1.id, 'release/1', bin2, { prev: H2, snapshot: H3 })] });

  const f = await B.ok(MSG.ROOM_FORK, { roomId: room.id, name: '갈래' });
  const copied = (await B.ok(MSG.ROOM_OPEN, { roomId: f.id })).state.repos;
  assert.deepEqual(copied.map((r) => [r.name, r.baseBranch, r.workBranch, r.originBranch]),
    [['u1', 'release/1', 'feature/X', 'release/1'], ['u2', 'main', '', 'main']]);
  assert.ok(copied.every((r) => r.id !== r1.id && r.id !== r2.id));
  assert.deepEqual([copied[0].code.snapshot, copied[0].code.size, copied[0].code.parts, copied[0].code.updatedBy],
    [H3, bin1.length + bin2.length, 2, a.user.id]);
  assert.equal(copied[1].code, null);
  const base = `/rooms/${f.id}/code/${copied[0].id}`;
  const list = (await (await get(base, b.token)).json()).parts;
  assert.deepEqual(list.map((p) => [p.seq, p.prevSnapshot, p.snapshot, p.size]), [[1, null, H2, bin1.length], [2, H2, H3, bin2.length]]);
  assert.deepEqual(Buffer.from(await (await get(`${base}/1`, b.token)).arrayBuffer()), bin1);
  assert.deepEqual(Buffer.from(await (await get(`${base}/2`, b.token)).arrayBuffer()), bin2);
  assert.deepEqual((await (await get(`/rooms/${f.id}/code/${copied[1].id}`, b.token)).json()).parts, []);
  assert.deepEqual(fs.readdirSync(path.join(dataDir, 'rooms', String(f.id), 'code')).sort(), [`${copied[0].id}-1.bundle`, `${copied[0].id}-2.bundle`]);

  // 원래 방은 그대로, 새 방의 체인은 따로 남는다
  const orig = (await A.ok(MSG.ROOM_OPEN, { roomId: room.id })).state.repos;
  assert.deepEqual(orig.map((r) => [r.id, r.code?.parts ?? null]), [[r1.id, 2], [r2.id, null]]);
  assert.deepEqual(Buffer.from(await (await get(`/rooms/${room.id}/code/${r1.id}/2`, a.token)).arrayBuffer()), bin2);
  await A.ok(MSG.ROOM_DELETE, { roomId: room.id });
  assert.deepEqual(Buffer.from(await (await get(`${base}/2`, b.token)).arrayBuffer()), bin2);
  await Promise.all([A.close(), B.close()]);
});
