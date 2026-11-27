import { randomInt } from 'node:crypto';

const CODE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

const toRoom = (r) => r && ({
  id: r.id, name: r.name, inviteCode: r.invite_code, ownerId: r.owner_id,
  claudeSessionId: r.claude_session_id, transcriptVersion: r.transcript_version,
  createdAt: r.created_at, defaultModel: r.default_model ?? '', defaultEffort: r.default_effort ?? '',
  isPublic: r.is_public !== 0,
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

/** 공개 방에 초대 코드 없이 가입(이미 멤버면 그대로). 비공개 방은 FORBIDDEN */
export function joinPublicRoom(db, userId, roomId) {
  const r = roomRow(db, roomId);
  if (r.is_public === 0) throw new Error('FORBIDDEN');
  if (!isMember(db, userId, r.id)) {
    db.prepare('INSERT INTO room_members (room_id, user_id, joined_at) VALUES (?, ?, ?)')
      .run(r.id, userId, Date.now());
  }
  return toRoom(r);
}

/** 내가 멤버가 아닌 공개 방(초대 코드는 싣지 않는다) */
export function listPublicRooms(db, userId) {
  return db.prepare(
    `SELECT r.id, r.name, r.created_at, (SELECT COUNT(*) FROM room_members WHERE room_id = r.id) AS n
     FROM rooms r WHERE r.is_public = 1
       AND NOT EXISTS (SELECT 1 FROM room_members m WHERE m.room_id = r.id AND m.user_id = ?)
     ORDER BY r.created_at DESC, r.id DESC`,
  ).all(userId).map((r) => ({ id: r.id, name: r.name, memberCount: r.n, createdAt: r.created_at }));
}

/**
 * 방 멤버가 이 방의 설정·멤버·대화 세션을 이어 받는 새 방을 만든다(방장=요청자, 채팅은 복사하지 않음).
 * copyFiles(새 방 id) 는 같은 트랜잭션 안에서 불러 파일 복사가 실패하면 방도 만들어지지 않게 한다
 */
export function forkRoom(db, userId, roomId, { name, copyFiles }) {
  const src = roomRow(db, roomId);
  if (!isMember(db, userId, roomId)) throw new Error('FORBIDDEN');
  name = text(name);
  return tx(db, () => {
    const now = Date.now();
    const id = Number(db.prepare(
      `INSERT INTO rooms (name, invite_code, owner_id, claude_session_id, transcript_version,
         default_model, default_effort, fork_pending, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(name, newCode(db), userId, src.claude_session_id, src.transcript_version,
      src.default_model, src.default_effort, src.claude_session_id ? 1 : 0, now).lastInsertRowid);
    db.prepare(
      `INSERT INTO room_members (room_id, user_id, joined_at)
       SELECT ?, user_id, joined_at FROM room_members WHERE room_id = ?`,
    ).run(id, roomId);
    db.prepare(
      `INSERT INTO room_repos (room_id, name, remote_url, branch)
       SELECT ?, name, remote_url, branch FROM room_repos WHERE room_id = ? ORDER BY id`,
    ).run(id, roomId);
    db.prepare(
      "INSERT INTO messages (room_id, user_id, kind, body, created_at) VALUES (?, NULL, 'notice', ?, ?)",
    ).run(id, `${src.name} 방에서 갈라졌어요`, now);
    copyFiles?.(id);
    return toRoom(roomRow(db, id));
  });
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

const MODEL = /^(|opus|sonnet|haiku|fable|claude-[a-z0-9.-]+)$/;
const EFFORT = /^(|low|medium|high|xhigh|max)$/;

/** 방 기본 모델·노력 단계·공개 여부(방장만). 주지 않은 값은 그대로 둔다 */
export function setRoomSettings(db, userId, roomId, { defaultModel, defaultEffort, isPublic }) {
  const r = ownedRoom(db, userId, roomId);
  const pick = (v, re, old) => {
    if (v === undefined) return old ?? '';
    if (typeof v !== 'string' || !re.test(v)) throw new Error('INVALID_INPUT');
    return v;
  };
  const model = pick(defaultModel, MODEL, r.default_model);
  const effort = pick(defaultEffort, EFFORT, r.default_effort);
  if (isPublic !== undefined && typeof isPublic !== 'boolean') throw new Error('INVALID_INPUT');
  const pub = isPublic === undefined ? r.is_public : Number(isPublic);
  db.prepare('UPDATE rooms SET default_model = ?, default_effort = ?, is_public = ? WHERE id = ?').run(model, effort, pub, roomId);
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

/**
 * 실행 중 Claude 가 옮긴 레포 브랜치 검사(요청자 확인은 호출부). 이 방 레포가 아니거나 이름이 잘못이면 INVALID_INPUT
 * 이름 규칙은 addRepo·updateRepo 와 같고(공백 제거·빈 값 금지), 다른 사람 맥에서 git 옵션으로 읽히지 않게 - 로 시작하는 것만 더 막는다
 * @returns {{id: number, branch: string}[]}
 */
export function checkRunBranches(db, roomId, list) {
  if (!Array.isArray(list)) throw new Error('INVALID_INPUT');
  return list.map((c) => {
    if (!c || typeof c.branch !== 'string') throw new Error('INVALID_INPUT');
    const branch = text(c.branch);
    const row = db.prepare('SELECT id FROM room_repos WHERE id = ? AND room_id = ?').get(Number(c.repoId), roomId);
    if (!row || branch.startsWith('-')) throw new Error('INVALID_INPUT');
    return { id: row.id, branch };
  });
}

/** checkRunBranches 를 통과한 값을 반영한다(방장 검사 없음. 호출부의 트랜잭션 안에서 쓴다) */
export function setRunBranches(db, list) {
  for (const { id, branch } of list) db.prepare('UPDATE room_repos SET branch = ? WHERE id = ?').run(branch, id);
}
