import test, { beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { roomsHome, loadConfig, saveConfig, setRepoPath, addReadDirs, removeReadDir, setRoomModel, effectiveModel, setCodeApplied } from '../main/localConfig.js';

let home;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'rooms-home-'));
  homes.push(home);
  process.env.ROOMS_HOME = home;
});

const homes = [];
after(() => homes.forEach((h) => fs.rmSync(h, { recursive: true, force: true })));

test('roomsHome 은 ROOMS_HOME 을 따른다', () => {
  assert.equal(roomsHome(), home);
});

test('파일이 없으면 기본값', () => {
  assert.deepEqual(loadConfig(), { serverUrl: null, token: null, rooms: {} });
});

test('저장 후 다시 읽으면 같고 권한은 600', () => {
  const cfg = setRepoPath({ serverUrl: 'http://x:1', token: 't', rooms: {} }, 3, 7, '/a/b');
  saveConfig(cfg);
  assert.deepEqual(loadConfig(), cfg);
  assert.equal(fs.statSync(path.join(home, 'config.json')).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(home), ['config.json']);
});

test('깨진 JSON 은 기본값', () => {
  fs.writeFileSync(path.join(home, 'config.json'), '{oops');
  assert.deepEqual(loadConfig(), { serverUrl: null, token: null, rooms: {} });
});

test('setRepoPath 는 원본을 바꾸지 않고 다른 값은 유지', () => {
  const a = setRepoPath({ serverUrl: null, token: null, rooms: {} }, 1, 1, '/p1');
  const b = setRepoPath(a, 1, 2, '/p2');
  assert.deepEqual(a.rooms[1].repos, { 1: '/p1' });
  assert.deepEqual(b.rooms[1].repos, { 1: '/p1', 2: '/p2' });
});

test('repoIndex 는 저장 후 다시 읽어도 남고, 모양이 틀리면 버린다', () => {
  const repoIndex = { scannedAt: 5, repos: [{ path: '/a', name: 'a', remoteUrl: '' }] };
  saveConfig({ serverUrl: null, token: null, rooms: {}, repoIndex });
  assert.deepEqual(loadConfig().repoIndex, repoIndex);
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ rooms: {}, repoIndex: { repos: 'x' } }));
  assert.equal('repoIndex' in loadConfig(), false);
});

test('addReadDirs·removeReadDir: 중복 제거, 레포 연결은 유지, 원본은 바뀌지 않는다', () => {
  const base = setRepoPath({ serverUrl: null, token: null, rooms: {} }, 1, 7, '/r');
  const a = addReadDirs(base, 1, ['/x', '/y']);
  const b = addReadDirs(a, 1, ['/y', '/z']);
  assert.deepEqual(b.rooms[1], { repos: { 7: '/r' }, readDirs: ['/x', '/y', '/z'] });
  assert.equal(base.rooms[1].readDirs, undefined);
  assert.deepEqual(removeReadDir(b, 1, '/y').rooms[1].readDirs, ['/x', '/z']);
  assert.deepEqual(addReadDirs({ rooms: {} }, 9, ['/q']).rooms[9], { repos: {}, readDirs: ['/q'] }); // 레포 없는 방
  assert.equal(removeReadDir(base, 5, '/q'), base);
  // 레포를 다시 연결해도 함께 읽는 폴더는 유지
  assert.deepEqual(setRepoPath(b, 1, 8, '/r2').rooms[1].readDirs, ['/x', '/y', '/z']);
});

test('setRoomModel·effectiveModel: 개인 → 방 기본 → 없음, 각각 따로, 다른 값은 유지', () => {
  const base = addReadDirs(setRepoPath({ serverUrl: null, token: null, rooms: {} }, 1, 7, '/r'), 1, ['/x']);
  const room = { defaultModel: 'opus', defaultEffort: 'high' };
  assert.deepEqual(effectiveModel(base, 1, room), { model: 'opus', effort: 'high' });
  assert.deepEqual(effectiveModel(base, 1, { defaultModel: '', defaultEffort: '' }), { model: '', effort: '' });
  const mine = setRoomModel(base, 1, 'sonnet', '');
  assert.deepEqual(mine.rooms[1], { repos: { 7: '/r' }, readDirs: ['/x'], model: 'sonnet', effort: '' });
  assert.deepEqual(effectiveModel(mine, 1, room), { model: 'sonnet', effort: 'high' }); // 노력만 방 기본
  assert.equal(base.rooms[1].model, undefined);
  assert.deepEqual(effectiveModel({ rooms: {} }, 9, undefined), { model: '', effort: '' });
  assert.deepEqual(setRoomModel({ rooms: {} }, 3, 'haiku', 'max').rooms[3], { repos: {}, model: 'haiku', effort: 'max' });
});

test('usage 는 저장 후 다시 읽어도 남고, 모양이 틀리면 버린다', () => {
  const usage = { fiveHour: { utilization: 0.2, resetsAt: 1, status: 'allowed' }, updatedAt: 5 };
  saveConfig({ serverUrl: null, token: null, rooms: {}, usage });
  assert.deepEqual(loadConfig().usage, usage);
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ rooms: {}, usage: [1] }));
  assert.equal('usage' in loadConfig(), false);
});

test('setCodeApplied: 레포별 마지막으로 맞춘 스냅샷을 넣고 null 이면 지운다, 다른 값은 유지, 원본은 그대로', () => {
  const base = addReadDirs(setRepoPath({ serverUrl: null, token: null, rooms: {} }, 1, 7, '/r'), 1, ['/x']);
  const a = setCodeApplied(base, 1, 7, 'abc');
  assert.deepEqual(a.rooms[1], { repos: { 7: '/r' }, readDirs: ['/x'], code: { 7: 'abc' } });
  assert.equal(base.rooms[1].code, undefined);
  const b = setCodeApplied(a, 1, 8, 'def');
  assert.deepEqual(b.rooms[1].code, { 7: 'abc', 8: 'def' });
  saveConfig(b);
  assert.deepEqual(loadConfig().rooms[1].code, { 7: 'abc', 8: 'def' });
  assert.deepEqual(setCodeApplied(b, 1, 8, null).rooms[1].code, { 7: 'abc' });
  assert.deepEqual(setCodeApplied(a, 1, 7, null).rooms[1], { repos: { 7: '/r' }, readDirs: ['/x'] });
  assert.deepEqual(setCodeApplied({ rooms: {} }, 4, 1, 'z').rooms[4], { repos: {}, code: { 1: 'z' } });
  // 옛 config 의 브랜치 대기 목록(지금은 없는 칸)은 읽어도 어디에도 쓰이지 않는다
  saveConfig({ serverUrl: null, token: null, rooms: { 1: { repos: {}, branchWaits: { 7: 'x' } } } });
  assert.deepEqual(setCodeApplied(loadConfig(), 1, 7, 'k').rooms[1].code, { 7: 'k' });
});
