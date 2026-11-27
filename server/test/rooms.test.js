import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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

test('옛 스키마 DB 를 열면 default_model·default_effort 칸이 생기고 데이터는 남는다', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const os = await import('node:os');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rooms-old-'));
  const file = path.join(dir, 'rooms.db');
  try {
    const old = new DatabaseSync(file);
    old.exec(`
      CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, name TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE rooms (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, invite_code TEXT NOT NULL UNIQUE,
        owner_id INTEGER NOT NULL REFERENCES users(id), claude_session_id TEXT, transcript_version INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
      INSERT INTO users (email, password_hash, name, created_at) VALUES ('a@x.com', 'h', 'a', 1);
      INSERT INTO rooms (name, invite_code, owner_id, created_at) VALUES ('옛 방', 'OLD123', 1, 1);
    `);
    old.close();
    const db = openDb(file);
    const cols = db.prepare('PRAGMA table_info(rooms)').all().map((c) => c.name);
    assert.ok(cols.includes('default_model') && cols.includes('default_effort'));
    const row = db.prepare('SELECT * FROM rooms WHERE id = 1').get();
    assert.equal(row.name, '옛 방');
    assert.equal(row.default_model, null);
    db.close();
    openDb(file).close(); // 다시 열어도 문제없다(이미 있는 칸은 건너뜀)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('checkRunBranches·setRunBranches: 이 방 레포만, 이름은 문자열(앞뒤 공백 제거·- 로 시작 금지), 방장 검사 없음', () => {
  const { db, ids: [a, b] } = setup();
  const room = R.createRoom(db, a, { name: '방' });
  const other = R.createRoom(db, a, { name: '다른 방' });
  R.joinRoom(db, b, { inviteCode: room.inviteCode });
  const repo = R.addRepo(db, a, room.id, { name: 'r', remoteUrl: 'u', branch: 'main' });
  const foreign = R.addRepo(db, a, other.id, { name: 'x', remoteUrl: 'u', branch: 'main' });
  const bad = { message: 'INVALID_INPUT' };
  assert.deepEqual(R.checkRunBranches(db, room.id, []), []);
  assert.throws(() => R.checkRunBranches(db, room.id, undefined), bad);
  assert.throws(() => R.checkRunBranches(db, room.id, [{ repoId: foreign.id, branch: 'b' }]), bad);
  assert.throws(() => R.checkRunBranches(db, room.id, [{ repoId: repo.id, branch: '--upload-pack=x' }]), bad);
  assert.throws(() => R.checkRunBranches(db, room.id, [{ repoId: repo.id, branch: 7 }]), bad);
  const ok = R.checkRunBranches(db, room.id, [{ repoId: repo.id, branch: ' feature/X ' }]);
  assert.deepEqual(ok, [{ id: repo.id, branch: 'feature/X' }]);
  R.setRunBranches(db, ok);
  assert.equal(R.getRoomState(db, b, room.id).repos[0].branch, 'feature/X');
  assert.equal(R.getRoomState(db, a, other.id).repos[0].branch, 'main');
});

test('공개: 새 방은 기본 공개, 비멤버의 공개 방 목록에만 보이고 초대 코드는 없다', () => {
  const { db, ids: [a, b] } = setup();
  const pub = R.createRoom(db, a, { name: '공개방' });
  const priv = R.createRoom(db, a, { name: '비공개방' });
  assert.equal(pub.isPublic, true);
  R.setRoomSettings(db, a, priv.id, { isPublic: false });
  assert.equal(R.getRoomState(db, a, priv.id).room.isPublic, false);
  assert.deepEqual(R.listPublicRooms(db, a), []); // 내 방은 안 보임
  const list = R.listPublicRooms(db, b);
  assert.deepEqual(list.map((r) => [r.id, r.name, r.memberCount]), [[pub.id, '공개방', 1]]);
  assert.deepEqual(Object.keys(list[0]).sort(), ['createdAt', 'id', 'memberCount', 'name']);
  R.joinPublicRoom(db, b, pub.id);
  assert.deepEqual(R.listPublicRooms(db, b), []);
});

test('공개 참가: 공개 방 가입, 이미 멤버면 그대로, 비공개는 FORBIDDEN, 없는 방은 NOT_FOUND', () => {
  const { db, ids: [a, b] } = setup();
  const pub = R.createRoom(db, a, { name: '공개' });
  const priv = R.createRoom(db, a, { name: '비공개' });
  R.setRoomSettings(db, a, priv.id, { isPublic: false });
  assert.equal(R.joinPublicRoom(db, b, pub.id).id, pub.id);
  R.joinPublicRoom(db, b, pub.id);
  assert.equal(R.getRoomState(db, a, pub.id).members.length, 2);
  assert.throws(() => R.joinPublicRoom(db, b, priv.id), forbidden);
  assert.throws(() => R.joinPublicRoom(db, b, 999), { message: 'NOT_FOUND' });
  // 초대 코드 참가는 공개 방에도 그대로
  assert.equal(R.joinRoom(db, b, { inviteCode: priv.inviteCode }).id, priv.id);
});

test('isPublic 은 방장만 바꾸고 불리언만 받는다', () => {
  const { db, ids: [a, b] } = setup();
  const room = R.createRoom(db, a, { name: '방' });
  R.joinRoom(db, b, { inviteCode: room.inviteCode });
  assert.throws(() => R.setRoomSettings(db, b, room.id, { isPublic: false }), forbidden);
  assert.throws(() => R.setRoomSettings(db, a, room.id, { isPublic: 'no' }), { message: 'INVALID_INPUT' });
  assert.equal(R.setRoomSettings(db, a, room.id, { isPublic: false }).isPublic, false);
  assert.equal(R.setRoomSettings(db, a, room.id, { defaultEffort: 'low' }).isPublic, false); // 주지 않으면 유지
});

test('옛 DB(is_public 칸 없음)를 열면 기존 방도 공개로 덧붙는다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rooms-old-'));
  const file = path.join(dir, 'old.db');
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT, password_hash TEXT, name TEXT, created_at INTEGER);
    CREATE TABLE rooms (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, invite_code TEXT NOT NULL UNIQUE,
      owner_id INTEGER NOT NULL, claude_session_id TEXT, transcript_version INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
    INSERT INTO rooms (name, invite_code, owner_id, created_at) VALUES ('옛 방', 'AAAAAA', 1, 1);`);
  old.close();
  const db = openDb(file);
  assert.equal(db.prepare('SELECT is_public, fork_pending FROM rooms').get().is_public, 1);
  assert.equal(db.prepare('SELECT fork_pending FROM rooms').get().fork_pending, 0);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('fork: 멤버만, 레포·멤버·기본값 복사, 방장=요청자, 안내 1건, 세션 있으면 fork_pending', () => {
  const { db, ids: [a, b, c] } = setup();
  const room = R.createRoom(db, a, { name: '원래' });
  R.joinRoom(db, b, { inviteCode: room.inviteCode });
  R.setRoomSettings(db, a, room.id, { defaultModel: 'opus', defaultEffort: 'high', isPublic: false });
  R.addRepo(db, a, room.id, { name: 'r', remoteUrl: 'git@h:a/r.git', branch: 'dev' });
  db.prepare("UPDATE rooms SET claude_session_id = 'S1', transcript_version = 4 WHERE id = ?").run(room.id);
  db.prepare("INSERT INTO messages (room_id, user_id, kind, body, created_at) VALUES (?, ?, 'chat', '옛 채팅', 1)").run(room.id, a);

  assert.throws(() => R.forkRoom(db, c, room.id, { name: 'x' }), forbidden);
  assert.throws(() => R.forkRoom(db, b, 999, { name: 'x' }), { message: 'NOT_FOUND' });
  assert.throws(() => R.forkRoom(db, b, room.id, { name: ' ' }), { message: 'INVALID_INPUT' });

  const copied = [];
  const f = R.forkRoom(db, b, room.id, { name: '갈래', copyFiles: (id) => copied.push(id) });
  assert.deepEqual(copied, [f.id]);
  assert.notEqual(f.inviteCode, room.inviteCode);
  assert.deepEqual([f.ownerId, f.name, f.isPublic, f.defaultModel, f.defaultEffort], [b, '갈래', true, 'opus', 'high']);
  assert.deepEqual([f.claudeSessionId, f.transcriptVersion], ['S1', 4]);
  assert.equal(db.prepare('SELECT fork_pending FROM rooms WHERE id = ?').get(f.id).fork_pending, 1);
  const st = R.getRoomState(db, a, f.id);
  assert.deepEqual(st.members.map((m) => [m.userId, m.isOwner]).sort(), [[a, false], [b, true]]);
  assert.deepEqual(st.repos.map((r) => [r.name, r.remoteUrl, r.branch]), [['r', 'git@h:a/r.git', 'dev']]);
  assert.notEqual(st.repos[0].id, R.getRoomState(db, a, room.id).repos[0].id);
  const msgs = db.prepare('SELECT user_id, kind, body FROM messages WHERE room_id = ?').all(f.id);
  assert.deepEqual(msgs.map((m) => ({ ...m })), [{ user_id: null, kind: 'notice', body: '원래 방에서 갈라졌어요' }]);
  // 원래 방은 그대로
  assert.equal(R.getRoomState(db, a, room.id).room.claudeSessionId, 'S1');
});

test('fork: 세션 없는 방은 fork_pending 0, 파일 복사가 실패하면 방도 안 남는다', () => {
  const { db, ids: [a] } = setup(1);
  const room = R.createRoom(db, a, { name: '새 방' });
  const f = R.forkRoom(db, a, room.id, { name: '갈래' });
  assert.equal(f.claudeSessionId, null);
  assert.equal(db.prepare('SELECT fork_pending FROM rooms WHERE id = ?').get(f.id).fork_pending, 0);
  const before = count(db, 'rooms');
  assert.throws(() => R.forkRoom(db, a, room.id, { name: 'x', copyFiles: () => { throw new Error('DISK'); } }), { message: 'DISK' });
  assert.equal(count(db, 'rooms'), before);
});
