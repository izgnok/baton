// 웹소켓 메시지 타입
export const MSG = Object.freeze({
  AUTH: 'auth',
  ERROR: 'error',
  ROOM_LIST: 'room.list',
  ROOM_CREATE: 'room.create',
  ROOM_JOIN: 'room.join',
  ROOM_LEAVE: 'room.leave',
  ROOM_OPEN: 'room.open',
  ROOM_STATE: 'room.state',
  ROOM_RENAME: 'room.rename',
  ROOM_DELETE: 'room.delete',
  INVITE_REGENERATE: 'invite.regenerate',
  REPO_ADD: 'repo.add',
  REPO_UPDATE: 'repo.update',
  REPO_REMOVE: 'repo.remove',
  CHAT_SEND: 'chat.send',
  MESSAGE_NEW: 'message.new',
  MESSAGE_UPDATE: 'message.update',
  RUN_START: 'run.start',
  RUN_EVENT: 'run.event',
  RUN_HEARTBEAT: 'run.heartbeat',
  RUN_FINISH: 'run.finish',
  RUN_FAIL: 'run.fail',
  RUN_APPROVAL: 'run.approval',
  REQUEST_RETRY: 'request.retry',
});

const MENTION = /^\s*@claude(?=\s|$)/i;

/**
 * 맨 앞의 @claude 호출 여부와 그 뒤 본문
 * @param {string} text
 * @returns {{isClaude: boolean, body: string}}
 */
export function parseClaudeMention(text) {
  const m = MENTION.exec(text);
  if (!m) return { isClaude: false, body: text };
  return { isClaude: true, body: text.slice(m[0].length).trim() };
}
