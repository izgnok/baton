import { MSG, parseClaudeMention } from '@rooms/shared/protocol.js';
import { isMember } from './rooms.js';

const HEARTBEAT_TIMEOUT_MS = 30000;

const SELECT_MSG = `SELECT m.*, u.name AS user_name FROM messages m
  LEFT JOIN users u ON u.id = m.user_id`;

const toMessage = (m) => ({
  id: m.id, roomId: m.room_id, userId: m.user_id, userName: m.user_name ?? null,
  kind: m.kind, body: m.body, status: m.status, requestId: m.request_id,
  error: m.error, createdAt: m.created_at,
});

/**
 * 메시지 저장과 방별 @claude 대기열
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{now?: () => number, isOnline: (userId: number) => boolean,
 *   dispatch: (userId: number, runStart: object) => void,
 *   dispatchCancel?: (userId: number, requestId: number) => void,
 *   broadcast: (roomId: number, payload: object) => void}} deps
 */
export function createQueue(db, { now = Date.now, isOnline, dispatch, dispatchCancel = () => {}, broadcast }) {
  const beats = new Map(); // requestId → 마지막 신호 시각

  const getMessage = (id) => {
    const m = db.prepare(`${SELECT_MSG} WHERE m.id = ?`).get(id);
    return m && toMessage(m);
  };

  function announce(id, type) {
    const message = getMessage(id);
    broadcast(message.roomId, { type, message });
  }

  function setStatus(id, status, error = null) {
    db.prepare('UPDATE messages SET status = ?, error = ? WHERE id = ?').run(status, error, id);
    if (status !== 'running') beats.delete(id);
    announce(id, MSG.MESSAGE_UPDATE);
  }

  function runStart(req) {
    const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(req.room_id);
    const requester = db.prepare('SELECT name FROM users WHERE id = ?').get(req.user_id);
    const { last } = db.prepare(
      `SELECT COALESCE(MAX(id), 0) AS last FROM messages
       WHERE room_id = ? AND kind = 'claude_request' AND status = 'done' AND id < ?`,
    ).get(req.room_id, req.id);
    const chatsSince = db.prepare(
      `SELECT u.name AS name, m.body AS body FROM messages m JOIN users u ON u.id = m.user_id
       WHERE m.room_id = ? AND m.kind = 'chat' AND m.id > ? AND m.id < ? ORDER BY m.id`,
    ).all(req.room_id, last, req.id).map((c) => ({ ...c }));
    return {
      requestId: req.id, roomId: req.room_id, sessionId: room.claude_session_id,
      transcriptVersion: room.transcript_version, fork: room.fork_pending === 1, requesterName: requester.name,
      body: req.body, chatsSince,
    };
  }

  function pump(roomId) {
    const running = db.prepare(
      "SELECT 1 FROM messages WHERE room_id = ? AND kind = 'claude_request' AND status = 'running'",
    ).get(roomId);
    if (running) return;
    for (;;) {
      const next = db.prepare(
        `SELECT * FROM messages WHERE room_id = ? AND kind = 'claude_request' AND status = 'queued'
         ORDER BY queued_at, id LIMIT 1`,
      ).get(roomId);
      if (!next) return;
      if (!isOnline(next.user_id)) {
        setStatus(next.id, 'held', 'OFFLINE');
        continue;
      }
      setStatus(next.id, 'running');
      beats.set(next.id, now());
      dispatch(next.user_id, runStart(next));
      return;
    }
  }

  function runningRequest(requestId) {
    const r = db.prepare(
      "SELECT * FROM messages WHERE id = ? AND kind = 'claude_request' AND status = 'running'",
    ).get(requestId);
    if (!r) throw new Error('NOT_RUNNING');
    return r;
  }

  function failAndPump(req, reason) {
    setStatus(req.id, 'failed', reason);
    pump(req.room_id);
  }

  return {
    postMessage(userId, roomId, text) {
      if (!isMember(db, userId, roomId)) throw new Error('FORBIDDEN');
      text = String(text ?? '');
      const { isClaude, body } = parseClaudeMention(text);
      let kind = 'chat';
      let status = null;
      let queuedAt = null;
      let saved = text;
      if (isClaude) {
        if (!body) throw new Error('EMPTY_REQUEST');
        kind = 'claude_request'; status = 'queued'; queuedAt = now(); saved = body;
      } else if (!text.trim()) {
        throw new Error('INVALID_INPUT');
      }
      const id = Number(db.prepare(
        `INSERT INTO messages (room_id, user_id, kind, body, status, queued_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(roomId, userId, kind, saved, status, queuedAt, now()).lastInsertRowid);
      announce(id, MSG.MESSAGE_NEW);
      pump(roomId);
      return getMessage(id);
    },

    /** 요청을 보낸 사람. 없으면 null */
    requesterOf(requestId) {
      const r = db.prepare("SELECT user_id FROM messages WHERE id = ? AND kind = 'claude_request'").get(requestId);
      return r ? r.user_id : null;
    },

    heartbeat(requestId) {
      const r = db.prepare("SELECT 1 FROM messages WHERE id = ? AND status = 'running'").get(requestId);
      if (r) beats.set(requestId, now());
    },

    tick() {
      const rows = db.prepare(
        "SELECT * FROM messages WHERE kind = 'claude_request' AND status = 'running'",
      ).all();
      for (const r of rows) {
        const beat = beats.get(r.id);
        if (beat === undefined) beats.set(r.id, now());
        else if (now() - beat > HEARTBEAT_TIMEOUT_MS) failAndPump(r, 'TIMEOUT');
      }
    },

    appendEvent(requestId, event) {
      const req = runningRequest(requestId);
      const id = Number(db.prepare(
        `INSERT INTO messages (room_id, user_id, kind, body, request_id, created_at)
         VALUES (?, ?, 'claude_event', ?, ?, ?)`,
      ).run(req.room_id, req.user_id, JSON.stringify(event), requestId, now()).lastInsertRowid);
      beats.set(requestId, now());
      announce(id, MSG.MESSAGE_NEW);
    },

    finish(requestId, { transcriptVersion, sessionId, apply } = {}) {
      const req = runningRequest(requestId);
      const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(req.room_id);
      if (transcriptVersion !== room.transcript_version) {
        failAndPump(req, 'VERSION_MISMATCH');
        throw new Error('VERSION_MISMATCH');
      }
      const newVersion = room.transcript_version + 1;
      db.exec('BEGIN');
      try {
        apply?.();
        db.prepare('UPDATE rooms SET transcript_version = ? WHERE id = ?').run(newVersion, room.id);
        if (sessionId) db.prepare('UPDATE rooms SET claude_session_id = ?, fork_pending = 0 WHERE id = ?').run(sessionId, room.id);
        db.prepare("UPDATE messages SET status = 'done', error = NULL WHERE id = ?").run(requestId);
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        failAndPump(req, 'APPLY_FAILED');
        throw e;
      }
      beats.delete(requestId);
      announce(requestId, MSG.MESSAGE_UPDATE);
      pump(room.id);
      return { newVersion };
    },

    fail(requestId, reason) {
      const req = db.prepare(
        "SELECT * FROM messages WHERE id = ? AND kind = 'claude_request' AND status = 'running'",
      ).get(requestId);
      if (req) failAndPump(req, reason);
    },

    retry(userId, requestId) {
      const req = db.prepare("SELECT * FROM messages WHERE id = ? AND kind = 'claude_request'").get(requestId);
      if (!req) throw new Error('NOT_FOUND');
      if (req.user_id !== userId || !isMember(db, userId, req.room_id)) throw new Error('FORBIDDEN');
      if (!['held', 'failed', 'cancelled'].includes(req.status)) throw new Error('NOT_RETRYABLE');
      db.prepare("UPDATE messages SET status = 'queued', error = NULL, queued_at = ? WHERE id = ?")
        .run(now(), requestId);
      announce(requestId, MSG.MESSAGE_UPDATE);
      pump(req.room_id);
    },

    /** 요청을 보낸 사람이나 방장이 대기·실행 중 요청을 중단한다 */
    cancel(userId, requestId) {
      const req = db.prepare("SELECT * FROM messages WHERE id = ? AND kind = 'claude_request'").get(requestId);
      if (!req) throw new Error('NOT_FOUND');
      const { owner_id: ownerId } = db.prepare('SELECT owner_id FROM rooms WHERE id = ?').get(req.room_id);
      if (!isMember(db, userId, req.room_id) || (req.user_id !== userId && ownerId !== userId)) throw new Error('FORBIDDEN');
      if (!['queued', 'held', 'running'].includes(req.status)) throw new Error('NOT_CANCELLABLE');
      const wasRunning = req.status === 'running';
      setStatus(requestId, 'cancelled'); // 실행 중이던 요청의 늦은 finish·event 는 NOT_RUNNING 으로 거부된다
      if (wasRunning) dispatchCancel(req.user_id, requestId);
      pump(req.room_id);
    },

    onLeave(userId, roomId) {
      const rows = db.prepare(
        "SELECT id FROM messages WHERE room_id = ? AND user_id = ? AND kind = 'claude_request' AND status = 'queued'",
      ).all(roomId, userId);
      for (const r of rows) setStatus(r.id, 'held', 'LEFT');
    },

    recoverOnStart() {
      db.prepare(
        `UPDATE messages SET status = 'failed', error = 'SERVER_RESTART'
         WHERE kind = 'claude_request' AND status = 'running'`,
      ).run();
      beats.clear();
    },

    listMessages(userId, roomId, { limit = 500 } = {}) {
      if (!isMember(db, userId, roomId)) throw new Error('FORBIDDEN');
      return db.prepare(`${SELECT_MSG} WHERE m.room_id = ? ORDER BY m.id DESC LIMIT ?`)
        .all(roomId, limit).map(toMessage).reverse();
    },
  };
}
