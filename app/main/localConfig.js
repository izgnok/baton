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
 * @returns {{serverUrl: string|null, token: string|null, rooms: Record<string, {repos: Record<string, string>}>}}
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
