import { h, button } from '../dom.js';
import { errorText, failText, STATUS_TEXT, formatTime, renderMarkdown } from '../format.js';
import { openSheet, inputSheet, confirmSheet } from './sheet.js';

const MENTION = /^\s*@claude(?=\s|$)/i; // shared/protocol.js 와 같은 규칙
const PREVIEW_LIMIT = 200 * 1024;
const TABS = [['repos', '레포'], ['shared', '공유 파일'], ['members', '멤버']];

const small = (label, onclick, extra = '') => h('button', { type: 'button', class: `btn btn-small ${extra}`, onclick }, label);

// 도구 호출 한 줄 요약
function toolSummary(c) {
  const i = c.input ?? {};
  switch (c.name) {
    case 'Write': return `파일 쓰기 · ${i.file_path ?? ''}`;
    case 'Bash': return `명령 실행 · ${String(i.command ?? '').slice(0, 60)}`;
    case 'Read': return `파일 읽기 · ${i.file_path ?? ''}`;
    default: return String(c.name ?? '도구');
  }
}

const toJson = (v) => { try { return JSON.stringify(v, null, 2) ?? ''; } catch { return String(v); } };

function decodeBase64(b64, limit) {
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
  const cut = limit && bytes.length > limit;
  return { text: new TextDecoder('utf-8').decode(cut ? bytes.subarray(0, limit) : bytes), cut };
}

export function roomView(root, ctx, { roomId, tab = 'repos', preview: previewPath } = {}) {
  let state = null;
  let messages = [];
  let curTab = tab;
  let destroyed = false;
  let leaving = false;
  let sending = false;
  let stick = true; // 다음 그릴 때 맨 아래로
  let raf = 0;
  let repoCheck = null;
  let repoLoading = false;
  const cloning = new Set();
  let shared = null;
  const openTools = new Set();
  const approvals = new Map(); // requestId → {userName, toolName}

  const me = () => ctx.user?.id;
  const isOwner = () => !!state?.members.find((m) => m.userId === me())?.isOwner;
  const fail = (e) => ctx.toast(errorText(e.message));
  const leave = (text) => { leaving = true; ctx.toast(text); ctx.go('rooms'); };

  // ---------- 뼈대 ----------
  const nameEl = h('div', { class: 'room-name' });
  const countEl = h('span', { class: 'sub' });
  const messagesEl = h('div', { class: 'messages' });
  const noteEl = h('p', { class: 'composer-note', hidden: true });
  const input = h('textarea', { rows: '1', placeholder: '메시지 · @claude 로 시작하면 Claude 에게 요청해요' });
  const sendBtn = button('보내기', 'primary', send);
  const tabsEl = h('div', { class: 'tabs' });
  const panelBody = h('div', { class: 'panel-body' });
  const panelFoot = h('div', { class: 'panel-foot' });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
  });
  input.addEventListener('input', () => { noteClear(); autosize(); });

  root.append(h('div', { class: 'screen' },
    h('div', { class: 'room-head' },
      h('button', { type: 'button', class: 'btn-text', onclick: () => ctx.go('rooms') }, '← 목록'), nameEl, countEl),
    h('div', { class: 'room-body' },
      h('section', { class: 'chat' }, messagesEl, noteEl, h('div', { class: 'composer' }, input, sendBtn)),
      h('aside', { class: 'panel' }, tabsEl, panelBody, panelFoot))));

  function autosize() {
    input.style.height = '56px';
    input.style.height = `${Math.min(input.scrollHeight + 4, 160)}px`;
  }
  const noteClear = () => { noteEl.hidden = true; };

  // ---------- 채팅 ----------
  function schedule() {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; renderMessages(); });
  }

  function upsert(msg) {
    const i = messages.findIndex((m) => m.id === msg.id);
    if (i >= 0) messages[i] = msg;
    else { messages.push(msg); messages.sort((a, b) => a.id - b.id); }
  }

  function bubbleItem(m, text) {
    const mine = m.userId === me();
    return h('div', { class: `msg ${mine ? 'mine' : 'other'}` },
      mine ? null : h('div', { class: 'who' }, m.userName ?? '알 수 없음'),
      h('div', { class: 'msg-line' }, h('div', { class: 'bubble' }, text), h('span', { class: 'time' }, formatTime(m.createdAt))));
  }

  function requestItem(m) {
    const mine = m.userId === me();
    const el = bubbleItem(m, `@claude ${m.body}`);
    const meta = h('div', { class: 'req-meta' }, h('span', { class: `badge ${m.status}` }, STATUS_TEXT[m.status] ?? m.status));
    const retryable = m.status === 'failed' || m.status === 'held';
    if (retryable && m.error) meta.append(h('span', { class: 'reason' }, failText(m.error)));
    if (retryable && mine) meta.append(small('다시 보내기', () => window.rooms.retry({ requestId: m.id }).catch(fail), 'is-accent'));
    const ap = m.status === 'running' ? approvals.get(m.id) : null;
    if (ap) meta.append(h('span', { class: 'approval-wait' }, `${ap.userName} 님 승인 대기 중 · ${ap.toolName}`));
    el.append(meta);
    return el;
  }

  function toolItem(key, c) {
    const d = h('details', { class: 'tool', open: openTools.has(key) },
      h('summary', {}, toolSummary(c)), h('pre', {}, toJson(c.input)));
    d.addEventListener('toggle', () => (d.open ? openTools.add(key) : openTools.delete(key)));
    return d;
  }

  function markdownEl(text) {
    const d = h('div', { class: 'md' });
    d.innerHTML = renderMarkdown(text); // marked 결과만 innerHTML 로 넣는다(원문 HTML 은 이스케이프됨)
    return d;
  }

  function claudeBlock(req, events) {
    const parts = [];
    for (const e of events ?? []) {
      let ev;
      try { ev = JSON.parse(e.body); } catch { continue; }
      if (ev.type === 'assistant') {
        const content = ev.message?.content;
        if (typeof content === 'string') parts.push(markdownEl(content));
        else (content ?? []).forEach((c, i) => {
          if (c.type === 'text') parts.push(markdownEl(c.text));
          else if (c.type === 'tool_use') parts.push(toolItem(`${e.id}:${i}`, c));
        });
      } else if (ev.type === 'result' && ev.is_error) {
        parts.push(h('div', { class: 'reason' }, typeof ev.result === 'string' && ev.result ? ev.result : 'Claude 실행 중 오류가 났어요'));
      }
    }
    if (!parts.length && req.status === 'running') parts.push(h('div', { class: 'sub' }, '작업하는 중이에요…'));
    return parts.length ? h('div', { class: 'claude-block' }, h('div', { class: 'claude-label' }, 'Claude'), parts) : null;
  }

  function renderMessages() {
    const near = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 48;
    const events = new Map();
    for (const m of messages) {
      if (m.kind === 'claude_event') events.set(m.requestId, [...(events.get(m.requestId) ?? []), m]);
    }
    const items = [];
    for (const m of messages) {
      if (m.kind === 'chat') items.push(bubbleItem(m, m.body));
      else if (m.kind === 'claude_request') items.push(requestItem(m), claudeBlock(m, events.get(m.id)));
    }
    messagesEl.replaceChildren(...items.filter(Boolean));
    if (near || stick) messagesEl.scrollTop = messagesEl.scrollHeight;
    stick = false;
  }

  async function send() {
    const text = input.value.trim();
    if (sending || !text) return;
    if (MENTION.test(text) && !ctx.claude?.loggedIn) {
      noteEl.textContent = 'Claude 로그인이 필요해요. 방 목록에서 Claude 로그인을 한 뒤 다시 보내 주세요';
      noteEl.hidden = false;
      return;
    }
    sending = true;
    sendBtn.disabled = true;
    try {
      upsert(await window.rooms.sendMessage({ roomId, text }));
      input.value = '';
      autosize();
      stick = true;
      schedule();
    } catch (e) {
      fail(e);
    } finally {
      sending = false;
      sendBtn.disabled = false;
      input.focus();
    }
  }

  // ---------- 패널 ----------
  function renderTabs() {
    tabsEl.replaceChildren(...TABS.map(([key, label]) =>
      h('button', { type: 'button', class: `tab${curTab === key ? ' on' : ''}`, onclick: () => setTab(key) }, label)));
  }

  function setTab(key) {
    curTab = key;
    renderTabs();
    if (key === 'repos') refreshRepos();
    else if (key === 'shared') loadShared();
    else renderPanel();
  }

  function renderPanel() {
    panelBody.replaceChildren();
    panelFoot.replaceChildren();
    if (!state) return;
    if (curTab === 'repos') reposPanel();
    else if (curTab === 'shared') sharedPanel();
    else membersPanel();
  }

  // 레포
  const BLOCK_TEXT = { MISSING: '폴더 없음', REMOTE_MISMATCH: '주소가 달라요' };
  const WARN_TEXT = { DIRTY: '커밋 안 된 변경 있음', BEHIND: '원격보다 뒤처짐' };

  async function refreshRepos() {
    repoLoading = true;
    renderPanel();
    try { repoCheck = (await window.rooms.checkRepos({ roomId })).results; } catch (e) { repoCheck = null; if (!destroyed) fail(e); }
    repoLoading = false;
    if (!destroyed && curTab === 'repos') renderPanel();
  }

  async function repoAction(fn) {
    try { repoCheck = (await fn()).results; } catch (e) { fail(e); }
    if (!destroyed && curTab === 'repos') renderPanel();
  }

  async function pick(r) {
    const p = await window.rooms.pickFolder().catch(() => null);
    if (p) repoAction(() => window.rooms.linkRepo({ roomId, repoId: r.id, localPath: p }));
  }

  async function clone(r) {
    cloning.add(r.id);
    renderPanel();
    await repoAction(() => window.rooms.cloneRepo({ roomId, repoId: r.id }));
    cloning.delete(r.id);
    if (!destroyed && curTab === 'repos') renderPanel();
  }

  const repoFields = (r = {}) => [
    { name: 'name', label: '레포 이름', value: r.name, placeholder: 'payment-api' },
    { name: 'remoteUrl', label: '레포 주소', value: r.remoteUrl, placeholder: 'git@github.com:team/payment-api.git' },
    { name: 'branch', label: '브랜치', value: r.branch ?? 'main' },
  ];

  function repoCard(r) {
    const res = repoCheck?.find((x) => x.repoId === r.id);
    const lines = [];
    if (!res) lines.push(h('div', { class: 'sub' }, repoLoading ? '확인하는 중…' : '상태를 확인하지 못했어요'));
    else {
      lines.push(h('div', { class: 'path' }, `내 경로 · ${res.localPath ?? '연결 안 됨'}`));
      lines.push(res.block
        ? h('div', { class: 'status-bad' }, res.block === 'BRANCH_MISMATCH'
          ? `브랜치가 달라요 — 지금 ${res.currentBranch || '알 수 없음'}` : BLOCK_TEXT[res.block])
        : h('div', { class: 'status-ok' }, '정상'));
      for (const w of res.warn ?? []) lines.push(h('div', { class: 'status-warn' }, WARN_TEXT[w] ?? w));
    }
    const busy = cloning.has(r.id);
    const row = h('div', { class: 'row' }, small('폴더 고르기', () => pick(r)));
    // clone 은 아직 폴더가 연결되지 않았을 때만 보여 준다
    if (!res?.localPath) {
      const btn = small(busy ? '받는 중…' : 'clone', () => clone(r), '');
      btn.disabled = busy;
      row.append(btn);
    }
    if (isOwner()) {
      row.append(
        small('수정', () => inputSheet({
          title: '레포 수정', fields: repoFields(r), submitLabel: '저장',
          onSubmit: async (v) => { await window.rooms.updateRepo({ repoId: r.id, ...v }); ctx.toast('레포를 수정했어요'); },
        })),
        small('삭제', async () => {
          if (!await confirmSheet({ title: `${r.name} 레포를 삭제할까요?`, message: '방 설정에서만 빠지고, 내 컴퓨터의 폴더는 그대로예요', confirmLabel: '삭제', danger: true })) return;
          window.rooms.removeRepo({ repoId: r.id }).then(() => ctx.toast('레포를 삭제했어요'), fail);
        }, 'is-danger'));
    }
    return h('div', { class: 'mini-card' },
      h('div', { class: 'name' }, r.name),
      h('div', { class: 'sub' }, `브랜치 ${r.branch}`),
      h('div', { class: 'path' }, r.remoteUrl),
      lines, row);
  }

  function reposPanel() {
    if (!state.repos.length) panelBody.append(h('div', { class: 'sub' }, '등록된 레포가 없어요'));
    panelBody.append(...state.repos.map(repoCard));
    if (isOwner()) {
      panelFoot.append(button('레포 추가', 'secondary', () => inputSheet({
        title: '레포 추가', fields: repoFields(), submitLabel: '추가',
        onSubmit: async (v) => { await window.rooms.addRepo({ roomId, ...v }); ctx.toast('레포를 추가했어요'); },
      })));
    }
  }

  // 공유 파일
  async function loadShared() {
    renderPanel();
    try { shared = await window.rooms.listShared({ roomId }); } catch (e) { shared = null; if (!destroyed) fail(e); }
    if (!destroyed && curTab === 'shared') renderPanel();
  }

  function sharedPanel() {
    if (!shared) return void panelBody.append(h('div', { class: 'sub' }, '불러오는 중…'));
    if (!shared.length) return void panelBody.append(h('div', { class: 'sub' }, '아직 공유된 파일이 없어요'));
    let dir = null;
    for (const f of shared) {
      const i = f.path.lastIndexOf('/');
      const d = i < 0 ? '' : f.path.slice(0, i);
      if (d !== dir) { dir = d; if (d) panelBody.append(h('div', { class: 'file-dir' }, `${d}/`)); }
      panelBody.append(h('button', { type: 'button', class: 'file-item', onclick: () => openPreview(f.path) }, f.path.slice(i + 1)));
    }
  }

  async function openPreview(p) {
    let file;
    try {
      const { base64 } = await window.rooms.readShared({ roomId, path: p });
      const lower = p.toLowerCase();
      const isHtml = lower.endsWith('.html') || lower.endsWith('.htm');
      file = decodeBase64(base64, isHtml ? 0 : PREVIEW_LIMIT);
      const note = file.cut ? '\n\n… 앞 200KB 까지만 보여요' : '';
      let body;
      if (isHtml) body = h('iframe', { class: 'preview-frame', sandbox: '', srcdoc: file.text }); // 스크립트·same-origin 모두 금지
      else if (lower.endsWith('.md')) body = markdownEl(file.text + note);
      else body = h('pre', { class: 'preview-text' }, file.text + note);
      openSheet({ title: p.split('/').pop(), subtitle: p, body, wide: true, actions: [{ label: '닫기', kind: 'secondary' }] });
    } catch (e) {
      fail(e);
    }
  }

  // 멤버
  function membersPanel() {
    const code = state.room.inviteCode;
    panelBody.append(
      h('div', { class: 'mini-card' }, state.members.map((m) =>
        h('div', { class: 'member' }, h('span', {}, m.name), m.isOwner ? h('span', { class: 'owner-badge' }, '방장') : null))),
      h('div', { class: 'mini-card invite' },
        h('div', { class: 'sub' }, '초대 코드'),
        h('div', { class: 'code' }, code),
        small('복사', () => navigator.clipboard.writeText(code).then(() => ctx.toast('초대 코드를 복사했어요'), () => ctx.toast('복사하지 못했어요')), 'is-accent')));
    if (isOwner()) {
      panelBody.append(
        button('초대 코드 새로 받기', 'secondary', () => window.rooms.regenerateInvite({ roomId }).then(() => ctx.toast('초대 코드를 새로 만들었어요'), fail)),
        button('방 이름 바꾸기', 'secondary', () => inputSheet({
          title: '방 이름 바꾸기', fields: [{ name: 'name', label: '방 이름', value: state.room.name }], submitLabel: '저장',
          onSubmit: async ({ name }) => { await window.rooms.renameRoom({ roomId, name }); ctx.toast('방 이름을 바꿨어요'); },
        })),
        button('방 삭제', 'danger', async () => {
          if (!await confirmSheet({ title: '방을 삭제할까요?', message: '대화와 공유 파일이 모두 사라지고 되돌릴 수 없어요', confirmLabel: '삭제', danger: true })) return;
          leaving = true; // 내가 지운 방의 삭제 알림은 따로 안내하지 않는다
          window.rooms.deleteRoom({ roomId }).then(() => leave('방을 삭제했어요'), (e) => { leaving = false; fail(e); });
        }));
    }
    panelFoot.append(button('방 나가기', 'secondary', async () => {
      const msg = isOwner() ? '방장이 나가면 먼저 들어온 멤버가 방장이 돼요' : '나간 뒤에도 초대 코드로 다시 들어올 수 있어요';
      if (!await confirmSheet({ title: '방에서 나갈까요?', message: msg, confirmLabel: '나가기', danger: true })) return;
      window.rooms.leaveRoom({ roomId }).then(() => leave('방에서 나왔어요'), fail);
    }));
  }

  // ---------- 상태 ----------
  function renderHeader() {
    nameEl.textContent = state.room.name;
    countEl.textContent = `멤버 ${state.members.length}명`;
  }

  function applyState(s) {
    state = s;
    ctx.setRoomName(roomId, s.room.name);
    renderHeader();
    if (curTab === 'repos') refreshRepos();
    else renderPanel();
  }

  async function load() {
    const data = await window.rooms.openRoom({ roomId });
    if (destroyed) return;
    messages = data.messages;
    stick = true;
    renderMessages();
    applyState(data.state);
  }

  const ready = (async () => {
    renderTabs();
    try { await load(); } catch (e) { fail(e); ctx.go('rooms'); return; }
    if (curTab === 'shared') await loadShared();
    if (previewPath) await openPreview(previewPath);
    if (!ctx.claude) await ctx.refreshClaude();
  })();

  return {
    ready,
    onReconnect() { load().catch(() => {}); },
    onEvent(m) {
      if ((m.type === 'message.new' || m.type === 'message.update') && m.message.roomId === roomId) {
        const prev = messages.find((x) => x.id === m.message.id);
        upsert(m.message);
        if (m.message.kind === 'claude_request') {
          if (m.message.status !== 'running') approvals.delete(m.message.id);
          if (m.message.status === 'done' && prev?.status !== 'done') loadShared();
        }
        schedule();
      } else if (m.type === 'room.state' && m.state.room.id === roomId) {
        applyState(m.state);
      } else if (m.type === 'room.delete' && m.roomId === roomId) {
        if (!leaving) leave('방이 삭제됐어요');
      } else if (m.type === 'run.approval' && m.roomId === roomId) {
        if (m.state === 'pending') approvals.set(m.requestId, { userName: m.userName, toolName: m.toolName });
        else approvals.delete(m.requestId);
        schedule();
      }
    },
    destroy() { destroyed = true; cancelAnimationFrame(raf); },
  };
}
