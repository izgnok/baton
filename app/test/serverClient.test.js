import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import crypto from 'node:crypto';
import { MSG } from '@rooms/shared/protocol.js';
import { startServer } from '../../server/src/index.js';
import { createServerClient, signup, login, getServerCommit } from '../main/serverClient.js';

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

test('getServerCommit: 서버 /version 의 commit, 못 읽으면 null', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rooms-ver-'));
  const s2 = await startServer({ port: 0, dataDir: dir, commit: 'abc1234' });
  try {
    assert.equal(await getServerCommit(`http://localhost:${s2.port}`), 'abc1234');
    assert.equal(await getServerCommit(`localhost:${s2.port}/`), 'abc1234'); // 스킴 없이 입력해도
  } finally {
    await s2.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(await getServerCommit(`http://localhost:${s2.port}`), null);
});

test('코드 조각: uploadBundle → RUN_FINISH codeStates → listCodeParts·downloadCodePart 가 같은 바이트, 상한을 넘으면 BUNDLE_TOO_BIG', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rooms-code-'));
  const small = await startServer({ port: 0, dataDir: dir, maxBundle: 4096 });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rooms-code-files-'));
  const fileOf = (name, size) => {
    const f = path.join(tmp, name);
    fs.writeFileSync(f, Buffer.concat([Buffer.from('# v2 git bundle\n'), crypto.randomBytes(size)]));
    return f;
  };
  try {
    const mkC = async (token) => {
      const c = createServerClient({ serverUrl: `http://localhost:${small.port}`, token, ...fast });
      clients.push(c);
      await untilStatus(c, (st) => st.connected);
      return c;
    };
    const a = await signup(`http://localhost:${small.port}`, { email: 'code-a@x.com', password: 'password1', name: 'a' });
    const b = await signup(`http://localhost:${small.port}`, { email: 'code-b@x.com', password: 'password1', name: 'b' });
    const A = await mkC(a.token);
    const B = await mkC(b.token);
    const room = await A.request(MSG.ROOM_CREATE, { name: '코드' });
    await B.request(MSG.ROOM_JOIN, { inviteCode: room.inviteCode });
    const started = new Promise((resolve) => A.on(MSG.RUN_START, resolve));
    const msg = await A.request(MSG.CHAT_SEND, { roomId: room.id, text: '@claude 하나' });
    await started;
    const repo = await A.request(MSG.ROOM_REPO_SET, { requestId: msg.id, remoteUrl: 'git@h:a/r.git', baseBranch: 'develop' });

    // 상한(4096) 이하는 올라가고, 넘으면 BUNDLE_TOO_BIG(큰 파일이어도 응답을 받는다)
    const ok = fileOf('ok.bundle', 3000);
    const up = await A.http.uploadBundle(room.id, msg.id, ok);
    assert.equal(up.size, fs.statSync(ok).size);
    assert.match(up.uploadId, /^[0-9a-f]{32}$/);
    await assert.rejects(A.http.uploadBundle(room.id, msg.id, fileOf('big.bundle', 5 * 1024 * 1024)), { message: 'BUNDLE_TOO_BIG' });
    // 요청자가 아니거나 없는 요청은 서버 오류 코드 그대로
    await assert.rejects(B.http.uploadBundle(room.id, msg.id, ok), { message: 'FORBIDDEN' });
    await assert.rejects(A.http.uploadBundle(room.id, 99999, ok), { message: 'FORBIDDEN' });
    await assert.rejects(A.http.uploadBundle(room.id, msg.id, path.join(tmp, 'nope.bundle')), { code: 'ENOENT' });

    await A.request(MSG.RUN_FINISH, {
      requestId: msg.id, transcriptVersion: 0, transcript: '', sharedChanges: [],
      codeStates: [{ repoId: repo.id, baseBranch: 'develop', baseCommit: '1'.repeat(40), snapshot: '2'.repeat(40), prevSnapshot: null, uploadId: up.uploadId }],
    });
    const parts = await B.http.listCodeParts(room.id, repo.id);
    assert.deepEqual(parts, [{ seq: 1, prevSnapshot: null, snapshot: '2'.repeat(40), baseCommit: '1'.repeat(40), size: up.size }]);
    const out = path.join(tmp, 'down.bundle');
    await B.http.downloadCodePart(room.id, repo.id, 1, out);
    assert.deepEqual(fs.readFileSync(out), fs.readFileSync(ok));

    // 없는 조각은 NOT_FOUND 이고 반쯤 쓴 파일을 남기지 않는다
    const miss = path.join(tmp, 'miss.bundle');
    await assert.rejects(B.http.downloadCodePart(room.id, repo.id, 9, miss), { message: 'NOT_FOUND' });
    assert.equal(fs.existsSync(miss), false);
    await assert.rejects(B.http.listCodeParts(room.id, 9999), { message: 'NOT_FOUND' });
  } finally {
    await small.close();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
