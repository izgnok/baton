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
  assert.deepEqual(up, {
    id: repo.id, name: 'r', remoteUrl: 'git@h:a/r.git', baseBranch: 'develop', workBranch: '', originBranch: 'develop', branch: 'develop', code: null,
  });
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

test('옛 스키마 DB(room_repos.branch)를 열면 base_branch 로 옮겨지고 work·origin 칸이 생기며 데이터는 남는다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rooms-old-repo-'));
  const file = path.join(dir, 'rooms.db');
  try {
    const old = new DatabaseSync(file);
    old.exec(`
      CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, name TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE rooms (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, invite_code TEXT NOT NULL UNIQUE,
        owner_id INTEGER NOT NULL REFERENCES users(id), claude_session_id TEXT, transcript_version INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
      CREATE TABLE room_repos (id INTEGER PRIMARY KEY AUTOINCREMENT, room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        name TEXT NOT NULL, remote_url TEXT NOT NULL, branch TEXT NOT NULL);
      INSERT INTO users (email, password_hash, name, created_at) VALUES ('a@x.com', 'h', 'a', 1);
      INSERT INTO rooms (name, invite_code, owner_id, created_at) VALUES ('옛 방', 'OLD123', 1, 1);
      INSERT INTO room_repos (room_id, name, remote_url, branch) VALUES (1, 'insight', 'git@h:a/insight.git', 'release/15.6.0');
    `);
    old.close();
    const check = (db) => {
      const cols = db.prepare('PRAGMA table_info(room_repos)').all().map((c) => c.name);
      assert.ok(!cols.includes('branch') && cols.includes('base_branch'));
      const [repo] = R.getRoomState(db, 1, 1).repos;
      assert.deepEqual(repo, {
        id: 1, name: 'insight', remoteUrl: 'git@h:a/insight.git', baseBranch: 'release/15.6.0', workBranch: '',
        originBranch: 'release/15.6.0', branch: 'release/15.6.0', code: null,
      });
    };
    const db = openDb(file);
    db.prepare('INSERT INTO room_members (room_id, user_id, joined_at) VALUES (1, 1, 1)').run();
    check(db);
    assert.equal(count(db, 'code_states'), 0);
    db.close();
    const again = openDb(file); // 다시 열어도 문제없다
    check(again);
    again.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('setRepo: 추가(이름 기본값·같은 원격 두 번)·수정(안 준 값 유지)·검사, 기준·원격이 바뀌면 코드 상태 삭제', () => {
  const { db, ids: [a] } = setup(1);
  const room = R.createRoom(db, a, { name: '방' });
  const other = R.createRoom(db, a, { name: '다른 방' });
  const bad = { message: 'INVALID_INPUT' };
  const one = R.setRepo(db, room.id, { remoteUrl: ' git@h:a/insight.git ', baseBranch: ' release/15.7.0 ', workBranch: 'feature/X' }).repo;
  assert.deepEqual([one.name, one.remoteUrl, one.baseBranch, one.workBranch, one.originBranch, one.branch, one.code],
    ['insight', 'git@h:a/insight.git', 'release/15.7.0', 'feature/X', 'release/15.7.0', 'release/15.7.0', null]);
  assert.equal(R.setRepo(db, room.id, { remoteUrl: 'https://h/a/mod.git/', baseBranch: 'dev', name: ' 이름 ' }).repo.name, '이름');
  assert.equal(R.setRepo(db, room.id, { remoteUrl: 'https://h/a/mod/', baseBranch: 'dev' }).repo.name, 'mod');
  assert.equal(R.setRepo(db, room.id, { remoteUrl: 'git@h:a/insight.git', baseBranch: 'develop', workBranch: '' }).repo.workBranch, '');
  assert.equal(R.getRoomState(db, a, room.id).repos.length, 4); // 같은 원격도 추가
  for (const p of [{ remoteUrl: '', baseBranch: 'b' }, { remoteUrl: 'u', baseBranch: '' }, { remoteUrl: 'u', baseBranch: ' ' },
    { remoteUrl: 'u', baseBranch: '-x' }, { remoteUrl: 'u', baseBranch: 'b', workBranch: '-y' }, { remoteUrl: 'u', baseBranch: 'b', workBranch: 5 },
    { remoteUrl: 'u', baseBranch: 'b', name: ' ' }, { remoteUrl: 'u', baseBranch: 'b', repoId: 999 }, { remoteUrl: '/', baseBranch: 'b' }]) {
    assert.throws(() => R.setRepo(db, room.id, p), bad, JSON.stringify(p));
  }
  const foreign = R.setRepo(db, other.id, { remoteUrl: 'u', baseBranch: 'b' }).repo;
  assert.throws(() => R.setRepo(db, room.id, { repoId: foreign.id, remoteUrl: 'u', baseBranch: 'b' }), bad);
  assert.equal(count(db, 'room_repos'), 5);

  const code = (id) => db.prepare(
    `INSERT INTO code_states (repo_id, base_commit, snapshot, size, updated_by, updated_at) VALUES (?, ?, ?, 3, ?, 7)`,
  ).run(id, '1'.repeat(40), '2'.repeat(40), a);
  code(one.id);
  // 작업 브랜치·이름만 바꾸면 코드 상태는 그대로, 안 준 name·workBranch 는 유지
  const kept = R.setRepo(db, room.id, { repoId: one.id, remoteUrl: one.remoteUrl, baseBranch: one.baseBranch, workBranch: 'feature/Y' });
  assert.equal(kept.codeCleared, false);
  assert.deepEqual([kept.repo.name, kept.repo.workBranch, kept.repo.code.snapshot, kept.repo.code.updatedBy], ['insight', 'feature/Y', '2'.repeat(40), a]);
  assert.equal(R.setRepo(db, room.id, { repoId: one.id, remoteUrl: one.remoteUrl, baseBranch: one.baseBranch }).repo.workBranch, 'feature/Y');
  // 기준이 바뀌면 처음 갈라진 곳도 새 기준, 코드 상태 삭제
  const moved = R.setRepo(db, room.id, { repoId: one.id, remoteUrl: one.remoteUrl, baseBranch: 'develop' });
  assert.equal(moved.codeCleared, true);
  assert.deepEqual([moved.repo.baseBranch, moved.repo.originBranch, moved.repo.code], ['develop', 'develop', null]);
  // 원격이 바뀌어도 비운다
  code(one.id);
  assert.equal(R.setRepo(db, room.id, { repoId: one.id, remoteUrl: 'git@h:a/other.git', baseBranch: 'develop' }).codeCleared, true);
  assert.equal(count(db, 'code_states'), 0);

  R.removeRoomRepo(db, room.id, one.id);
  assert.throws(() => R.removeRoomRepo(db, room.id, one.id), bad);
  assert.throws(() => R.removeRoomRepo(db, room.id, foreign.id), bad);
});

test('setRunBranches·updateRepo: 기준이 바뀐 레포는 코드 상태를 비우고, 같으면 그대로', () => {
  const { db, ids: [a] } = setup(1);
  const room = R.createRoom(db, a, { name: '방' });
  const r1 = R.addRepo(db, a, room.id, { name: 'r1', remoteUrl: 'u1', branch: 'main' });
  const r2 = R.addRepo(db, a, room.id, { name: 'r2', remoteUrl: 'u2', branch: 'main' });
  for (const id of [r1.id, r2.id]) {
    db.prepare("INSERT INTO code_states VALUES (?, ?, ?, 1, NULL, 1)").run(id, '1'.repeat(40), '2'.repeat(40));
  }
  const ok = R.checkRunBranches(db, room.id, [{ repoId: r1.id, branch: 'main' }, { repoId: r2.id, branch: 'dev' }]);
  assert.deepEqual(R.setRunBranches(db, ok), [r2.id]);
  assert.deepEqual(R.getRoomState(db, a, room.id).repos.map((r) => r.code !== null), [true, false]);
  R.updateRepo(db, a, r1.id, { name: '새 이름' });
  assert.notEqual(R.getRoomState(db, a, room.id).repos[0].code, null);
  R.updateRepo(db, a, r1.id, { branch: 'dev' });
  assert.equal(R.getRoomState(db, a, room.id).repos[0].code, null);
  assert.equal(R.getRoomState(db, a, room.id).repos[0].originBranch, 'dev');
});

test('checkCodeStates: 형식·올라온 파일 확인, 둘 다 null 이면 비우기', () => {
  const H = '1'.repeat(40);
  const up = 'a'.repeat(32);
  const files = { hasUpload: (roomId, id) => roomId === 1 && id === up };
  const good = { repoId: 1, baseBranch: 'b', baseCommit: H, snapshot: '2'.repeat(64), prevSnapshot: null, uploadId: up };
  assert.deepEqual(R.checkCodeStates(files, 1, [good]), [good]);
  assert.deepEqual(R.checkCodeStates(files, 1, [{ ...good, prevSnapshot: H }]), [{ ...good, prevSnapshot: H }]);
  assert.deepEqual(R.checkCodeStates(files, 1, [{ repoId: 1, baseBranch: 'b', snapshot: null, uploadId: null }]),
    [{ repoId: 1, baseBranch: 'b', uploadId: null }]);
  assert.deepEqual(R.checkCodeStates(files, 1, []), []);
  const bad = { message: 'INVALID_INPUT' };
  for (const p of [undefined, {}, [null], [{ ...good, repoId: '1' }], [{ ...good, baseBranch: 1 }], [{ ...good, baseCommit: 'abc' }],
    [{ ...good, snapshot: 'G'.repeat(40) }], [{ ...good, snapshot: 'A'.repeat(40) }], [{ ...good, uploadId: 5 }], [{ ...good, prevSnapshot: undefined }], [{ ...good, prevSnapshot: 'abc' }], [{ ...good, prevSnapshot: 1 }],
    [{ ...good, uploadId: '../x' }], [{ ...good, uploadId: 'b'.repeat(32) }], [{ ...good, uploadId: null }],
    [{ ...good, snapshot: null }], [good, good], [{ repoId: 1, baseBranch: 'b', snapshot: null, uploadId: null }, null]]) {
    assert.throws(() => R.checkCodeStates(files, 1, p), bad, JSON.stringify(p));
  }
  assert.throws(() => R.checkCodeStates(files, 2, [good]), bad); // 다른 방의 업로드
  assert.throws(() => R.checkPromoted(['1']), bad);
  assert.deepEqual(R.checkPromoted([1, 2]), [1, 2]);
});

test('fork: 레포 브랜치 3개·코드 상태를 새 레포 id 로 복사하고 copyFiles 에 옛 id → 새 id 를 넘긴다', () => {
  const { db, ids: [a] } = setup(1);
  const room = R.createRoom(db, a, { name: '원래' });
  const one = R.setRepo(db, room.id, { remoteUrl: 'u1', baseBranch: 'develop', workBranch: 'feature/X' }).repo;
  const two = R.setRepo(db, room.id, { remoteUrl: 'u2', baseBranch: 'main' }).repo;
  db.prepare("INSERT INTO code_states VALUES (?, ?, ?, 9, ?, 5)").run(one.id, '1'.repeat(40), '2'.repeat(40), a);
  db.prepare("INSERT INTO code_parts VALUES (?, 1, NULL, ?, ?, 4, 5)").run(one.id, '8'.repeat(40), '1'.repeat(40));
  db.prepare("INSERT INTO code_parts VALUES (?, 2, ?, ?, ?, 5, 6)").run(one.id, '8'.repeat(40), '2'.repeat(40), '1'.repeat(40));
  db.prepare('UPDATE room_repos SET origin_branch = ? WHERE id = ?').run('release/1', one.id);
  let map;
  const f = R.forkRoom(db, a, room.id, { name: '갈래', copyFiles: (id, m) => { map = m; } });
  const repos = R.getRoomState(db, a, f.id).repos;
  assert.deepEqual([...map.keys()], [one.id, two.id]);
  assert.deepEqual([...map.values()], repos.map((r) => r.id));
  assert.deepEqual(repos.map((r) => [r.baseBranch, r.workBranch, r.originBranch]),
    [['develop', 'feature/X', 'release/1'], ['main', '', 'main']]);
  assert.deepEqual(repos[0].code, { baseCommit: '1'.repeat(40), snapshot: '2'.repeat(40), size: 9, parts: 2, updatedBy: a, updatedAt: 5 });
  assert.deepEqual(R.listCodeParts(db, repos[0].id), [
    { seq: 1, prevSnapshot: null, snapshot: '8'.repeat(40), baseCommit: '1'.repeat(40), size: 4 },
    { seq: 2, prevSnapshot: '8'.repeat(40), snapshot: '2'.repeat(40), baseCommit: '1'.repeat(40), size: 5 },
  ]);
  assert.deepEqual(R.listCodeParts(db, one.id).map((p) => p.seq), [1, 2]); // 원래 방은 그대로
  assert.equal(repos[1].code, null);
  // 원래 방은 그대로
  assert.deepEqual(R.getRoomState(db, a, room.id).repos.map((r) => [r.id, r.code !== null]), [[one.id, true], [two.id, false]]);
});
