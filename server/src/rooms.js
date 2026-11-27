import { randomInt } from 'node:crypto';

const CODE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

const toRoom = (r) => r && ({
  id: r.id, name: r.name, inviteCode: r.invite_code, ownerId: r.owner_id,
  claudeSessionId: r.claude_session_id, transcriptVersion: r.transcript_version,
  createdAt: r.created_at, defaultModel: r.default_model ?? '', defaultEffort: r.default_effort ?? '',
  isPublic: r.is_public !== 0,
});
// 레포 + 코드 상태(없으면 code: null). branch 는 baseBranch 별칭 — 앱이 정리되면(3단계) 뺀다
const REPO_SELECT = `SELECT r.*, c.base_commit AS cs_base, c.snapshot AS cs_snapshot, c.size AS cs_size,
  c.updated_by AS cs_by, c.updated_at AS cs_at,
  (SELECT COUNT(*) FROM code_parts p WHERE p.repo_id = r.id) AS cs_parts
  FROM room_repos r LEFT JOIN code_states c ON c.repo_id = r.id`;
const toRepo = (r) => r && ({
  id: r.id, name: r.name, remoteUrl: r.remote_url,
  baseBranch: r.base_branch, workBranch: r.work_branch, originBranch: r.origin_branch ?? r.base_branch,
  branch: r.base_branch,
  code: r.cs_snapshot ? {
    baseCommit: r.cs_base, snapshot: r.cs_snapshot, size: r.cs_size, parts: r.cs_parts, updatedBy: r.cs_by, updatedAt: r.cs_at,
  } : null,
});
const repoById = (db, id) => toRepo(db.prepare(`${REPO_SELECT} WHERE r.id = ?`).get(id));

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
 * copyFiles(새 방 id, 옛 레포 id → 새 레포 id Map) 는 같은 트랜잭션 안에서 불러 파일 복사가 실패하면 방도 만들어지지 않게 한다
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
    // 레포를 하나씩 복사해 옛 id → 새 id 를 만든다(코드 상태 행도 새 id 로)
    const repoMap = new Map();
    for (const r of db.prepare('SELECT * FROM room_repos WHERE room_id = ? ORDER BY id').all(roomId)) {
      const newId = Number(db.prepare(
        `INSERT INTO room_repos (room_id, name, remote_url, base_branch, work_branch, origin_branch)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(id, r.name, r.remote_url, r.base_branch, r.work_branch, r.origin_branch).lastInsertRowid);
      repoMap.set(r.id, newId);
      db.prepare(
        `INSERT INTO code_states (repo_id, base_commit, snapshot, size, updated_by, updated_at)
         SELECT ?, base_commit, snapshot, size, updated_by, updated_at FROM code_states WHERE repo_id = ?`,
      ).run(newId, r.id);
      db.prepare(
        `INSERT INTO code_parts (repo_id, seq, prev_snapshot, snapshot, base_commit, size, created_at)
         SELECT ?, seq, prev_snapshot, snapshot, base_commit, size, created_at FROM code_parts WHERE repo_id = ?`,
      ).run(newId, r.id);
    }
    db.prepare(
      "INSERT INTO messages (room_id, user_id, kind, body, created_at) VALUES (?, NULL, 'notice', ?, ?)",
    ).run(id, `${src.name} 방에서 갈라졌어요`, now);
    copyFiles?.(id, repoMap);
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
  const repos = db.prepare(`${REPO_SELECT} WHERE r.room_id = ? ORDER BY r.id`).all(roomId).map(toRepo);
  return { room: toRoom(r), members, repos };
}

export function addRepo(db, userId, roomId, { name, remoteUrl, branch }) {
  ownedRoom(db, userId, roomId);
  const base = text(branch);
  const id = Number(db.prepare(
    'INSERT INTO room_repos (room_id, name, remote_url, base_branch, origin_branch) VALUES (?, ?, ?, ?, ?)',
  ).run(roomId, text(name), text(remoteUrl), base, base).lastInsertRowid);
  return repoById(db, id);
}

function ownedRepo(db, userId, repoId) {
  const repo = db.prepare('SELECT * FROM room_repos WHERE id = ?').get(repoId);
  if (!repo) throw new Error('NOT_FOUND');
  ownedRoom(db, userId, repo.room_id);
  return repo;
}

/** 레포의 코드 상태 행과 조각 행(체인)을 모두 지운다. 코드 상태가 있었으면 true. 조각 파일은 호출부가 지운다 */
function dropCode(db, repoId) {
  db.prepare('DELETE FROM code_parts WHERE repo_id = ?').run(repoId);
  return db.prepare('DELETE FROM code_states WHERE repo_id = ?').run(repoId).changes > 0;
}

/**
 * 기준 브랜치를 바꾸고(처음 갈라진 곳도 새 기준으로) 코드 상태·체인을 지운다. 바뀌었으면 true.
 * 조각 파일은 호출부가 지운다
 */
function resetBase(db, repoId, base) {
  const r = db.prepare('SELECT base_branch FROM room_repos WHERE id = ?').get(repoId);
  if (r.base_branch === base) return false;
  db.prepare('UPDATE room_repos SET base_branch = ?, origin_branch = ? WHERE id = ?').run(base, base, repoId);
  dropCode(db, repoId);
  return true;
}

// 브랜치 이름: 기존 text() 규칙(공백 제거·빈 값 금지)에 더해, 다른 사람 맥에서 git 옵션으로 읽히지 않게 - 로 시작하는 것을 막는다
function branchName(v) {
  const s = text(v);
  if (s.startsWith('-')) throw new Error('INVALID_INPUT');
  return s;
}

export function updateRepo(db, userId, repoId, patch) {
  const repo = ownedRepo(db, userId, repoId);
  const next = {
    name: repo.name, remote_url: repo.remote_url,
  };
  if (patch.name !== undefined) next.name = text(patch.name);
  if (patch.remoteUrl !== undefined) next.remote_url = text(patch.remoteUrl);
  const base = patch.branch !== undefined ? text(patch.branch) : repo.base_branch;
  db.prepare('UPDATE room_repos SET name = ?, remote_url = ? WHERE id = ?').run(next.name, next.remote_url, repoId);
  resetBase(db, repoId, base); // 기준이 바뀌면 코드 상태를 비운다(묶음 파일은 호출부가 지움)
  return repoById(db, repoId);
}

export function removeRepo(db, userId, repoId) {
  ownedRepo(db, userId, repoId);
  db.prepare('DELETE FROM room_repos WHERE id = ?').run(repoId); // code_states 는 CASCADE
}

const repoNameOf = (url) => url.replace(/\/+$/, '').split(/[/:]/).pop().replace(/\.git$/, '');

/**
 * 방 도구(room.repo_set)의 레포 추가·수정. 요청자 확인은 호출부(ws)가 한다.
 * repoId 가 있으면 이 방의 그 레포 수정(안 준 name·workBranch 는 그대로), 없으면 새 레포(같은 remoteUrl 이 있어도 추가).
 * 기준 브랜치나 원격이 바뀌면 코드 상태·체인을 비운다 — 조각 파일 삭제·알림은 호출부 몫(codeCleared)
 * @returns {{repo: object, codeCleared: boolean}}
 */
export function setRepo(db, roomId, { repoId, remoteUrl, name, baseBranch, workBranch }) {
  roomRow(db, roomId);
  const url = text(remoteUrl);
  const base = branchName(baseBranch);
  if (workBranch != null && typeof workBranch !== 'string') throw new Error('INVALID_INPUT');
  const work = workBranch == null ? undefined : workBranch.trim() === '' ? '' : branchName(workBranch);
  const nm = name === undefined || name === null ? undefined : text(name);
  return tx(db, () => {
    if (repoId === undefined || repoId === null) {
      const id = Number(db.prepare(
        `INSERT INTO room_repos (room_id, name, remote_url, base_branch, work_branch, origin_branch)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(roomId, nm ?? text(repoNameOf(url)), url, base, work ?? '', base).lastInsertRowid);
      return { repo: repoById(db, id), codeCleared: false };
    }
    const old = db.prepare('SELECT * FROM room_repos WHERE id = ? AND room_id = ?').get(Number(repoId), roomId);
    if (!old) throw new Error('INVALID_INPUT');
    db.prepare('UPDATE room_repos SET name = ?, remote_url = ?, work_branch = ? WHERE id = ?')
      .run(nm ?? old.name, url, work ?? old.work_branch, old.id);
    let codeCleared = resetBase(db, old.id, base);
    if (url !== old.remote_url && dropCode(db, old.id)) codeCleared = true;
    return { repo: repoById(db, old.id), codeCleared };
  });
}

/** 방 도구(room.repo_remove)의 레포 빼기. 이 방 레포가 아니면 INVALID_INPUT */
export function removeRoomRepo(db, roomId, repoId) {
  const r = db.prepare('DELETE FROM room_repos WHERE id = ? AND room_id = ?').run(Number(repoId), roomId);
  if (!r.changes) throw new Error('INVALID_INPUT');
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

/**
 * checkRunBranches 를 통과한 값을 반영한다(방장 검사 없음. 호출부의 트랜잭션 안에서 쓴다).
 * 기준이 바뀐 레포는 코드 상태를 비운다
 * @returns {number[]} 코드 상태를 비운 레포 id(조각 파일 삭제·알림은 호출부 몫)
 */
export function setRunBranches(db, list) {
  return list.filter(({ id, branch }) => resetBase(db, id, branch)).map((c) => c.id);
}

const COMMIT_ID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const UPLOAD_ID = /^[0-9a-f]{16,64}$/;
const num = (v) => {
  if (!Number.isInteger(v)) throw new Error('INVALID_INPUT');
  return v;
};

/**
 * RUN_FINISH 의 codeStates 검사·해석(아무것도 옮기지 않는다). 어기면 INVALID_INPUT.
 * 조각은 HTTP 로 먼저 올라가 있어야 한다: uploadId 형식과 그 방의 임시 파일 존재를 확인하고, 같은 uploadId 를 두 번 쓰면 거부한다.
 * prevSnapshot 은 이어 붙일 이전 스냅샷(null 이면 체인을 새로 시작).
 * snapshot·uploadId 가 둘 다 null 이면 코드 상태 비우기(uploadId: null)
 * @returns {{repoId: number, baseBranch: string, baseCommit?: string, snapshot?: string, prevSnapshot?: string|null, uploadId: string|null}[]}
 */
export function checkCodeStates(files, roomId, list) {
  if (!Array.isArray(list)) throw new Error('INVALID_INPUT');
  const used = new Set();
  return list.map((e) => {
    if (!e || typeof e.baseBranch !== 'string') throw new Error('INVALID_INPUT');
    const repoId = num(e.repoId);
    if (e.snapshot === null && e.uploadId === null) return { repoId, baseBranch: e.baseBranch, uploadId: null };
    if (typeof e.baseCommit !== 'string' || !COMMIT_ID.test(e.baseCommit)
      || typeof e.snapshot !== 'string' || !COMMIT_ID.test(e.snapshot)
      || (e.prevSnapshot !== null && (typeof e.prevSnapshot !== 'string' || !COMMIT_ID.test(e.prevSnapshot)))
      || typeof e.uploadId !== 'string' || !UPLOAD_ID.test(e.uploadId)
      || used.has(e.uploadId) || !files.hasUpload(roomId, e.uploadId)) throw new Error('INVALID_INPUT');
    used.add(e.uploadId);
    return {
      repoId, baseBranch: e.baseBranch, baseCommit: e.baseCommit, snapshot: e.snapshot,
      prevSnapshot: e.prevSnapshot, uploadId: e.uploadId,
    };
  });
}

/** RUN_FINISH 의 promotedRepoIds 검사 */
export function checkPromoted(list) {
  if (!Array.isArray(list)) throw new Error('INVALID_INPUT');
  return list.map(num);
}

/**
 * push 로 작업 브랜치가 원격에 생긴 레포: 기준 = 작업 브랜치, 작업 = 비움(처음 갈라진 곳은 그대로), 코드 상태·체인 삭제
 * (다음 업로드가 새 기준에서 prevSnapshot null 로 새로 시작한다).
 * 작업 브랜치가 비었거나 이 방 레포가 아니면 건너뛴다. 호출부의 트랜잭션 안에서 쓴다
 * @returns {number[]} 승격한 레포 id(조각 파일 삭제·알림은 호출부 몫)
 */
export function applyPromotions(db, roomId, ids) {
  return ids.filter((id) => {
    const r = db.prepare(
      "UPDATE room_repos SET base_branch = work_branch, work_branch = '' WHERE id = ? AND room_id = ? AND work_branch != ''",
    ).run(id, roomId);
    if (r.changes) dropCode(db, id);
    return r.changes > 0;
  });
}

/**
 * checkCodeStates 를 통과한 값을 반영한다(호출부의 트랜잭션 안에서 쓴다).
 * - 이 방 레포가 아니거나 서버의 지금 기준 브랜치가 다르면(실행 중 기준이 바뀜) 건너뛰고 임시 파일을 지운다
 * - 비우기 항목: 체인 전체(행·파일) 삭제
 * - prevSnapshot null: 체인을 모두 지우고 seq 1 로 새로 시작
 * - prevSnapshot 이 서버의 지금 snapshot 과 같으면 다음 seq 로 이어 붙임, 다르면(어긋남) 건너뛰고 임시 파일 삭제
 * 코드 상태 행은 최신 snapshot·기준 커밋과 체인 전체 크기(합)를 담는다
 * @returns {number[]} 바뀐 레포 id
 */
export function applyCodeStates(db, files, roomId, userId, entries) {
  const changed = [];
  for (const e of entries) {
    const row = db.prepare('SELECT id, base_branch FROM room_repos WHERE id = ? AND room_id = ?').get(e.repoId, roomId);
    if (!row || row.base_branch !== e.baseBranch) {
      if (e.uploadId) files.removeUpload(roomId, e.uploadId);
      continue;
    }
    if (!e.uploadId) {
      dropCode(db, row.id);
      files.removeParts(roomId, row.id);
      changed.push(row.id);
      continue;
    }
    const cur = db.prepare('SELECT snapshot FROM code_states WHERE repo_id = ?').get(row.id);
    let seq = 1;
    if (e.prevSnapshot === null) {
      dropCode(db, row.id);
      files.removeParts(roomId, row.id);
    } else if (cur && cur.snapshot === e.prevSnapshot) {
      seq = db.prepare('SELECT MAX(seq) AS m FROM code_parts WHERE repo_id = ?').get(row.id).m + 1;
    } else {
      files.removeUpload(roomId, e.uploadId);
      continue;
    }
    const size = files.adoptUpload(roomId, row.id, seq, e.uploadId);
    const now = Date.now();
    db.prepare(
      `INSERT INTO code_parts (repo_id, seq, prev_snapshot, snapshot, base_commit, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(row.id, seq, e.prevSnapshot, e.snapshot, e.baseCommit, size, now);
    const total = db.prepare('SELECT SUM(size) AS s FROM code_parts WHERE repo_id = ?').get(row.id).s;
    db.prepare(
      `INSERT INTO code_states (repo_id, base_commit, snapshot, size, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(repo_id) DO UPDATE SET base_commit = excluded.base_commit, snapshot = excluded.snapshot,
         size = excluded.size, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    ).run(row.id, e.baseCommit, e.snapshot, total, userId, now);
    changed.push(row.id);
  }
  return changed;
}

/** 이 레포의 조각 목록(seq 순). 없으면 빈 배열 */
export function listCodeParts(db, repoId) {
  return db.prepare('SELECT * FROM code_parts WHERE repo_id = ? ORDER BY seq').all(repoId).map((p) => ({
    seq: p.seq, prevSnapshot: p.prev_snapshot, snapshot: p.snapshot, baseCommit: p.base_commit, size: p.size,
  }));
}

/**
 * 실행 중(running)인 Claude 요청의 요청자 본인인지 확인한다. 아니면 FORBIDDEN
 * @returns {{requestId: number, roomId: number}}
 */
export function ownRunningRequest(db, userId, requestId) {
  const r = db.prepare(
    "SELECT user_id, room_id FROM messages WHERE id = ? AND kind = 'claude_request' AND status = 'running'",
  ).get(Number(requestId));
  if (!r || r.user_id !== userId) throw new Error('FORBIDDEN');
  return { requestId: Number(requestId), roomId: r.room_id };
}
