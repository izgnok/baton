// 화면 전환과 서버 알림 전달. 상태는 필요한 만큼만 둔다
import { h } from './dom.js';
import { loginView } from './views/login.js';
import { roomListView } from './views/roomList.js';
import { roomView } from './views/room.js';
import { openApprovalSheet } from './views/approval.js';
import { closeTransientSheets } from './views/sheet.js';

const root = document.getElementById('app');
const banner = document.getElementById('banner');
const views = { login: loginView, rooms: roomListView, room: roomView };

let current = null;
let seq = 0;
const roomNames = new Map();

const ctx = {
  user: null,
  claude: null, // 마지막으로 읽은 claude auth status
  go,
  toast(text) {
    const el = h('div', { class: 'toast' }, text);
    document.getElementById('toast-root').append(el);
    setTimeout(() => el.remove(), 2500);
  },
  async refreshClaude() {
    ctx.claude = await window.rooms.claudeStatus().catch(() => ({ loggedIn: false }));
    return ctx.claude;
  },
  setRoomName: (id, name) => roomNames.set(Number(id), name),
  roomName: (id) => roomNames.get(Number(id)) ?? '',
};

async function go(view, opts = {}) {
  const mine = ++seq;
  if (!ctx.user && view !== 'login') ctx.user = (await window.rooms.getConfig()).user;
  current?.destroy?.();
  current = null;
  closeTransientSheets();
  root.replaceChildren();
  const inst = views[view](root, ctx, opts);
  current = inst;
  await inst.ready;
  if (mine !== seq) inst.destroy?.();
}

// 화면 전환만 하는 진입점(캡처 확인용). window.rooms 이상의 권한은 없다
window.__debug = { go };

// 서버 알림
window.rooms.onEvent((m) => current?.onEvent?.(m));

let wasDown = false;
window.rooms.onStatus(async (s) => {
  banner.hidden = s.connected || s.reason === 'UNAUTHENTICATED';
  if (s.reason === 'UNAUTHENTICATED') {
    await window.rooms.logout();
    ctx.user = null;
    return go('login', { notice: '다시 로그인해 주세요' });
  }
  if (!s.connected) wasDown = true;
  else if (wasDown) {
    wasDown = false;
    current?.onReconnect?.();
  }
});

// 승인 시트: 여러 개면 차례로
const approvals = [];
let active = null;

function nextApproval() {
  if (active || !approvals.length) return;
  const p = approvals.shift();
  const sheet = openApprovalSheet(
    p, ctx.roomName(p.roomId),
    (decision) => window.rooms.answerApproval({ id: p.id, decision }).catch(() => {}),
    () => { active = null; nextApproval(); },
  );
  active = { p, sheet };
  if (!ctx.roomName(p.roomId)) {
    window.rooms.listRooms().then(({ rooms }) => {
      rooms.forEach((r) => ctx.setRoomName(r.id, r.name));
      sheet.setSubtitle(ctx.roomName(p.roomId));
    }).catch(() => {});
  }
}

window.rooms.onApproval((p) => { approvals.push(p); nextApproval(); });
window.rooms.onApprovalClose(({ requestId }) => {
  for (let i = approvals.length - 1; i >= 0; i--) if (approvals[i].requestId === requestId) approvals.splice(i, 1);
  if (active?.p.requestId === requestId) active.sheet.close();
});

// 시작
const cfg = await window.rooms.getConfig();
ctx.user = cfg.user;
if (cfg.loggedIn) await go('rooms');
else await go('login', { serverUrl: cfg.serverUrl });
