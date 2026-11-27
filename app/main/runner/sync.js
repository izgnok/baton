import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { safeJoin } from '@baton/shared/paths.js';
import { listFiles } from '@baton/shared/manifest.js';
import { batonHome } from '../localConfig.js';

const claudeHome = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');

// 임시 파일에 쓰고 rename 으로 교체
function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.tmp-${randomBytes(6).toString('hex')}`);
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

/** claude 가 프로젝트 폴더 이름으로 쓰는 인코딩 */
export function encodeProjectDir(absPath) {
  return absPath.replace(/[^A-Za-z0-9]/g, '-');
}

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** cwd 에서 claude 가 찾는 대화 원본 위치. 세션 ID 는 다른 멤버가 올린 값이라 UUID 만 받는다 */
export function transcriptPath({ cwd, sessionId, claudeConfigDir = claudeHome() }) {
  if (!SESSION_ID.test(String(sessionId))) throw new Error('BAD_SESSION_ID');
  return path.join(claudeConfigDir, 'projects', encodeProjectDir(fs.realpathSync(cwd)), `${sessionId}.jsonl`);
}

/** 방 작업 폴더 경로(만들지 않는다) */
export function roomDirOf(roomId) {
  return path.join(batonHome(), String(roomId));
}

/**
 * 서버의 대화 원본과 공유 파일을 로컬에 맞춘다
 * @param {{http: {getTranscript: (roomId: number) => Promise<string|null>,
 *   getManifest: (roomId: number) => Promise<{path: string, sha256: string}[]>,
 *   getShared: (roomId: number, path: string) => Promise<Buffer>},
 *   roomId: number, roomDir: string, sessionId?: string|null}} p
 * @returns {Promise<{snapshot: Map<string, string>}>}
 */
export async function pullRoom({ http, roomId, roomDir, sessionId }) {
  const sharedDir = path.join(roomDir, 'shared');
  fs.mkdirSync(sharedDir, { recursive: true });

  // 경로를 전부 검사한 뒤에 쓴다(대화 원본 포함)
  const remote = await http.getManifest(roomId);
  const targets = remote.map((f) => ({ ...f, file: safeJoin(sharedDir, f.path) }));

  if (sessionId) {
    const file = transcriptPath({ cwd: roomDir, sessionId });
    const text = await http.getTranscript(roomId);
    if (text === null) throw new Error('TRANSCRIPT_MISSING');
    writeAtomic(file, text);
  }
  const local = new Map(listFiles(sharedDir).map((f) => [f.path, f.sha256]));
  for (const f of targets) {
    if (local.get(f.path) === f.sha256) continue;
    writeAtomic(f.file, await http.getShared(roomId, f.path));
  }
  const remotePaths = new Set(remote.map((f) => f.path));
  for (const p of local.keys()) {
    if (!remotePaths.has(p)) fs.rmSync(safeJoin(sharedDir, p), { force: true });
  }
  return { snapshot: new Map(remote.map((f) => [f.path, f.sha256])) };
}

/**
 * 실행 뒤 바뀐 공유 파일 목록. 삭제는 contentBase64 null
 * @param {{roomDir: string, snapshot: Map<string, string>}} p
 */
export function collectChanges({ roomDir, snapshot }) {
  const sharedDir = path.join(roomDir, 'shared');
  const now = listFiles(sharedDir);
  const changes = [];
  for (const f of now) {
    if (snapshot.get(f.path) === f.sha256) continue;
    changes.push({ path: f.path, contentBase64: fs.readFileSync(safeJoin(sharedDir, f.path)).toString('base64') });
  }
  const present = new Set(now.map((f) => f.path));
  for (const p of snapshot.keys()) if (!present.has(p)) changes.push({ path: p, contentBase64: null });
  return changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** 로컬 대화 원본 읽기 */
export function readTranscript({ cwd, sessionId, claudeConfigDir }) {
  try {
    return fs.readFileSync(transcriptPath({ cwd, sessionId, claudeConfigDir }), 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') throw new Error('TRANSCRIPT_NOT_FOUND');
    throw e;
  }
}
