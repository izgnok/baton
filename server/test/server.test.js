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
