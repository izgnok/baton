import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { MSG } from '@rooms/shared/protocol.js';
import { startServer } from '../../server/src/index.js';
import { createServerClient, signup, login } from '../main/serverClient.js';

let dataDir;
let srv;
const clients = [];
const url = () => `http://localhost:${srv.port}`;
const fast = { backoffMs: [20, 40] };

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rooms-client-'));
  srv = await startServer({ port: 0, dataDir });
});
after(async () => {
  clients.forEach((c) => c.close());
  await srv.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const mk = (opts) => {
  const c = createServerClient({ serverUrl: url(), ...fast, ...opts });
  clients.push(c);
  return c;
};
// 조건을 만족하는 status 를 기다린다(이미 만족하면 바로)
const untilStatus = (c, pred, ms = 3000) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('status timeout')), ms);
  const done = (s) => { clearTimeout(t); off(); resolve(s); };
  const off = c.on('status', (s) => pred(s) && done(s));
  if (pred({ connected: c.connected })) done({ connected: c.connected });
});
const connectedClient = async (token) => {
  const c = mk({ token });
  await untilStatus(c, (s) => s.connected);
  return c;
};
let n = 0;
const newUser = async () => signup(url(), { email: `u${n++}@x.com`, password: 'password1', name: `u${n}` });

test('signup/login 헬퍼와 오류 코드', async () => {
  const a = await newUser();
  assert.ok(a.token && a.user.id);
  const l = await login(url(), { email: a.user.email, password: 'password1' });
  assert.equal(l.user.id, a.user.id);
  await assert.rejects(signup(url(), { email: a.user.email, password: 'password1', name: 'x' }), { message: 'EMAIL_TAKEN' });
  await assert.rejects(login(url(), { email: a.user.email, password: 'wrongpass1' }), { message: 'BAD_CREDENTIALS' });
  await assert.rejects(login('http://localhost:1', { email: 'a@x.com', password: 'x' }), { message: 'SERVER_UNREACHABLE' });
});

test('request/reply 와 서버 알림 구독', async () => {
  const a = await newUser();
  const b = await newUser();
  const A = await connectedClient(a.token);
  const B = await connectedClient(b.token);
  const room = await A.request(MSG.ROOM_CREATE, { name: '방' });
  assert.equal(room.ownerId, a.user.id);
  const state = new Promise((resolve) => A.on(MSG.ROOM_STATE, resolve));
  const any = new Promise((resolve) => A.on('*', (m) => m.type === MSG.ROOM_STATE && resolve(m)));
  await B.request(MSG.ROOM_JOIN, { inviteCode: room.inviteCode });
  assert.equal((await state).state.members.length, 2);
  assert.equal((await any).type, MSG.ROOM_STATE);
  await assert.rejects(B.request(MSG.ROOM_DELETE, { roomId: room.id }), { message: 'FORBIDDEN' });
});

test('틀린 토큰은 UNAUTHENTICATED 이고 재연결하지 않는다', async () => {
  let count = 0;
  class Counting extends WebSocket {
    constructor(...args) { super(...args); count++; }
  }
  const c = mk({ token: 'wrong', WebSocketImpl: Counting });
  const s = await untilStatus(c, (x) => x.reason === 'UNAUTHENTICATED');
  assert.deepEqual(s, { connected: false, reason: 'UNAUTHENTICATED' });
  await new Promise((r) => setTimeout(r, 200)); // backoff(20ms) 의 여러 배
  assert.equal(count, 1);
  await assert.rejects(c.request(MSG.ROOM_LIST), { message: 'DISCONNECTED' });
});

test('http 3종: 204 는 null, manifest, 파일, 없는 파일 NOT_FOUND', async () => {
  const a = await newUser();
  const A = await connectedClient(a.token);
  const room = await A.request(MSG.ROOM_CREATE, { name: '방' });
  assert.equal(await A.http.getTranscript(room.id), null);
  assert.deepEqual(await A.http.getManifest(room.id), []);
  const roomDir = path.join(dataDir, 'rooms', String(room.id));
  fs.mkdirSync(path.join(roomDir, 'shared', 'memory'), { recursive: true });
  fs.writeFileSync(path.join(roomDir, 'transcript.jsonl'), '{"a":1}\n');
  fs.writeFileSync(path.join(roomDir, 'shared', 'memory', '메모.md'), '한글');
  assert.equal(await A.http.getTranscript(room.id), '{"a":1}\n');
  assert.deepEqual((await A.http.getManifest(room.id)).map((f) => f.path), ['memory/메모.md']);
  assert.equal((await A.http.getShared(room.id, 'memory/메모.md')).toString(), '한글');
  await assert.rejects(A.http.getShared(room.id, 'no.md'), { message: 'NOT_FOUND' });
  await assert.rejects(A.http.getShared(room.id, '../x'), { message: 'BAD_PATH' });
  await assert.rejects(A.http.getManifest(9999), { message: 'NOT_FOUND' });
});

test('서버가 끊겼다 돌아오면 재연결하고, 끊긴 동안 request 는 DISCONNECTED', async () => {
  const a = await newUser();
  const A = await connectedClient(a.token);
  const port = srv.port;
  await srv.close();
  await untilStatus(A, (s) => !s.connected);
  await assert.rejects(A.request(MSG.ROOM_LIST), { message: 'DISCONNECTED' });
  srv = await startServer({ port, dataDir });
  await untilStatus(A, (s) => s.connected, 5000);
  assert.deepEqual((await A.request(MSG.ROOM_LIST)).rooms, []);
});
