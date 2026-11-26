import { randomInt } from 'node:crypto';

const CODE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

const toRoom = (r) => r && ({
  id: r.id, name: r.name, inviteCode: r.invite_code, ownerId: r.owner_id,
  claudeSessionId: r.claude_session_id, transcriptVersion: r.transcript_version,
  createdAt: r.created_at,
});
const toRepo = (r) => r && ({ id: r.id, name: r.name, remoteUrl: r.remote_url, branch: r.branch });

function text(v) {
  const s = String(v ?? '').trim();
  if (!s) throw new Error('INVALID_INPUT');
  return s;
}

function tx(db, fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function roomRow(db, roomId) {
  const r = db.prepare('SELECT * FROM rooms WHERE id = ?').get(roomId);
  if (!r) throw new Error('NOT_FOUND');
  return r;
}

function ownedRoom(db, userId, roomId) {
  const r = roomRow(db, roomId);
  if (r.owner_id !== userId) throw new Error('FORBIDDEN');
  return r;
}

function newCode(db) {
  for (;;) {
    let c = '';
    for (let i = 0; i < 6; i++) c += CODE_CHARS[randomInt(CODE_CHARS.length)];
    if (!db.prepare('SELECT 1 FROM rooms WHERE invite_code = ?').get(c)) return c;
  }
}

export function isMember(db, userId, roomId) {
  return !!db.prepare('SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?').get(roomId, userId);
}

export function createRoom(db, userId, { name }) {
  name = text(name);
  return tx(db, () => {
    const now = Date.now();
    const id = Number(db.prepare(
      'INSERT INTO rooms (name, invite_code, owner_id, created_at) VALUES (?, ?, ?, ?)',
    ).run(name, newCode(db), userId, now).lastInsertRowid);
    db.prepare('INSERT INTO room_members (room_id, user_id, joined_at) VALUES (?, ?, ?)').run(id, userId, now);
    return toRoom(roomRow(db, id));
  });
}

export function joinRoom(db, userId, { inviteCode }) {
  const code = String(inviteCode ?? '').trim().toUpperCase();
  const r = db.prepare('SELECT * FROM rooms WHERE invite_code = ?').get(code);
  if (!r) throw new Error('NOT_FOUND');
  if (!isMember(db, userId, r.id)) {
    db.prepare('INSERT INTO room_members (room_id, user_id, joined_at) VALUES (?, ?, ?)')
      .run(r.id, userId, Date.now());
  }
  return toRoom(r);
}

export function leaveRoom(db, userId, roomId) {
  tx(db, () => {
    const r = roomRow(db, roomId);
    if (!isMember(db, userId, roomId)) throw new Error('NOT_FOUND');
    db.prepare('DELETE FROM room_members WHERE room_id = ? AND user_id = ?').run(roomId, userId);
    if (r.owner_id !== userId) return;
    const next = db.prepare(
      'SELECT user_id FROM room_members WHERE room_id = ? ORDER BY joined_at, user_id LIMIT 1',
    ).get(roomId);
    if (next) db.prepare('UPDATE rooms SET owner_id = ? WHERE id = ?').run(next.user_id, roomId);
  });
}

export function renameRoom(db, userId, roomId, { name }) {
  ownedRoom(db, userId, roomId);
  db.prepare('UPDATE rooms SET name = ? WHERE id = ?').run(text(name), roomId);
  return toRoom(roomRow(db, roomId));
}

export function regenerateInvite(db, userId, roomId) {
  ownedRoom(db, userId, roomId);
  db.prepare('UPDATE rooms SET invite_code = ? WHERE id = ?').run(newCode(db), roomId);
  return toRoom(roomRow(db, roomId));
}

export function deleteRoom(db, userId, roomId) {
  ownedRoom(db, userId, roomId);
  db.prepare('DELETE FROM rooms WHERE id = ?').run(roomId);
}

export function listRooms(db, userId) {
  return db.prepare(
    `SELECT r.* FROM rooms r JOIN room_members m ON m.room_id = r.id
     WHERE m.user_id = ? ORDER BY r.created_at DESC, r.id DESC`,
  ).all(userId).map(toRoom);
}

export function getRoomState(db, userId, roomId) {
  const r = roomRow(db, roomId);
  if (!isMember(db, userId, roomId)) throw new Error('FORBIDDEN');
  const members = db.prepare(
    `SELECT u.id, u.name, m.joined_at FROM room_members m JOIN users u ON u.id = m.user_id
     WHERE m.room_id = ? ORDER BY m.joined_at, u.id`,
  ).all(roomId).map((m) => ({
    userId: m.id, name: m.name, joinedAt: m.joined_at, isOwner: m.id === r.owner_id,
  }));
  const repos = db.prepare('SELECT * FROM room_repos WHERE room_id = ? ORDER BY id').all(roomId).map(toRepo);
  return { room: toRoom(r), members, repos };
}

export function addRepo(db, userId, roomId, { name, remoteUrl, branch }) {
  ownedRoom(db, userId, roomId);
  const id = Number(db.prepare(
    'INSERT INTO room_repos (room_id, name, remote_url, branch) VALUES (?, ?, ?, ?)',
  ).run(roomId, text(name), text(remoteUrl), text(branch)).lastInsertRowid);
  return toRepo(db.prepare('SELECT * FROM room_repos WHERE id = ?').get(id));
}

function ownedRepo(db, userId, repoId) {
  const repo = db.prepare('SELECT * FROM room_repos WHERE id = ?').get(repoId);
  if (!repo) throw new Error('NOT_FOUND');
  ownedRoom(db, userId, repo.room_id);
  return repo;
}

export function updateRepo(db, userId, repoId, patch) {
  const repo = ownedRepo(db, userId, repoId);
  const next = {
    name: repo.name, remote_url: repo.remote_url, branch: repo.branch,
  };
  if (patch.name !== undefined) next.name = text(patch.name);
  if (patch.remoteUrl !== undefined) next.remote_url = text(patch.remoteUrl);
  if (patch.branch !== undefined) next.branch = text(patch.branch);
  db.prepare('UPDATE room_repos SET name = ?, remote_url = ?, branch = ? WHERE id = ?')
    .run(next.name, next.remote_url, next.branch, repoId);
  return toRepo(db.prepare('SELECT * FROM room_repos WHERE id = ?').get(repoId));
}

export function removeRepo(db, userId, repoId) {
  ownedRepo(db, userId, repoId);
  db.prepare('DELETE FROM room_repos WHERE id = ?').run(repoId);
}
