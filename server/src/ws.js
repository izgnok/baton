import { WebSocketServer } from 'ws';
import { MSG } from '@rooms/shared/protocol.js';
import { userByToken } from './auth.js';
import * as R from './rooms.js';
import { createQueue } from './queue.js';

const CODE = /^[A-Z][A-Z0-9_]*$/;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const bad = () => new Error('INVALID_INPUT');

// 이름 목록: 문자열만, 최대 20개·각 100자로 자른다
function names(v) {
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) throw bad();
  return v.slice(0, 20).map((x) => x.slice(0, 100));
}

/**
 * 웹소켓 연결과 메시지 라우팅. 대기열도 여기서 만든다
 * @param {import('node:http').Server} server
 * @param {{db: import('node:sqlite').DatabaseSync, files: ReturnType<typeof import('./files.js').createFileStore>}} deps
 */
export function attachWs(server, { db, files }) {
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 50 * 1024 * 1024 });
  const conns = new Map(); // userId → ws[] (인증 순서)
  const memberStatus = new Map(); // roomId → Map<userId, 연결 요약> (메모리에만 둔다)

  const sendWs = (ws, payload) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
  };
  const sendUser = (userId, payload) => (conns.get(userId) ?? []).forEach((ws) => sendWs(ws, payload));
  const memberIds = (roomId) => db.prepare('SELECT user_id FROM room_members WHERE room_id = ?')
    .all(roomId).map((r) => r.user_id);
  const broadcast = (roomId, payload) => memberIds(roomId).forEach((u) => sendUser(u, payload));

  const queue = createQueue(db, {
    isOnline: (u) => (conns.get(u)?.length ?? 0) > 0,
    dispatch: (u, runStart) => {
      const list = conns.get(u);
      if (list?.length) sendWs(list[list.length - 1], { type: MSG.RUN_START, runStart });
    },
    dispatchCancel: (u, requestId) => sendUser(u, { type: MSG.RUN_CANCEL, requestId }),
    broadcast,
  });

  function broadcastState(roomId) {
    const [first] = memberIds(roomId);
    if (first !== undefined) broadcast(roomId, { type: MSG.ROOM_STATE, state: R.getRoomState(db, first, roomId) });
  }

  // 요청을 보낸 사람 본인만 실행 결과를 올릴 수 있다. 요청의 방 id 를 돌려준다
  function ownRequest(userId, m) {
    const requestId = Number(m.requestId);
    if (queue.requesterOf(requestId) !== userId) throw new Error('FORBIDDEN');
    const { room_id: roomId } = db.prepare('SELECT room_id FROM messages WHERE id = ?').get(requestId);
    return { requestId, roomId };
  }

  const handlers = {
    [MSG.ROOM_LIST]: (u) => ({ rooms: R.listRooms(db, u) }),
    [MSG.ROOM_CREATE]: (u, m) => R.createRoom(db, u, { name: m.name }),
    [MSG.ROOM_JOIN]: (u, m) => {
      const room = R.joinRoom(db, u, { inviteCode: m.inviteCode });
      broadcastState(room.id);
      return room;
    },
    [MSG.ROOM_OPEN]: (u, m) => {
      const roomId = Number(m.roomId);
      return {
        state: R.getRoomState(db, u, roomId),
        messages: queue.listMessages(u, roomId),
        memberStatus: Object.fromEntries(memberStatus.get(roomId) ?? []),
      };
    },
    [MSG.ROOM_LEAVE]: (u, m) => {
      const roomId = Number(m.roomId);
      R.leaveRoom(db, u, roomId);
      memberStatus.get(roomId)?.delete(u);
      queue.onLeave(u, roomId);
      broadcastState(roomId);
    },
    [MSG.ROOM_RENAME]: (u, m) => {
      const room = R.renameRoom(db, u, Number(m.roomId), { name: m.name });
      broadcastState(room.id);
      return room;
    },
    [MSG.ROOM_SETTINGS]: (u, m) => {
      const room = R.setRoomSettings(db, u, Number(m.roomId), m);
      broadcastState(room.id);
      return room;
    },
    [MSG.INVITE_REGENERATE]: (u, m) => {
      const room = R.regenerateInvite(db, u, Number(m.roomId));
      broadcastState(room.id);
      return room;
    },
    [MSG.ROOM_DELETE]: (u, m) => {
      const roomId = Number(m.roomId);
      const members = memberIds(roomId);
      R.deleteRoom(db, u, roomId);
      memberStatus.delete(roomId);
      files.removeRoom(roomId);
      members.forEach((id) => sendUser(id, { type: MSG.ROOM_DELETE, roomId }));
    },
    [MSG.REPO_ADD]: (u, m) => {
      const roomId = Number(m.roomId);
      const repo = R.addRepo(db, u, roomId, m);
      broadcastState(roomId);
      return repo;
    },
    [MSG.REPO_UPDATE]: (u, m) => {
      const repo = R.updateRepo(db, u, Number(m.repoId), m);
      broadcastState(db.prepare('SELECT room_id FROM room_repos WHERE id = ?').get(repo.id).room_id);
      return repo;
    },
    [MSG.REPO_REMOVE]: (u, m) => {
      const repoId = Number(m.repoId);
      const row = db.prepare('SELECT room_id FROM room_repos WHERE id = ?').get(repoId);
      R.removeRepo(db, u, repoId);
      broadcastState(row.room_id);
    },
    [MSG.CHAT_SEND]: (u, m) => queue.postMessage(u, Number(m.roomId), m.text),
    [MSG.REQUEST_RETRY]: (u, m) => queue.retry(u, Number(m.requestId)),
    [MSG.REQUEST_CANCEL]: (u, m) => queue.cancel(u, Number(m.requestId)),
    [MSG.SHARED_PUT]: (u, m) => {
      const roomId = Number(m.roomId);
      if (!R.isMember(db, u, roomId)) throw new Error('FORBIDDEN');
      const ch = m.changes;
      if (!Array.isArray(ch) || !ch.length || !ch.every((c) => c && typeof c.path === 'string'
        && (c.baseSha === null || typeof c.baseSha === 'string')
        && (c.contentBase64 === null || typeof c.contentBase64 === 'string'))) throw bad();
      const r = files.putShared(roomId, ch);
      if (r.applied.length) broadcast(roomId, { type: MSG.SHARED_CHANGED, roomId, userId: u });
      return r;
    },
    [MSG.MEMBER_STATUS]: (u, m) => {
      const roomId = Number(m.roomId);
      if (!R.isMember(db, u, roomId)) throw new Error('FORBIDDEN');
      const s = m.status;
      if (!s || typeof s !== 'object' || typeof s.claude !== 'boolean') throw bad();
      const status = { repos: names(s.repos), readDirs: names(s.readDirs), claude: s.claude };
      if (!memberStatus.has(roomId)) memberStatus.set(roomId, new Map());
      memberStatus.get(roomId).set(u, status);
      broadcast(roomId, { type: MSG.MEMBER_STATUS, roomId, userId: u, status });
    },
    [MSG.RUN_EVENT]: (u, m) => {
      queue.appendEvent(ownRequest(u, m).requestId, m.event);
    },
    [MSG.RUN_HEARTBEAT]: (u, m) => {
      queue.heartbeat(ownRequest(u, m).requestId);
    },
    [MSG.RUN_FAIL]: (u, m) => {
      queue.fail(ownRequest(u, m).requestId, String(m.reason ?? 'FAILED'));
    },
    [MSG.RUN_APPROVAL]: (u, m) => {
      const { requestId, roomId } = ownRequest(u, m);
      const { name } = db.prepare('SELECT name FROM users WHERE id = ?').get(u);
      broadcast(roomId, {
        type: MSG.RUN_APPROVAL, roomId, requestId, state: m.state, toolName: m.toolName, userName: name,
      });
    },
    [MSG.RUN_FINISH]: (u, m) => {
      const { requestId, roomId } = ownRequest(u, m);
      const changes = m.sharedChanges;
      // 세션 ID 는 다른 멤버 맥의 파일 이름이 되므로 UUID 만 받는다
      if ((m.sessionId != null && !SESSION_ID.test(String(m.sessionId)))
        || typeof m.transcript !== 'string' || !Array.isArray(changes)
        || !changes.every((c) => c && typeof c.path === 'string'
          && (c.contentBase64 === null || typeof c.contentBase64 === 'string'))) throw bad();
      return queue.finish(requestId, {
        transcriptVersion: m.transcriptVersion,
        sessionId: m.sessionId,
        apply: () => {
          files.applyShared(roomId, changes);
          files.writeTranscript(roomId, m.transcript); // 대화 원본은 마지막에 쓴다
          if (changes.length) broadcast(roomId, { type: MSG.SHARED_CHANGED, roomId, userId: u });
        },
      });
    },
  };

  wss.on('connection', (ws) => {
    ws.userId = null;
    ws.on('message', (raw) => {
      let m;
      try {
        m = JSON.parse(raw.toString());
        if (!m || typeof m.type !== 'string') throw bad();
      } catch {
        return sendWs(ws, { type: 'reply', replyTo: null, ok: false, error: 'INVALID_INPUT' });
      }
      const reply = (ok, rest) => sendWs(ws, { type: 'reply', replyTo: m.id, ok, ...rest });
      if (ws.userId === null) {
        const user = m.type === MSG.AUTH && userByToken(db, m.token);
        if (!user) {
          reply(false, { error: 'UNAUTHENTICATED' });
          return ws.close();
        }
        ws.userId = user.id;
        conns.set(user.id, [...(conns.get(user.id) ?? []), ws]);
        return reply(true, { data: { user } });
      }
      try {
        const handler = handlers[m.type];
        if (!handler) throw bad();
        reply(true, { data: handler(ws.userId, m) ?? null });
      } catch (e) {
        let error = e.message;
        if (!CODE.test(error)) {
          console.error(e);
          error = 'INTERNAL';
        }
        reply(false, { error });
      }
    });
    ws.on('close', () => {
      if (ws.userId === null) return;
      const rest = (conns.get(ws.userId) ?? []).filter((c) => c !== ws);
      if (rest.length) conns.set(ws.userId, rest);
      else conns.delete(ws.userId);
    });
  });

  return {
    queue,
    close: () => { for (const ws of wss.clients) ws.terminate(); wss.close(); },
  };
}
