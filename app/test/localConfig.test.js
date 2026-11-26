import test, { beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { roomsHome, loadConfig, saveConfig, setRepoPath } from '../main/localConfig.js';

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
