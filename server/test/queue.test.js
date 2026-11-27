import test from 'node:test';
import assert from 'node:assert/strict';
import { MSG } from '@rooms/shared/protocol.js';
import { openDb } from '../src/db.js';
import { signup } from '../src/auth.js';
import { createRoom, joinRoom } from '../src/rooms.js';
import { createQueue } from '../src/queue.js';

function setup(n = 3) {
  const db = openDb(':memory:');
  const users = [];
  for (let i = 0; i < n; i++) {
    users.push(signup(db, { email: `u${i}@x.com`, password: 'password1', name: `u${i}` }).user.id);
  }
  const room = createRoom(db, users[0], { name: '방' });
  for (const u of users.slice(1)) joinRoom(db, u, { inviteCode: room.inviteCode });
  const env = { t: 1000, online: new Set(users), dispatches: [], cancels: [], broadcasts: [] };
  const q = createQueue(db, {
    now: () => env.t,
    isOnline: (u) => env.online.has(u),
    dispatch: (userId, runStart) => env.dispatches.push({ userId, runStart }),
    dispatchCancel: (userId, requestId) => env.cancels.push({ userId, requestId }),
    broadcast: (roomId, payload) => env.broadcasts.push({ roomId, payload }),
  });
  const status = (id) => {
    const m = q.listMessages(users[0], room.id).find((x) => x.id === id);
    return [m.status, m.error];
  };
  return { db, users, room, env, q, status };
}

test('postMessage 판정', () => {
  const { db, users: [a], room, q } = setup();
  const m = q.postMessage(a, room.id, '  @Claude 안녕');
  assert.equal(m.kind, 'claude_request');
  assert.equal(m.body, '안녕');
  assert.equal(m.userName, 'u0');
  assert.throws(() => q.postMessage(a, room.id, '@claude   '), { message: 'EMPTY_REQUEST' });
  assert.throws(() => q.postMessage(a, room.id, ' / '), { message: 'EMPTY_REQUEST' });
  const slash = q.postMessage(a, room.id, '  /compact');
  assert.equal(slash.kind, 'claude_request');
  assert.equal(slash.body, '/compact');
  const chat = q.postMessage(a, room.id, ' 이메일 a@claude.com ');
  assert.equal(chat.kind, 'chat');
  assert.equal(chat.body, ' 이메일 a@claude.com ');
  assert.throws(() => q.postMessage(a, room.id, '   '), { message: 'INVALID_INPUT' });
  const outsider = signup(db, { email: 'o@x.com', password: 'password1', name: 'o' }).user.id;
  assert.throws(() => q.postMessage(outsider, room.id, '안녕'), { message: 'FORBIDDEN' });
  assert.throws(() => q.listMessages(outsider, room.id), { message: 'FORBIDDEN' });
});

test('요청 두 개는 하나씩: A 만 running, finish 후 B dispatch', () => {
  const { users: [a, b], room, env, q, status } = setup();
  const r1 = q.postMessage(a, room.id, '@claude 하나');
  const r2 = q.postMessage(b, room.id, '@claude 둘');
  assert.deepEqual(env.dispatches.map((d) => d.userId), [a]);
  assert.deepEqual(status(r1.id), ['running', null]);
  assert.deepEqual(status(r2.id), ['queued', null]);
  assert.ok(env.broadcasts.some((x) => x.payload.type === MSG.MESSAGE_NEW));
  q.finish(r1.id, { transcriptVersion: 0 });
  assert.deepEqual(env.dispatches.map((d) => d.userId), [a, b]);
  assert.equal(env.dispatches[1].runStart.requestId, r2.id);
  assert.deepEqual(status(r2.id), ['running', null]);
});

test('보낸 사람이 오프라인이면 held(OFFLINE) 하고 다음으로', () => {
  const { users: [a, b], room, env, q, status } = setup();
  env.online.delete(a);
  const r1 = q.postMessage(a, room.id, '@claude 하나');
  assert.deepEqual(status(r1.id), ['held', 'OFFLINE']);
  assert.equal(env.dispatches.length, 0);
  const r2 = q.postMessage(b, room.id, '@claude 둘');
  assert.deepEqual(status(r2.id), ['running', null]);
});

test('신호 30초 초과는 TIMEOUT 후 다음 요청 dispatch, heartbeat 로 연장', () => {
  const { users: [a, b], room, env, q, status } = setup();
  const r1 = q.postMessage(a, room.id, '@claude 하나');
  const r2 = q.postMessage(b, room.id, '@claude 둘');
  env.t += 29999;
  q.tick();
  assert.deepEqual(status(r1.id), ['running', null]);
  q.heartbeat(r1.id);
  env.t += 29999;
  q.tick();
  assert.deepEqual(status(r1.id), ['running', null]);
  env.t += 2;
  q.tick();
  assert.deepEqual(status(r1.id), ['failed', 'TIMEOUT']);
  assert.deepEqual(status(r2.id), ['running', null]);
  assert.equal(env.dispatches.length, 2);
});

test('finish 버전 불일치는 VERSION_MISMATCH 를 던지고 요청 failed', () => {
  const { users: [a], room, db, q, status } = setup();
  const r = q.postMessage(a, room.id, '@claude 하나');
  assert.throws(() => q.finish(r.id, { transcriptVersion: 5 }), { message: 'VERSION_MISMATCH' });
  assert.deepEqual(status(r.id), ['failed', 'VERSION_MISMATCH']);
  assert.equal(db.prepare('SELECT transcript_version AS v FROM rooms').get().v, 0);
  assert.throws(() => q.finish(r.id, { transcriptVersion: 0 }), { message: 'NOT_RUNNING' });
});

test('apply 가 throw 하면 롤백하고 APPLY_FAILED', () => {
  const { users: [a], room, db, q, status } = setup();
  const r = q.postMessage(a, room.id, '@claude 하나');
  assert.throws(
    () => q.finish(r.id, { transcriptVersion: 0, sessionId: 's1', apply: () => { throw new Error('디스크'); } }),
    { message: '디스크' },
  );
  assert.deepEqual(status(r.id), ['failed', 'APPLY_FAILED']);
  const row = db.prepare('SELECT * FROM rooms').get();
  assert.equal(row.transcript_version, 0);
  assert.equal(row.claude_session_id, null);
});

test('finish 성공: 버전 +1, sessionId 저장, done, apply 호출', () => {
  const { users: [a], room, db, q, status } = setup();
  const r = q.postMessage(a, room.id, '@claude 하나');
  let applied = 0;
  assert.deepEqual(q.finish(r.id, { transcriptVersion: 0, sessionId: 's1', apply: () => applied++ }), { newVersion: 1 });
  assert.equal(applied, 1);
  assert.deepEqual(status(r.id), ['done', null]);
  const row = db.prepare('SELECT * FROM rooms').get();
  assert.equal(row.transcript_version, 1);
  assert.equal(row.claude_session_id, 's1');
  const r2 = q.postMessage(a, room.id, '@claude 둘');
  assert.equal(q.finish(r2.id, { transcriptVersion: 1 }).newVersion, 2);
  assert.equal(db.prepare('SELECT claude_session_id AS s FROM rooms').get().s, 's1');
});

test('실행 중 onLeave: running 유지, 그 사람의 queued 는 held(LEFT)', () => {
  const { users: [a, b], room, q, status } = setup();
  const r1 = q.postMessage(a, room.id, '@claude 하나');
  const r2 = q.postMessage(a, room.id, '@claude 둘');
  const r3 = q.postMessage(b, room.id, '@claude 셋');
  q.onLeave(a, room.id);
  assert.deepEqual(status(r1.id), ['running', null]);
  assert.deepEqual(status(r2.id), ['held', 'LEFT']);
  assert.deepEqual(status(r3.id), ['queued', null]);
});

test('chatsSince: 마지막 done 요청 이후, 이 요청 이전의 채팅만', () => {
  const { users: [a, b], room, env, q } = setup();
  q.postMessage(a, room.id, '채팅1');
  const r1 = q.postMessage(a, room.id, '@claude 하나');
  assert.deepEqual(env.dispatches[0].runStart.chatsSince, [{ name: 'u0', body: '채팅1' }]);
  q.finish(r1.id, { transcriptVersion: 0, sessionId: 's1' });
  q.postMessage(a, room.id, '채팅2');
  q.postMessage(b, room.id, '채팅3 한글');
  const r2 = q.postMessage(b, room.id, '@claude 둘');
  q.postMessage(a, room.id, '요청 뒤 채팅');
  const rs = env.dispatches[1].runStart;
  assert.equal(rs.requestId, r2.id);
  assert.deepEqual(rs.chatsSince, [{ name: 'u0', body: '채팅2' }, { name: 'u1', body: '채팅3 한글' }]);
  assert.equal(rs.sessionId, 's1');
  assert.equal(rs.transcriptVersion, 1);
  assert.equal(rs.requesterName, 'u1');
  assert.equal(rs.body, '둘');
});

test('retry: 보낸 사람만, held/failed 만, 대기열 끝으로', () => {
  const { users: [a, b, c], room, env, q, status } = setup();
  env.online.delete(c);
  const held = q.postMessage(c, room.id, '@claude 보류');
  assert.deepEqual(status(held.id), ['held', 'OFFLINE']);
  const r1 = q.postMessage(a, room.id, '@claude 하나');
  env.t += 10;
  const waiting = q.postMessage(b, room.id, '@claude 대기');
  env.t += 10;
  env.online.add(c);
  assert.throws(() => q.retry(a, held.id), { message: 'FORBIDDEN' });
  q.retry(c, held.id);
  assert.deepEqual(status(held.id), ['queued', null]);
  assert.throws(() => q.retry(a, r1.id), { message: 'NOT_RETRYABLE' });
  q.finish(r1.id, { transcriptVersion: 0 });
  assert.deepEqual(status(waiting.id), ['running', null]);
  assert.throws(() => q.retry(a, r1.id), { message: 'NOT_RETRYABLE' });
  q.finish(waiting.id, { transcriptVersion: 1 });
  assert.deepEqual(status(held.id), ['running', null]);
});

test('retry: 방을 나간 사람은 FORBIDDEN', async () => {
  const { users: [, b], room, env, q, db } = setup();
  const { leaveRoom } = await import('../src/rooms.js');
  env.online.delete(b);
  const held = q.postMessage(b, room.id, '@claude 보류');
  leaveRoom(db, b, room.id);
  env.online.add(b);
  assert.throws(() => q.retry(b, held.id), { message: 'FORBIDDEN' });
});

test('requesterOf: 요청 보낸 사람, 요청이 아니면 null', () => {
  const { users: [a], room, q } = setup();
  const req = q.postMessage(a, room.id, '@claude 하나');
  const chat = q.postMessage(a, room.id, '채팅');
  assert.equal(q.requesterOf(req.id), a);
  assert.equal(q.requesterOf(chat.id), null);
  assert.equal(q.requesterOf(9999), null);
});

test('appendEvent: running 이 아니면 NOT_RUNNING, 맞으면 claude_event 저장', () => {
  const { users: [a, b], room, q } = setup();
  const r1 = q.postMessage(a, room.id, '@claude 하나');
  const r2 = q.postMessage(b, room.id, '@claude 둘');
  assert.throws(() => q.appendEvent(r2.id, { x: 1 }), { message: 'NOT_RUNNING' });
  q.appendEvent(r1.id, { type: 'text', text: '안녕' });
  const ev = q.listMessages(a, room.id).find((m) => m.kind === 'claude_event');
  assert.equal(ev.requestId, r1.id);
  assert.equal(ev.userId, a);
  assert.deepEqual(JSON.parse(ev.body), { type: 'text', text: '안녕' });
});

test('recoverOnStart: running 은 failed(SERVER_RESTART)', () => {
  const { users: [a], room, q, status } = setup();
  const r = q.postMessage(a, room.id, '@claude 하나');
  q.recoverOnStart();
  assert.deepEqual(status(r.id), ['failed', 'SERVER_RESTART']);
});

test('fail: running 만 failed, 다음 요청 진행', () => {
  const { users: [a, b], room, q, status } = setup();
  const r1 = q.postMessage(a, room.id, '@claude 하나');
  const r2 = q.postMessage(b, room.id, '@claude 둘');
  q.fail(r2.id, 'X');
  assert.deepEqual(status(r2.id), ['queued', null]);
  q.fail(r1.id, 'LIMIT');
  assert.deepEqual(status(r1.id), ['failed', 'LIMIT']);
  assert.deepEqual(status(r2.id), ['running', null]);
});

test('다른 방의 running 은 이 방 대기열을 막지 않는다', () => {
  const { db, users: [a, b], room, env, q } = setup();
  const room2 = createRoom(db, b, { name: '방2' });
  q.postMessage(a, room.id, '@claude 하나');
  q.postMessage(b, room2.id, '@claude 둘');
  assert.deepEqual(env.dispatches.map((d) => d.runStart.roomId), [room.id, room2.id]);
});

test('listMessages 는 마지막 limit 개를 id 오름차순으로', () => {
  const { users: [a], room, q } = setup();
  for (let i = 0; i < 5; i++) q.postMessage(a, room.id, `m${i}`);
  assert.deepEqual(q.listMessages(a, room.id, { limit: 3 }).map((m) => m.body), ['m2', 'm3', 'm4']);
});

test('cancel: 대기·보류 요청은 바로 cancelled, dispatchCancel 은 부르지 않는다', () => {
  const { users: [a, b, c], room, env, q, status } = setup();
  env.online.delete(c);
  const held = q.postMessage(c, room.id, '@claude 보류');
  q.postMessage(a, room.id, '@claude 하나');
  const waiting = q.postMessage(b, room.id, '@claude 대기');
  q.cancel(b, waiting.id);
  assert.deepEqual(status(waiting.id), ['cancelled', null]);
  q.cancel(c, held.id);
  assert.deepEqual(status(held.id), ['cancelled', null]);
  assert.deepEqual(env.cancels, []);
  assert.ok(env.broadcasts.some((x) => x.payload.type === MSG.MESSAGE_UPDATE && x.payload.message.status === 'cancelled'));
});

test('cancel: 실행 중이면 cancelled + dispatchCancel(요청자) + 다음 요청 dispatch, 늦은 finish 는 거부', () => {
  const { users: [a, b], room, env, q, status } = setup();
  const r1 = q.postMessage(a, room.id, '@claude 하나');
  const r2 = q.postMessage(b, room.id, '@claude 둘');
  q.cancel(a, r1.id);
  assert.deepEqual(status(r1.id), ['cancelled', null]);
  assert.deepEqual(env.cancels, [{ userId: a, requestId: r1.id }]);
  assert.deepEqual(env.dispatches.map((d) => d.userId), [a, b]);
  assert.deepEqual(status(r2.id), ['running', null]);
  assert.throws(() => q.finish(r1.id, { transcriptVersion: 0 }), { message: 'NOT_RUNNING' });
  assert.deepEqual(status(r1.id), ['cancelled', null]);
});

test('cancel: 남·비방장은 FORBIDDEN, 방장은 남의 요청도 취소, 비멤버는 FORBIDDEN', () => {
  const { db, users: [owner, b, c], room, q, status } = setup();
  q.postMessage(owner, room.id, '@claude 하나');
  const r2 = q.postMessage(b, room.id, '@claude 둘');
  assert.throws(() => q.cancel(c, r2.id), { message: 'FORBIDDEN' });
  q.cancel(owner, r2.id); // 방장
  assert.deepEqual(status(r2.id), ['cancelled', null]);
  const outsider = signup(db, { email: 'o@x.com', password: 'password1', name: 'o' }).user.id;
  const r3 = q.postMessage(b, room.id, '@claude 셋');
  assert.throws(() => q.cancel(outsider, r3.id), { message: 'FORBIDDEN' });
  assert.throws(() => q.cancel(owner, 9999), { message: 'NOT_FOUND' });
});

test('cancel: 끝난 요청은 NOT_CANCELLABLE, cancelled 는 retry 로 다시 대기열에', () => {
  const { users: [a], room, q, status } = setup();
  const r1 = q.postMessage(a, room.id, '@claude 하나');
  q.finish(r1.id, { transcriptVersion: 0 });
  assert.throws(() => q.cancel(a, r1.id), { message: 'NOT_CANCELLABLE' });
  const r2 = q.postMessage(a, room.id, '@claude 둘');
  q.cancel(a, r2.id);
  assert.throws(() => q.cancel(a, r2.id), { message: 'NOT_CANCELLABLE' });
  q.retry(a, r2.id);
  assert.deepEqual(status(r2.id), ['running', null]);
});
