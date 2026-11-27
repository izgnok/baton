import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

/** 앱 작업 폴더. env ROOMS_HOME 이 우선 */
export function roomsHome() {
  return process.env.ROOMS_HOME || path.join(os.homedir(), '.claude-rooms');
}

const configFile = () => path.join(roomsHome(), 'config.json');

const defaults = () => ({ serverUrl: null, token: null, rooms: {} });

/**
 * 로컬 설정 읽기. 없거나 깨졌으면 기본값
 * @returns {{serverUrl: string|null, token: string|null, rooms: Record<string, {repos: Record<string, string>, readDirs?: string[], model?: string, effort?: string}>,
 *   repoIndex?: {scannedAt: number, repos: {path: string, name: string, remoteUrl: string}[]},
 *   usage?: {fiveHour?: object, sevenDay?: object, updatedAt: number}}}
 */
export function loadConfig() {
  try {
    const v = JSON.parse(fs.readFileSync(configFile(), 'utf8'));
    if (!v || typeof v !== 'object' || Array.isArray(v)) return defaults();
    const rooms = v.rooms && typeof v.rooms === 'object' && !Array.isArray(v.rooms) ? v.rooms : {};
    return {
      serverUrl: typeof v.serverUrl === 'string' ? v.serverUrl : null,
      token: typeof v.token === 'string' ? v.token : null,
      rooms,
      ...(v.user && typeof v.user === 'object' ? { user: v.user } : {}), // 마지막 로그인 사용자(있을 때만)
      ...(v.repoIndex && Array.isArray(v.repoIndex.repos) ? { repoIndex: v.repoIndex } : {}), // 내 PC 레포 목록
      ...(v.usage && typeof v.usage === 'object' && !Array.isArray(v.usage) ? { usage: v.usage } : {}), // 5시간·주간 사용률
      ...(v.hostServer === true ? { hostServer: true } : {}), // 이 맥에서 서버 실행(Swift 앱)
    };
  } catch {
    return defaults();
  }
}

/** 설정 저장. 토큰이 들어 있어 0600 */
export function saveConfig(cfg) {
  const file = configFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${randomBytes(6).toString('hex')}`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

/** 레포 로컬 경로를 넣은 새 설정(원본은 바꾸지 않는다) */
export function setRepoPath(cfg, roomId, repoId, localPath) {
  const room = cfg.rooms[roomId] ?? { repos: {} };
  return {
    ...cfg,
    rooms: {
      ...cfg.rooms,
      [roomId]: { ...room, repos: { ...room.repos, [repoId]: localPath } },
    },
  };
}

/** 방의 함께 읽는 폴더에 추가한 새 설정(중복은 건너뛴다) */
export function addReadDirs(cfg, roomId, dirs) {
  const room = cfg.rooms[roomId] ?? { repos: {} };
  const readDirs = [...new Set([...(room.readDirs ?? []), ...dirs])];
  return { ...cfg, rooms: { ...cfg.rooms, [roomId]: { ...room, repos: room.repos ?? {}, readDirs } } };
}

/** 방의 함께 읽는 폴더에서 뺀 새 설정 */
export function removeReadDir(cfg, roomId, dir) {
  const room = cfg.rooms[roomId];
  if (!room) return cfg;
  return { ...cfg, rooms: { ...cfg.rooms, [roomId]: { ...room, readDirs: (room.readDirs ?? []).filter((d) => d !== dir) } } };
}

/** 방의 내 모델·노력 단계(개인 선택)를 넣은 새 설정. 빈 값은 "방 기본을 따름" */
export function setRoomModel(cfg, roomId, model, effort) {
  const room = cfg.rooms[roomId] ?? { repos: {} };
  return { ...cfg, rooms: { ...cfg.rooms, [roomId]: { ...room, repos: room.repos ?? {}, model: model || '', effort: effort || '' } } };
}

/** 실행 때 쓸 모델·노력: 개인 선택 → 방 기본 → 없음(내 Claude 설정). 각각 따로 정한다 */
export function effectiveModel(cfg, roomId, room) {
  const mine = cfg.rooms[roomId] ?? {};
  return { model: mine.model || room?.defaultModel || '', effort: mine.effort || room?.defaultEffort || '' };
}
