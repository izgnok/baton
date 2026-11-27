import { h, button } from '../dom.js';
import { errorText, failText, STATUS_TEXT, formatTime, renderMarkdown, personIndex, initial, memberSummary, modelLabel, effortLabel, MODELS } from '../format.js';
import { openSheet, inputSheet, confirmSheet } from './sheet.js';
import { attachAutocomplete } from './autocomplete.js';
import { codeCard } from './codeChanges.js';
import { usageBars } from './usage.js';

const CLAUDE_START = /^\s*(@claude(?=\s|$)|\/)/i; // shared/protocol.js parseClaudeMention 과 같은 규칙
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const PLACEHOLDER = { claude: 'Claude 에게 · / 로 명령·스킬, @ 로 파일', human: '사람끼리만 · Claude 는 보지 않아요' };
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

const KEPT_TEXT = { DIRTY: '커밋 안 된 변경이 있어요', UNPUSHED: 'push 안 된 커밋이 있어요', NO_SOURCE: '원본 폴더 연결이 없어요', FAILED: '정리하지 못했어요' };

// 남겨 둔 방 작업 폴더가 있으면 안내를 붙인다
const keptNote = (text, res) => {
  const kept = res?.keptWorktrees ?? [];
  return kept.length ? `${text}. 방 작업 폴더 ${kept.map((k) => `${k.name}(${KEPT_TEXT[k.reason] ?? k.reason})`).join(', ')}는 남겨 뒀어요` : text;
};

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
  let memberStatus = {}; // userId → {repos, readDirs, claude}
  let myModel = { model: '', effort: '' }; // 이 PC 에 저장된 내 선택(빈 값 = 방 기본)
  let readDirs = [];
  let skillsP = null;
  let mode = loadMode();
  const openTools = new Set();
  const openDiffs = new Set();
  const approvals = new Map(); // requestId → {userName, toolName}

  const modeKey = `rooms.mode.${roomId}`;
  function loadMode() {
    try { return localStorage.getItem(`rooms.mode.${roomId}`) === 'human' ? 'human' : 'claude'; } catch { return 'claude'; }
  }
  const me = () => ctx.user?.id;
  const isOwner = () => !!state?.members.find((m) => m.userId === me())?.isOwner;
  const fail = (e) => ctx.toast(errorText(e.message));
  const leave = (text) => { leaving = true; ctx.toast(text); ctx.go('rooms'); };

  // ---------- 뼈대 ----------
  const nameEl = h('div', { class: 'room-name' });
  const countEl = h('span', { class: 'sub' });
  const usageBox = h('div', { class: 'usage-slot' });
  const messagesEl = h('div', { class: 'messages' });
  const noteEl = h('p', { class: 'composer-note', hidden: true });
  const input = h('textarea', { rows: '1', placeholder: PLACEHOLDER[mode] });
  const sendBtn = button('보내기', 'primary', send);
  const modeEl = h('div', { class: 'seg' });
  const modelBar = h('div', { class: 'composer-tools-model' });
  const tabsEl = h('div', { class: 'tabs' });
  const panelBody = h('div', { class: 'panel-body' });
  const panelFoot = h('div', { class: 'panel-foot' });
  const composer = h('div', { class: 'composer' },
    h('div', { class: 'composer-tools' }, modeEl, modelBar),
    h('div', { class: 'composer-row' }, input, sendBtn));

  // 자동완성이 Enter 를 먼저 받도록 보내기 키 처리보다 앞에 붙인다
  attachAutocomplete({
    input, host: composer,
    getMembers: () => (state?.members ?? []).filter((m) => m.userId !== me()).map((m) => m.name),
    getShared: sharedList,
    getSkills: () => (skillsP ??= window.rooms.listSkills({ roomId })),
    searchRepoFiles: (query) => window.rooms.listRepoFiles({ roomId, query }),
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
  });
  input.addEventListener('input', () => { noteClear(); autosize(); });

  root.append(h('div', { class: 'screen' },
    h('div', { class: 'room-head' },
      h('button', { type: 'button', class: 'btn-text', onclick: () => ctx.go('rooms') }, '← 목록'), nameEl, usageBox, countEl),
    h('div', { class: 'room-body' },
      h('section', { class: 'chat' }, messagesEl, noteEl, composer),
      h('aside', { class: 'panel' }, tabsEl, panelBody, panelFoot))));

  function renderUsage() { usageBox.replaceChildren(usageBars(ctx.usage, { compact: true })); }

  function setMode(next) {
    mode = next;
    try { localStorage.setItem(modeKey, mode); } catch { /* 저장 못 해도 이번 화면에서는 동작 */ }
    renderMode();
    input.focus();
  }
  function renderMode() {
    input.placeholder = PLACEHOLDER[mode];
    modeEl.replaceChildren(...[['claude', 'Claude'], ['human', '사람']].map(([k, label]) =>
      h('button', { type: 'button', class: mode === k ? 'on' : '', onclick: () => setMode(k) }, label)));
  }

  // 모델·노력 단계: 개인 선택 → 방 기본 → 내 Claude 설정
  function selectEl(options, labelOf, value, emptyLabel, onChange) {
    const list = value && !options.includes(value) ? [...options, value] : options; // 저장된 값이 목록에 없어도 보이게
    const el = h('select', { class: 'pick' },
      h('option', { value: '' }, emptyLabel), list.map((o) => h('option', { value: o }, labelOf(o) || o)));
    el.value = value;
    el.addEventListener('change', () => onChange(el.value));
    return el;
  }
  const modelSummary = (m, e) => [modelLabel(m), effortLabel(e)].filter(Boolean).join(' · ') || '내 Claude 설정';

  function saveMyModel(next) {
    myModel = next;
    window.rooms.setRoomModel({ roomId, ...myModel }).catch(fail);
    renderModelBar();
  }
  function renderModelBar() {
    if (!state) return;
    const dM = state.room.defaultModel ?? '';
    const dE = state.room.defaultEffort ?? '';
    const differs = (myModel.model && myModel.model !== dM) || (myModel.effort && myModel.effort !== dE);
    modelBar.replaceChildren(...[
      selectEl(MODELS, modelLabel, myModel.model, dM ? `모델 · 방 기본(${modelLabel(dM)})` : '모델 · 내 설정', (v) => saveMyModel({ ...myModel, model: v })),
      selectEl(EFFORTS, effortLabel, myModel.effort, dE ? `노력 · 방 기본(${effortLabel(dE)})` : '노력 · 내 설정', (v) => saveMyModel({ ...myModel, effort: v })),
      differs ? h('span', { class: 'model-note' },
        `방 기본: ${modelSummary(dM, dE)} · 나: ${modelSummary(myModel.model || dM, myModel.effort || dE)}`,
        small('방 기본으로', () => saveMyModel({ model: '', effort: '' }), 'is-accent')) : null,
    ].filter(Boolean));
  }

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

  // 사람 메시지는 모두 오른쪽. 내 것은 강조색, 남의 것은 사람별 고정 색
  function bubbleItem(m, text, { toClaude = false } = {}) {
    const mine = m.userId === me();
    const who = [mine ? null : h('span', {}, m.userName ?? '알 수 없음'), toClaude ? h('span', { class: 'to-claude' }, 'Claude 에게') : null].filter(Boolean);
    return h('div', { class: `msg ${mine ? 'mine' : `p${personIndex(m.userId)}`}` },
      who.length ? h('div', { class: 'who' }, who) : null,
      h('div', { class: 'msg-line' },
        h('div', { class: 'avatar', 'aria-hidden': 'true' }, initial(m.userName)),
        h('div', { class: 'bubble' }, text),
        h('span', { class: 'time' }, formatTime(m.createdAt))));
  }

  function requestItem(m) {
    const mine = m.userId === me();
    const el = bubbleItem(m, m.body, { toClaude: true });
    const meta = h('div', { class: 'req-meta' }, h('span', { class: `badge ${m.status}` }, STATUS_TEXT[m.status] ?? m.status));
    const retryable = m.status === 'failed' || m.status === 'held' || m.status === 'cancelled';
    if ((m.status === 'failed' || m.status === 'held') && m.error) meta.append(h('span', { class: 'reason' }, failText(m.error)));
    if (['queued', 'running', 'held'].includes(m.status) && (mine || isOwner())) {
      meta.append(small('중단', () => window.rooms.cancelRequest({ requestId: m.id }).catch(fail), 'is-danger'));
    }
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
    const cards = [];
    let model = null;
    for (const e of events ?? []) {
      let ev;
      try { ev = JSON.parse(e.body); } catch { continue; }
      if (ev.type === 'assistant') {
        model ??= ev.message?.model ?? null;
        const content = ev.message?.content;
        if (typeof content === 'string') parts.push(markdownEl(content));
        else (content ?? []).forEach((c, i) => {
          if (c.type === 'text') parts.push(markdownEl(c.text));
          else if (c.type === 'tool_use') parts.push(toolItem(`${e.id}:${i}`, c));
        });
      } else if (ev.type === 'rooms_code_changes') {
        for (const r of ev.results ?? []) cards.push(codeCard(r, openDiffs, `${e.id}:${r.repoId}`));
      } else if (ev.type === 'result' && ev.is_error) {
        parts.push(h('div', { class: 'reason' }, typeof ev.result === 'string' && ev.result ? ev.result : 'Claude 실행 중 오류가 났어요'));
      }
    }
    if (!parts.length && req.status === 'running') parts.push(h('div', { class: 'sub' }, '작업하는 중이에요…'));
    if (!parts.length && !cards.length) return null;
    return h('div', { class: 'claude-group' },
      parts.length ? h('div', { class: 'claude-block' }, h('div', { class: 'claude-label' }, model ? `Claude · ${modelLabel(model)}` : 'Claude'), parts) : null,
      cards);
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
    const typed = input.value.trim();
    if (sending || !typed) return;
    // [Claude] 상태의 일반 글은 @claude 를 붙여 보낸다. / 로 시작하는 글은 어느 상태든 Claude 에게 간다
    const text = mode === 'claude' && !CLAUDE_START.test(typed) ? `@claude ${typed}` : typed;
    if (CLAUDE_START.test(text) && !ctx.claude?.loggedIn) {
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
  const BLOCK_TEXT = { MISSING: '내 폴더를 연결해 주세요', REMOTE_MISMATCH: '고른 폴더의 원격 주소가 달라요' };

  const setCheck = (res) => { repoCheck = res.results; };

  async function refreshRepos() {
    repoLoading = true;
    renderPanel();
    try {
      const [res, dirs] = await Promise.all([window.rooms.checkRepos({ roomId }), window.rooms.listReadDirs({ roomId }).catch(() => readDirs)]);
      setCheck(res);
      readDirs = dirs;
    } catch (e) { repoCheck = null; if (!destroyed) fail(e); }
    repoLoading = false;
    if (!destroyed && curTab === 'repos') renderPanel();
  }

  async function repoAction(fn) {
    try { setCheck(await fn()); } catch (e) { fail(e); }
    if (!destroyed && curTab === 'repos') renderPanel();
  }


  async function addDir() {
    const p = await window.rooms.pickFolder().catch(() => null);
    if (!p) return;
    try { readDirs = await window.rooms.addReadDir({ roomId, path: p }); } catch (e) { fail(e); }
    if (!destroyed && curTab === 'repos') renderPanel();
  }

  async function removeDir(p) {
    try { readDirs = await window.rooms.removeReadDir({ roomId, path: p }); } catch (e) { fail(e); }
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
    { name: 'branch', label: '브랜치', value: r.baseBranch ?? 'main' },
  ];

  function repoCard(r) {
    const res = repoCheck?.find((x) => x.repoId === r.id);
    const lines = [];
    if (!res) lines.push(h('div', { class: 'sub' }, repoLoading ? '확인하는 중…' : '상태를 확인하지 못했어요'));
    else {
      lines.push(h('div', { class: 'path' }, `내 원본 · ${res.localPath ?? '내 PC 에서 찾지 못했어요. clone 하거나 폴더를 골라 주세요'}`));
      if (res.worktreeExists) lines.push(h('div', { class: 'path' }, `방 작업 폴더 · ${res.worktreePath}`));
      if (res.indexed) lines.push(h('div', { class: 'chip-ok' }, '자동 연결됨'));
      lines.push(res.block ? h('div', { class: 'status-bad' }, BLOCK_TEXT[res.block]) : h('div', { class: 'status-ok' }, '정상'));
      if (res.protected) lines.push(h('div', { class: 'status-warn' }, '보호 브랜치라 Claude 가 push 하지 않아요'));
    }
    const busy = cloning.has(r.id);
    const row = h('div', { class: 'row' }, small('폴더 고르기', () => pick(r)));
    if (res?.worktreeExists) row.append(small('폴더 열기', () => window.rooms.openFolder({ path: res.worktreePath }).catch(fail)));
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
          if (!await confirmSheet({ title: `${r.name} 레포를 삭제할까요?`, message: '방 설정에서 빠져요. 내 원본 폴더는 그대로고, 방 작업 폴더는 안 올린 변경이 없을 때만 지워요', confirmLabel: '삭제', danger: true })) return;
          window.rooms.removeRepo({ repoId: r.id }).then(
            (res) => ctx.toast(res?.keptWorktree ? `레포를 삭제했어요. 방 작업 폴더는 남겨 뒀어요 (${KEPT_TEXT[res.reason] ?? res.reason})` : '레포를 삭제했어요'),
            fail);
        }, 'is-danger'));
    }
    return h('div', { class: 'mini-card' },
      h('div', { class: 'name' }, r.name),
      h('div', { class: 'sub' }, `브랜치 ${r.baseBranch}`),
      h('div', { class: 'path' }, r.remoteUrl),
      lines, row);
  }

  function reposPanel() {
    if (!state.repos.length) panelBody.append(h('div', { class: 'sub' }, '등록된 레포가 없어요'));
    panelBody.append(...state.repos.map(repoCard));
    // 레포가 없는 방에서도 보인다
    panelBody.append(h('div', { class: 'mini-card' },
      h('div', { class: 'name' }, '내 맥에서 함께 읽을 폴더'),
      h('div', { class: 'sub' }, '내가 보낸 요청에서만 Claude 가 읽어요(읽기만). 다른 사람 요청은 그 사람 맥에 등록한 폴더를 읽어요'),
      readDirs.length ? readDirs.map((d) => h('div', { class: 'dir-row' }, h('div', { class: 'path' }, d), small('빼기', () => removeDir(d), 'is-danger')))
        : h('div', { class: 'sub' }, '아직 없어요'),
      h('div', { class: 'row' }, small('폴더 추가', addDir))));
    if (isOwner()) {
      // 폴더를 먼저 고르면 이름·주소·브랜치를 채우고, 추가 뒤 내 폴더로 바로 연결한다
      panelFoot.append(button('레포 추가', 'secondary', async () => {
        const dir = await window.rooms.pickFolder().catch(() => null);
        if (!dir) return;
        let info;
        try { info = await window.rooms.inspectRepo({ localPath: dir }); } catch {
          ctx.toast('git 레포 폴더가 아니에요');
          return;
        }
        inputSheet({
          title: '레포 추가', fields: repoFields(info), submitLabel: '추가',
          onSubmit: async (v) => {
            const repo = await window.rooms.addRepo({ roomId, ...v });
            await repoAction(() => window.rooms.linkRepo({ roomId, repoId: repo.id, localPath: info.localPath }));
            ctx.toast('레포를 추가하고 내 폴더를 연결했어요');
          },
        });
      }));
    }
  }

  // 공유 파일
  async function sharedList() {
    if (!shared) { try { shared = await window.rooms.listShared({ roomId }); } catch { return []; } }
    return shared;
  }

  async function loadShared() {
    renderPanel();
    try { shared = await window.rooms.listShared({ roomId }); } catch (e) { shared = null; if (!destroyed) fail(e); }
    if (!destroyed && curTab === 'shared') renderPanel();
  }

  function sharedPanel() {
    // 아래 목록이 곧 내 맥의 공유 폴더다
    panelBody.append(h('div', { class: 'shared-head' },
      h('div', { class: 'sub' }, '내 맥에도 같은 파일이 있어요. 고치고 저장하면 다른 사람에게도 반영돼요'),
      small('Finder 에서 열기', () => window.rooms.openShared({ roomId }).catch(fail))));
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
      const open = (reveal) => window.rooms.openShared({ roomId, path: p, reveal }).then(() => false, (e) => { fail(e); return false; });
      openSheet({
        title: p.split('/').pop(), subtitle: p, body, wide: true,
        actions: [
          { label: 'Finder 에서 보기', kind: 'secondary', onClick: () => open(true) },
          { label: isHtml ? '브라우저로 열기' : '기본 앱으로 열기', kind: 'secondary', onClick: () => open(false) },
          { label: '닫기', kind: 'primary' },
        ],
      });
    } catch (e) {
      fail(e);
    }
  }

  // 멤버
  function saveRoomDefaults(patch) {
    window.rooms.setRoomSettings({ roomId, ...patch }).then(() => ctx.toast('방 기본을 바꿨어요'), fail);
  }

  function roomSettingsCard() {
    const { defaultModel: dM = '', defaultEffort: dE = '' } = state.room;
    if (!isOwner()) return h('div', { class: 'mini-card' }, h('div', { class: 'name' }, '방 기본 모델·노력'), h('div', { class: 'sub' }, modelSummary(dM, dE)));
    const sel = (options, labelOf, value, onChange) => selectEl(options, labelOf, value, '각자 Claude 설정', onChange);
    return h('div', { class: 'mini-card room-settings' },
      h('div', { class: 'name' }, '방 기본 모델·노력'),
      h('div', { class: 'sub' }, '각자 입력창 옆에서 바꿔 쓸 수 있어요'),
      sel(MODELS, modelLabel, dM, (v) => saveRoomDefaults({ defaultModel: v })),
      sel(EFFORTS, effortLabel, dE, (v) => saveRoomDefaults({ defaultEffort: v })));
  }

  function membersPanel() {
    const code = state.room.inviteCode;
    panelBody.append(
      h('div', { class: 'mini-card' }, state.members.map((m) =>
        h('div', { class: 'member-block' },
          h('div', { class: 'member' }, h('span', {}, m.name), m.isOwner ? h('span', { class: 'owner-badge' }, '방장') : null),
          h('div', { class: 'member-sum' }, memberSummary(memberStatus[m.userId]))))),
      roomSettingsCard(),
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
          window.rooms.deleteRoom({ roomId }).then((res) => leave(keptNote('방을 삭제했어요', res)), (e) => { leaving = false; fail(e); });
        }));
    }
    panelFoot.append(button('방 나가기', 'secondary', async () => {
      const msg = isOwner() ? '방장이 나가면 먼저 들어온 멤버가 방장이 돼요' : '나간 뒤에도 초대 코드로 다시 들어올 수 있어요';
      if (!await confirmSheet({ title: '방에서 나갈까요?', message: msg, confirmLabel: '나가기', danger: true })) return;
      window.rooms.leaveRoom({ roomId }).then((res) => leave(keptNote('방에서 나왔어요', res)), fail);
    }));
  }

  // ---------- 상태 ----------
  function renderHeader() {
    nameEl.textContent = state.room.name;
    countEl.textContent = `멤버 ${state.members.length}명`;
    renderModelBar();
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
    memberStatus = data.memberStatus ?? {};
    myModel = { model: data.myModel?.model ?? '', effort: data.myModel?.effort ?? '' };
    stick = true;
    renderMessages();
    applyState(data.state);
  }

  const ready = (async () => {
    renderTabs();
    renderMode();
    renderUsage();
    try { await load(); } catch (e) { fail(e); ctx.go('rooms'); return; }
    if (curTab === 'shared') await loadShared();
    if (previewPath) await openPreview(previewPath);
    if (!ctx.claude) await ctx.refreshClaude();
  })();

  return {
    ready,
    onReconnect() { load().catch(() => {}); },
    onUsage: renderUsage,
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
      } else if (m.type === 'member.status' && m.roomId === roomId) {
        memberStatus = { ...memberStatus, [m.userId]: m.status };
        if (curTab === 'members') renderPanel();
      } else if (m.type === 'local.repos' && m.roomId === roomId) {
        if (curTab === 'repos') refreshRepos();
      } else if (m.type === 'shared.changed' && m.roomId === roomId) {
        if (curTab === 'shared') loadShared(); else shared = null;
      } else if (m.type === 'local.sharedConflict' && m.roomId === roomId) {
        ctx.toast(`다른 사람이 먼저 고친 파일이 있어서, 내 수정본을 따로 올렸어요: ${m.paths.join(', ')}`);
      } else if (m.type === 'run.approval' && m.roomId === roomId) {
        if (m.state === 'pending') approvals.set(m.requestId, { userName: m.userName, toolName: m.toolName });
        else approvals.delete(m.requestId);
        schedule();
      }
    },
    destroy() { destroyed = true; cancelAnimationFrame(raf); },
  };
}
