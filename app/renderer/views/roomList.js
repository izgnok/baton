import { h, button } from '../dom.js';
import { errorText, formatDate } from '../format.js';
import { inputSheet } from './sheet.js';
import { usageBars } from './usage.js';

export function roomListView(root, ctx) {
  let destroyed = false;
  let rooms = [];
  let loginBusy = false;

  const claudeBox = h('div');
  const list = h('div');

  function renderClaude() {
    const c = ctx.claude;
    claudeBox.replaceChildren();
    if (!c) return;
    if (c.loggedIn) {
      claudeBox.append(h('div', { class: 'claude-card' },
        h('div', { class: 'claude-main' },
          ['Claude', c.orgName, c.subscriptionType].filter(Boolean).join(' · '),
          c.email ? h('div', { class: 'sub' }, c.email) : null,
          usageBars(ctx.usage))));
      return;
    }
    claudeBox.append(h('div', { class: 'claude-card' },
      h('div', { class: 'claude-main' }, 'Claude 로그인이 필요해요',
        h('div', { class: 'sub' }, '사람끼리 채팅만 할 수 있어요')),
      button(loginBusy ? '로그인 중…' : 'Claude 로그인', 'small', claudeLogin, { disabled: loginBusy })));
  }

  async function claudeLogin() {
    loginBusy = true;
    renderClaude();
    try {
      await window.rooms.claudeLogin();
    } catch (e) {
      ctx.toast(errorText(e.message));
    }
    loginBusy = false;
    await ctx.refreshClaude();
    if (!destroyed) renderClaude();
  }

  function renderList() {
    list.replaceChildren();
    if (!rooms.length) {
      list.append(h('div', { class: 'empty' }, '아직 참여 중인 방이 없어요', h('br'), '방을 만들거나 초대 코드로 참가해 보세요'));
      return;
    }
    for (const r of rooms) {
      list.append(h('button', { type: 'button', class: 'room-card', onclick: () => ctx.go('room', { roomId: r.id }) },
        h('div', { class: 'name' }, r.name),
        h('div', { class: 'sub' }, `${formatDate(r.createdAt)} 에 만들었어요`)));
    }
  }

  async function load() {
    try {
      rooms = (await window.rooms.listRooms()).rooms;
      rooms.forEach((r) => ctx.setRoomName(r.id, r.name));
    } catch (e) {
      ctx.toast(errorText(e.message));
    }
    if (!destroyed) renderList();
  }

  const createRoom = () => inputSheet({
    title: '방 이름을 정해 주세요',
    fields: [{ name: 'name', label: '방 이름', placeholder: '예: 결제 개선' }],
    submitLabel: '방 만들기',
    onSubmit: async ({ name }) => {
      const room = await window.rooms.createRoom({ name });
      ctx.toast('방을 만들었어요');
      ctx.go('room', { roomId: room.id });
    },
  });

  const joinRoom = () => inputSheet({
    title: '초대 코드를 입력해 주세요',
    fields: [{ name: 'inviteCode', label: '초대 코드', placeholder: 'ABC123' }],
    submitLabel: '참가하기',
    errors: { NOT_FOUND: '초대 코드를 찾을 수 없어요' },
    onSubmit: async ({ inviteCode }) => {
      const room = await window.rooms.joinRoom({ inviteCode });
      ctx.toast('방에 참가했어요');
      ctx.go('room', { roomId: room.id });
    },
  });

  async function logout() {
    await window.rooms.logout();
    ctx.user = null;
    ctx.claude = null;
    ctx.go('login', { serverUrl: (await window.rooms.getConfig()).serverUrl });
  }

  root.append(h('div', { class: 'screen' },
    h('div', { class: 'topbar' }, h('button', { type: 'button', class: 'btn-text', onclick: logout }, '로그아웃')),
    h('div', { class: 'screen-scroll' },
      h('div', { class: 'col' },
        h('div', { class: 'rooms-head' }, h('h1', { class: 'title' }, '채팅방')),
        claudeBox, list)),
    h('div', { class: 'screen-foot' }, h('div', { class: 'col' },
      button('방 만들기', 'primary', createRoom),
      button('초대 코드로 참가', 'secondary', joinRoom)))));

  renderClaude();
  const ready = Promise.all([load(), ctx.refreshClaude().then(() => !destroyed && renderClaude())]);

  return {
    ready,
    onEvent(m) { if (m.type === 'room.state' || m.type === 'room.delete') load(); },
    onReconnect: load,
    onUsage: renderClaude,
    destroy() { destroyed = true; },
  };
}
