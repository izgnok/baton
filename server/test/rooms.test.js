import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { signup } from '../src/auth.js';
import * as R from '../src/rooms.js';

function setup(n = 3) {
  const db = openDb(':memory:');
  const ids = [];
  for (let i = 0; i < n; i++) {
    ids.push(signup(db, { email: `u${i}@x.com`, password: 'password1', name: `u${i}` }).user.id);
  }
  return { db, ids };
}
const count = (db, table) => db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c;
const forbidden = { message: 'FORBIDDEN' };

test('만들기 → 소문자 코드로 참가 → 둘 다 목록에 보임 → 나가기', () => {
  const { db, ids: [a, b] } = setup();
  const room = R.createRoom(db, a, { name: '방' });
  assert.match(room.inviteCode, /^[A-Z0-9]{6}$/);
  assert.equal(room.ownerId, a);
  const joined = R.joinRoom(db, b, { inviteCode: ` ${room.inviteCode.toLowerCase()} ` });
  assert.equal(joined.id, room.id);
  assert.deepEqual(R.listRooms(db, a).map((r) => r.id), [room.id]);
  assert.deepEqual(R.listRooms(db, b).map((r) => r.id), [room.id]);
  R.leaveRoom(db, b, room.id);
  assert.deepEqual(R.listRooms(db, b), []);
  assert.throws(() => R.leaveRoom(db, b, room.id), { message: 'NOT_FOUND' });
});

test('이미 멤버가 다시 join 해도 멤버 수 그대로', () => {
  const { db, ids: [a] } = setup();
  const room = R.createRoom(db, a, { name: '방' });
  R.joinRoom(db, a, { inviteCode: room.inviteCode });
  assert.equal(R.getRoomState(db, a, room.id).members.length, 1);
});

test('없는 코드는 NOT_FOUND, 빈 이름은 INVALID_INPUT', () => {
  const { db, ids: [a] } = setup();
  assert.throws(() => R.joinRoom(db, a, { inviteCode: 'ZZZZZZ' }), { message: 'NOT_FOUND' });
  assert.throws(() => R.createRoom(db, a, { name: '  ' }), { message: 'INVALID_INPUT' });
});

test('방장이 나가면 다음으로 일찍 들어온 멤버가 방장', () => {
  const { db, ids: [a, b, c] } = setup();
  const room = R.createRoom(db, a, { name: '방' });
  R.joinRoom(db, b, { inviteCode: room.inviteCode });
  R.joinRoom(db, c, { inviteCode: room.inviteCode });
  R.leaveRoom(db, a, room.id);
  let st = R.getRoomState(db, b, room.id);
  assert.equal(st.room.ownerId, b);
  assert.deepEqual(st.members.map((m) => [m.userId, m.isOwner]), [[b, true], [c, false]]);
  R.leaveRoom(db, b, room.id);
  assert.equal(R.getRoomState(db, c, room.id).room.ownerId, c);
});

test('마지막 사람이 나가도 방 행은 남는다', () => {
  const { db, ids: [a] } = setup();
  const room = R.createRoom(db, a, { name: '방' });
  R.leaveRoom(db, a, room.id);
  assert.equal(count(db, 'rooms'), 1);
  assert.equal(count(db, 'room_members'), 0);
  assert.equal(db.prepare('SELECT owner_id FROM rooms').get().owner_id, a);
});

test('방장 아닌 사람의 방·레포 관리는 FORBIDDEN', () => {
  const { db, ids: [a, b] } = setup();
  const room = R.createRoom(db, a, { name: '방' });
  R.joinRoom(db, b, { inviteCode: room.inviteCode });
  const repo = R.addRepo(db, a, room.id, { name: 'r', remoteUrl: 'git@h:a/r.git', branch: 'main' });
  assert.throws(() => R.addRepo(db, b, room.id, { name: 'r', remoteUrl: 'u', branch: 'b' }), forbidden);
  assert.throws(() => R.updateRepo(db, b, repo.id, { branch: 'x' }), forbidden);
  assert.throws(() => R.removeRepo(db, b, repo.id), forbidden);
  assert.throws(() => R.renameRoom(db, b, room.id, { name: 'x' }), forbidden);
  assert.throws(() => R.regenerateInvite(db, b, room.id), forbidden);
  assert.throws(() => R.deleteRoom(db, b, room.id), forbidden);
});

test('멤버 아닌 사람의 getRoomState 는 FORBIDDEN', () => {
  const { db, ids: [a, b] } = setup();
  const room = R.createRoom(db, a, { name: '방' });
  assert.throws(() => R.getRoomState(db, b, room.id), forbidden);
  assert.throws(() => R.getRoomState(db, a, 999), { message: 'NOT_FOUND' });
});

test('regenerateInvite 후 옛 코드는 NOT_FOUND', () => {
  const { db, ids: [a, b] } = setup();
  const room = R.createRoom(db, a, { name: '방' });
  const next = R.regenerateInvite(db, a, room.id);
  assert.notEqual(next.inviteCode, room.inviteCode);
  assert.throws(() => R.joinRoom(db, b, { inviteCode: room.inviteCode }), { message: 'NOT_FOUND' });
  assert.equal(R.joinRoom(db, b, { inviteCode: next.inviteCode }).id, room.id);
});

test('renameRoom', () => {
  const { db, ids: [a] } = setup();
  const room = R.createRoom(db, a, { name: '방' });
  assert.equal(R.renameRoom(db, a, room.id, { name: ' 새 이름 ' }).name, '새 이름');
});

test('deleteRoom 은 멤버·레포·메시지까지 지운다', () => {
  const { db, ids: [a, b] } = setup();
  const room = R.createRoom(db, a, { name: '방' });
  R.joinRoom(db, b, { inviteCode: room.inviteCode });
  R.addRepo(db, a, room.id, { name: 'r', remoteUrl: 'u', branch: 'main' });
  db.prepare("INSERT INTO messages (room_id, user_id, kind, body, created_at) VALUES (?, ?, 'chat', 'hi', 0)")
    .run(room.id, a);
  R.deleteRoom(db, a, room.id);
  for (const t of ['rooms', 'room_members', 'room_repos', 'messages']) assert.equal(count(db, t), 0, t);
});

test('updateRepo 는 넘긴 것만 바꾸고 빈 값은 INVALID_INPUT, remoteUrl 은 원문 저장', () => {
  const { db, ids: [a] } = setup();
  const room = R.createRoom(db, a, { name: '방' });
  const repo = R.addRepo(db, a, room.id, { name: 'r', remoteUrl: 'git@h:a/r.git', branch: 'main' });
  const up = R.updateRepo(db, a, repo.id, { branch: 'develop' });
  assert.deepEqual(up, { id: repo.id, name: 'r', remoteUrl: 'git@h:a/r.git', branch: 'develop' });
  assert.throws(() => R.updateRepo(db, a, repo.id, { branch: '' }), { message: 'INVALID_INPUT' });
  assert.equal(R.getRoomState(db, a, room.id).repos[0].branch, 'develop');
  R.removeRepo(db, a, repo.id);
  assert.deepEqual(R.getRoomState(db, a, room.id).repos, []);
  assert.throws(() => R.removeRepo(db, a, repo.id), { message: 'NOT_FOUND' });
});
