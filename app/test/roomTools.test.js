import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { MSG } from '@rooms/shared/protocol.js';
import { createRoomTools, defaultLsRemote } from '../main/roomTools.js';

const g = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'pipe' }).toString().trim();

let tmp, bare, src, other;
before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rooms-rt-'));
  bare = path.join(tmp, 'insight.git');
  const seed = path.join(tmp, 'seed');
  fs.mkdirSync(seed);
  g(seed, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(seed, 'a.txt'), 'a\n');
  g(seed, 'add', '.');
  g(seed, 'commit', '-q', '-m', 'init');
  g(seed, 'branch', 'release/1.0');
  g(tmp, 'clone', '-q', '--bare', seed, bare);
  src = path.join(tmp, 'home/insight');
  fs.mkdirSync(path.dirname(src), { recursive: true });
  g(tmp, 'clone', '-q', bare, src);
  other = path.join(tmp, 'home/other');
  fs.mkdirSync(other);
  g(other, 'init', '-q');
  g(other, 'remote', 'add', 'origin', 'https://example.com/team/other.git');
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const repo = (o = {}) => ({
  id: 1, name: 'insight', remoteUrl: 'git@example.com:team/insight.git', baseBranch: 'release/1.0', workBranch: 'feature/X',
  originBranch: 'release/1.0', code: null, ...o,
});

/** 가짜 client·콜백이 붙은 도구 처리기와 호출 기록 */
function setup({ repos = [repo()], members = [{ userId: 7, name: '민수' }], index = [], sources = {}, ...over } = {}) {
  const calls = { request: [], source: [], sync: [], removed: [], opened: [], ls: [] };
  const state = { room: { id: 5 }, members, repos };
  const tools = createRoomTools({
    roomId: 5, requestId: 'req-1',
    client: { request: async (type, payload) => { calls.request.push([type, payload]); return over.reply?.(payload) ?? repo({ ...payload }); } },
    getState: () => state,
    repoIndex: index,
    getSource: (id) => sources[id],
    setSource: (id, p) => { calls.source.push([id, p]); sources[id] = p; },
    worktreeOf: () => over.wt ?? null,
    syncRepo: async (id) => { calls.sync.push(id); },
    removeCopy: over.removeCopy ?? (async (id) => { calls.removed.push(id); }),
    openPath: async (p) => { calls.opened.push(p); },
    lsRemote: over.lsRemote ?? (async (t, b) => { calls.ls.push([t, b]); return true; }),
  });
  return { tools, calls, state };
}

test('room_repos: 레포 한 줄씩, 코드 상태·원본 연결 표시', async () => {
  const { tools } = setup({
    repos: [repo(), repo({ id: 2, name: 'lib', workBranch: '', code: { parts: 3, updatedBy: 7 } })],
    sources: { 1: '/x/insight' },
  });
  const out = (await tools('room_repos', {})).split('\n');
  assert.equal(out[0], '#1 insight · 기준 release/1.0 → 작업 feature/X · git@example.com:team/insight.git · 코드: 기준 브랜치 그대로 · 이 맥 원본 연결됨');
  assert.equal(out[1], '#2 lib · 기준 release/1.0 · git@example.com:team/insight.git · 코드: 조각 3개(마지막 변경 민수) · 이 맥 원본 연결 안 됨');
  assert.equal(await setup({ repos: [] }).tools('room_repos', {}), '방에 레포가 없어요');
});

test('local_repos: 이름·원격으로 대소문자 무시 검색, 없으면 안내', async () => {
  const index = [{ path: '/a', name: 'Payment-API', remoteUrl: 'git@x:team/pay.git' }, { path: '/b', name: 'web', remoteUrl: '' }];
  const { tools } = setup({ index });
  assert.equal(await tools('local_repos', { query: 'payment' }), 'Payment-API · git@x:team/pay.git');
  assert.equal(await tools('local_repos', { query: 'TEAM/PAY' }), 'Payment-API · git@x:team/pay.git');
  assert.equal((await tools('local_repos', {})).split('\n').length, 2);
  assert.match(await tools('local_repos', { query: 'zzz' }), /못 찾았어요/);
  const many = Array.from({ length: 60 }, (_, i) => ({ path: `/p${i}`, name: `r${i}`, remoteUrl: 'u' }));
  assert.equal((await setup({ index: many }).tools('local_repos', {})).split('\n').length, 51);
});

test('room_set_repo: 새 레포 — requestId 포함, 원본 있으면 그 경로로 확인, 문구', async () => {
  const index = [{ path: '/home/insight', name: 'insight', remoteUrl: 'https://example.com/team/insight' }];
  const { tools, calls } = setup({ index });
  const out = await tools('room_set_repo', { remoteUrl: 'git@example.com:team/insight.git', baseBranch: 'release/1.0', workBranch: 'feature/X' });
  assert.deepEqual(calls.ls, [['/home/insight', 'release/1.0']]);
  assert.deepEqual(calls.request, [[MSG.ROOM_REPO_SET, {
    requestId: 'req-1', remoteUrl: 'git@example.com:team/insight.git', baseBranch: 'release/1.0', workBranch: 'feature/X',
  }]]);
  assert.equal(out, 'insight를 release/1.0에서 feature/X로 작업해요 (다음 요청부터 작업 폴더가 생겨요)');
});

test('room_set_repo: 새 레포, 원본 없으면 원격 주소로 확인하고 자동 받기 안내, 작업 브랜치 없음', async () => {
  const { tools, calls } = setup({ reply: (p) => repo({ ...p, name: '채용', workBranch: '' }) });
  const out = await tools('room_set_repo', { remoteUrl: 'git@example.com:team/hire.git', name: '채용', baseBranch: 'develop' });
  assert.deepEqual(calls.ls, [['git@example.com:team/hire.git', 'develop']]);
  assert.equal(out, '채용을 develop 기준으로 작업해요 (다음 요청부터 작업 폴더가 생겨요) 이 맥에는 아직 없어 자동으로 받아요');
  assert.equal(calls.request[0][1].workBranch, undefined);
});

test('room_set_repo: 기존 레포 변경 — 원본은 getSource, 기준 바뀌면 코드 상태 안내', async () => {
  const { tools, calls } = setup({ sources: { 1: '/home/insight' } });
  const out = await tools('room_set_repo', { repoId: 1, remoteUrl: repo().remoteUrl, baseBranch: 'develop', workBranch: 'feature/Y' });
  assert.deepEqual(calls.ls, [['/home/insight', 'develop']]);
  assert.equal(calls.request[0][1].repoId, 1);
  assert.equal(out, 'insight를 develop에서 feature/Y로 작업해요 (코드 상태를 새 기준에서 다시 시작해요)');
  // 기준은 그대로, 작업 브랜치만 바꾸면 안내 없음
  const same = await tools('room_set_repo', { repoId: 1, remoteUrl: repo().remoteUrl, baseBranch: 'release/1.0', workBranch: 'feature/Z' });
  assert.equal(same, 'insight를 release/1.0에서 feature/Z로 작업해요');
});

test('room_set_repo: 원격에 없는 기준 브랜치·잘못된 브랜치 이름·모르는 repoId 는 거부하고 서버에 안 보냄', async () => {
  const none = setup({ lsRemote: async () => false });
  await assert.rejects(none.tools('room_set_repo', { remoteUrl: 'u', baseBranch: 'nope' }), /기준 브랜치 nope 가 원격에 없어요/);
  assert.equal(none.calls.request.length, 0);

  const bad = setup();
  await assert.rejects(bad.tools('room_set_repo', { remoteUrl: 'u', baseBranch: '-x' }), /BAD_BRANCH/);
  await assert.rejects(bad.tools('room_set_repo', { remoteUrl: 'u', baseBranch: 'main', workBranch: 'a..b' }), /BAD_BRANCH/);
  await assert.rejects(bad.tools('room_set_repo', { repoId: 99, remoteUrl: 'u', baseBranch: 'main' }), /방에 #99 레포가 없어요/);
  assert.equal(bad.calls.request.length, 0);
  assert.equal(bad.calls.ls.length, 0);

  // 작업 브랜치는 원격에 없어도 된다(lsRemote 는 기준 브랜치만 확인)
  const ok = setup();
  await ok.tools('room_set_repo', { remoteUrl: 'u', baseBranch: 'main', workBranch: 'feature/new' });
  assert.deepEqual(ok.calls.ls.map((c) => c[1]), ['main']);
});

test('room_set_repo: 서버 오류 코드는 그대로 던짐', async () => {
  const t2 = createRoomTools({
    roomId: 5, requestId: 'r', client: { request: async () => { throw new Error('FORBIDDEN'); } }, getState: () => ({ repos: [], members: [] }),
    repoIndex: [], getSource: () => null, setSource() {}, worktreeOf() {}, syncRepo() {}, removeCopy() {}, lsRemote: async () => true,
  });
  await assert.rejects(t2('room_set_repo', { remoteUrl: 'u', baseBranch: 'main' }), /FORBIDDEN/);
});

test('room_remove_repo: 빼기 + 모르는 repoId', async () => {
  const { tools, calls } = setup({ repos: [repo({ name: '채용' })] });
  assert.equal(await tools('room_remove_repo', { repoId: 1 }), '채용을 방에서 뺐어요');
  assert.deepEqual(calls.request, [[MSG.ROOM_REPO_REMOVE, { requestId: 'req-1', repoId: 1 }]]);
  await assert.rejects(tools('room_remove_repo', { repoId: 9 }), /방에 #9 레포가 없어요/);
});

test('room_open_folder: 사본 있으면 열고, 없으면 거부', async () => {
  const dir = path.join(tmp, 'copy');
  fs.mkdirSync(dir, { recursive: true });
  const a = setup({ wt: dir });
  assert.equal(await a.tools('room_open_folder', { repoId: 1 }), `${dir}를 열었어요`);
  assert.deepEqual(a.calls.opened, [dir]);
  const b = setup({ wt: path.join(tmp, 'missing') });
  await assert.rejects(b.tools('room_open_folder', { repoId: 1 }), /아직 이 맥에 사본이 없어요/);
  assert.equal(b.calls.opened.length, 0);
});

test('room_relink: 원격 주소가 같으면 원본 저장 후 동기화(주소 표기가 달라도 같은 규칙), 다르면 거부', async () => {
  const r = repo({ remoteUrl: g(src, 'remote', 'get-url', 'origin') });
  const { tools, calls } = setup({ repos: [r] });
  const real = fs.realpathSync(src);
  assert.equal(await tools('room_relink', { repoId: 1, path: src }), `insight 원본을 ${real}로 다시 이었어요`);
  assert.deepEqual(calls.source, [[1, real]]);
  assert.deepEqual(calls.sync, [1]);

  // ~ 펼침
  const home = setup({ repos: [r] });
  const rel = path.relative(os.homedir(), src);
  if (!rel.startsWith('..')) {
    await home.tools('room_relink', { repoId: 1, path: `~/${rel}` });
    assert.equal(home.calls.source[0][1], real);
  }

  const wrong = setup({ repos: [r] });
  await assert.rejects(wrong.tools('room_relink', { repoId: 1, path: other }), /원격 주소가 .* 달라요/);
  await assert.rejects(wrong.tools('room_relink', { repoId: 1, path: tmp }), /git 레포가 아니에요/);
  assert.equal(wrong.calls.source.length + wrong.calls.sync.length, 0);
});

test('room_reclone: 사본 삭제 후 동기화, removeCopy 실패 사유 전달(동기화 안 함)', async () => {
  const ok = setup();
  assert.equal(await ok.tools('room_reclone', { repoId: 1 }), 'insight 사본을 지우고 다시 받았어요');
  assert.deepEqual([ok.calls.removed, ok.calls.sync], [[1], [1]]);

  const fail = setup({ removeCopy: async () => { throw new Error('안 올린 변경이 있어요'); } });
  await assert.rejects(fail.tools('room_reclone', { repoId: 1 }), /안 올린 변경이 있어요/);
  assert.deepEqual(fail.calls.sync, []);
  await assert.rejects(ok.tools('room_reclone', { repoId: 4 }), /방에 #4 레포가 없어요/);
});

test('모르는 도구 이름은 거부', async () => {
  await assert.rejects(setup().tools('nope', {}), /알 수 없는 방 도구/);
});

test('기본 lsRemote: 원본 폴더의 origin·bare 경로로 브랜치 존재 확인, 닿지 못하면 던짐', async () => {
  assert.equal(await defaultLsRemote(src, 'release/1.0'), true);
  assert.equal(await defaultLsRemote(src, 'release/9.9'), false);
  assert.equal(await defaultLsRemote(bare, 'main'), true);
  assert.equal(await defaultLsRemote(bare, 'rele'), false); // 부분 일치는 없음
  await assert.rejects(defaultLsRemote(path.join(tmp, 'nothing.git'), 'main'), /원격에 닿지 못했어요/);
  // 기본 구현으로 room_set_repo 가 끝까지 도는지(원본 = 임시 clone)
  const rem = g(src, 'remote', 'get-url', 'origin');
  const { tools } = setup({ index: [{ path: src, name: 'insight', remoteUrl: rem }], lsRemote: defaultLsRemote, reply: (p) => repo({ ...p, workBranch: '' }) });
  assert.match(await tools('room_set_repo', { remoteUrl: rem, baseBranch: 'release/1.0' }), /release\/1.0 기준으로 작업해요/);
  await assert.rejects(tools('room_set_repo', { remoteUrl: rem, baseBranch: 'release/9.9' }), /원격에 없어요/);
});
