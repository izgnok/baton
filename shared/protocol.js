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
  REQUEST_CANCEL: 'request.cancel',
  RUN_CANCEL: 'run.cancel',
  MEMBER_STATUS: 'member.status',
  ROOM_SETTINGS: 'room.settings',
});

const MENTION = /^\s*@claude(?=\s|$)/i;

/**
 * Claude 요청 여부와 본문. 맨 앞(앞 공백 허용)이 @claude 면 그 뒤 본문, / 로 시작하면 원문 그대로(명령·스킬)
 * @param {string} text
 * @returns {{isClaude: boolean, body: string}}
 */
export function parseClaudeMention(text) {
  const m = MENTION.exec(text);
  if (m) return { isClaude: true, body: text.slice(m[0].length).trim() };
  const t = text.trim();
  if (t.startsWith('/')) return { isClaude: true, body: t === '/' ? '' : t };
  return { isClaude: false, body: text };
}
