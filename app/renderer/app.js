// 화면 전환과 서버 알림 전달. 상태는 필요한 만큼만 둔다
import { h } from './dom.js';
import { loginView } from './views/login.js';
import { roomListView } from './views/roomList.js';
import { roomView } from './views/room.js';
import { openApprovalSheet } from './views/approval.js';
import { closeTransientSheets, openSheet } from './views/sheet.js';
import { errorText } from './format.js';

const root = document.getElementById('app');
const banner = document.getElementById('banner');
const views = { login: loginView, rooms: roomListView, room: roomView };

let current = null;
let seq = 0;
const roomNames = new Map();

const ctx = {
  user: null,
  usage: null, // 마지막으로 받은 5시간·주간 사용량(이 PC 에만 있다)
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
window.rooms.onUsage((u) => { ctx.usage = u; current?.onUsage?.(u); });

// 업데이트 띠: 새 커밋이 있으면 [자세히] [업데이트], 서버 버전이 다르면 안내
const updateBar = document.getElementById('update-bar');
const serverBar = document.getElementById('server-bar');
function showUpdate(u) {
  serverBar.hidden = !u?.serverMismatch;
  updateBar.hidden = !(u?.count > 0);
  if (updateBar.hidden) return;
  const apply = h('button', { type: 'button', class: 'btn-tiny accent' }, '업데이트');
  apply.addEventListener('click', async () => {
    apply.disabled = true;
    apply.textContent = '업데이트 중…';
    try { await window.rooms.applyUpdate(); } catch (e) { ctx.toast(errorText(e.message)); apply.disabled = false; apply.textContent = '업데이트'; }
  });
  const more = h('button', { type: 'button', class: 'btn-tiny' }, '자세히');
  more.addEventListener('click', () => openSheet({
    title: '바뀐 내용', subtitle: `커밋 ${u.count}개`,
    body: h('ul', { class: 'update-list' }, u.subjects.map((t) => h('li', {}, t)), u.count > u.subjects.length ? h('li', { class: 'sub' }, `… 외 ${u.count - u.subjects.length}개`) : null),
    actions: [{ label: '닫기', kind: 'secondary' }],
  }));
  updateBar.replaceChildren(h('span', {}, `새 버전이 있어요 (커밋 ${u.count}개)`), more, apply);
}
window.rooms.onUpdate(showUpdate);

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
window.rooms.getUsage().then((u) => { ctx.usage = u; current?.onUsage?.(u); }).catch(() => {});
window.rooms.checkUpdate().then(showUpdate).catch(() => {});
const cfg = await window.rooms.getConfig();
ctx.user = cfg.user;
if (cfg.loggedIn) await go('rooms');
else await go('login', { serverUrl: cfg.serverUrl });
