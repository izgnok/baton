import fs from 'node:fs';
import path from 'node:path';
import { MSG } from '@baton/shared/protocol.js';
import { pullRoom, collectChanges } from './runner/sync.js';

const SNAP = 'shared-synced.json'; // 마지막으로 서버와 맞춘 내용(path → sha). 직접 고친 파일을 가려내는 기준

// 편집기·Finder 가 만드는 숨김·임시 파일은 올리지 않는다
const junk = (p) => !p || p.split(/[\\/]/).some((s) => s.startsWith('.') || s.endsWith('~'));

// a/b.md → a/b (내 수정 1127-0915).md
function conflictName(p, now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const tag = `내 수정 ${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  const { dir, name, ext } = path.posix.parse(p);
  return path.posix.join(dir, `${name} (${tag})${ext}`);
}

/**
 * 방 공유 폴더 동기화: 직접 고친 파일 올리기 → 서버 내용 받기 → 폴더 감시
 * @param {{getClient: () => any, roomDirOf: (roomId: number) => string, isRunning: (roomId: number) => boolean,
 *   onConflict?: (roomId: number, paths: string[]) => void, watch?: typeof fs.watch, debounceMs?: number}} deps
 */
export function createSharedSync({ getClient, roomDirOf, isRunning, onConflict = () => {}, watch = fs.watch, debounceMs = 1500 }) {
  const chains = new Map(); // roomId → 진행 중인 작업(방마다 하나씩 차례로)
  const busy = new Set();
  const watchers = new Map();
  const timers = new Map();

  const snapFile = (roomId) => path.join(roomDirOf(roomId), SNAP);
  function loadSnap(roomId) {
    try { return new Map(Object.entries(JSON.parse(fs.readFileSync(snapFile(roomId), 'utf8')))); } catch { return null; }
  }
  const saveSnap = (roomId, snap) => fs.writeFileSync(snapFile(roomId), JSON.stringify(Object.fromEntries(snap)));

  const serial = (roomId, fn) => {
    const next = (chains.get(roomId) ?? Promise.resolve()).catch(() => {}).then(fn);
    chains.set(roomId, next);
    return next;
  };

  /** 마지막 동기화 뒤 직접 고친 파일을 서버에 올린다. 누가 먼저 고쳤으면 내 수정본을 다른 이름으로 올린다 */
  async function pushLocal(roomId) {
    const client = getClient();
    const snap = loadSnap(roomId);
    if (!client || !snap) return; // 처음 받는 방은 올릴 기준이 없다
    const roomDir = roomDirOf(roomId);
    const changes = collectChanges({ roomDir, snapshot: snap }).filter((c) => !junk(c.path))
      .map((c) => ({ ...c, baseSha: snap.get(c.path) ?? null }));
    if (!changes.length) return;
    const { conflicts } = await client.request(MSG.SHARED_PUT, { roomId, changes });
    const kept = [];
    for (const p of conflicts) {
      const c = changes.find((x) => x.path === p);
      if (!c?.contentBase64) continue; // 내가 지운 파일을 남이 고쳤으면 그쪽을 살린다
      const copy = conflictName(p);
      const shared = path.join(roomDir, 'shared');
      fs.renameSync(path.join(shared, p), path.join(shared, copy));
      await client.request(MSG.SHARED_PUT, { roomId, changes: [{ path: copy, baseSha: null, contentBase64: c.contentBase64 }] });
      kept.push(copy);
    }
    if (kept.length) onConflict(roomId, kept);
  }

  function startWatch(roomId) {
    if (watchers.has(roomId)) return;
    try {
      const w = watch(path.join(roomDirOf(roomId), 'shared'), { recursive: true }, (_ev, name) => {
        if (busy.has(roomId) || isRunning(roomId) || junk(String(name ?? ''))) return;
        clearTimeout(timers.get(roomId));
        timers.set(roomId, setTimeout(() => { sync(roomId).catch((e) => console.error('공유 파일 동기화 실패', e)); }, debounceMs));
      });
      w.on('error', () => { watchers.delete(roomId); });
      watchers.set(roomId, w);
    } catch { /* 감시를 못 해도 방 열기·목록 때 맞춘다 */ }
  }

  /** 올리기 → 받기 → 감시. 이 PC 에서 그 방의 Claude 가 실행 중이면 건너뛴다(작업 중인 파일 보호) */
  function sync(roomId) {
    return serial(roomId, async () => {
      const client = getClient();
      if (!client || isRunning(roomId)) return;
      busy.add(roomId);
      try {
        await pushLocal(roomId);
        const roomDir = roomDirOf(roomId);
        const { snapshot } = await pullRoom({ http: client.http, roomId, roomDir });
        saveSnap(roomId, snapshot);
      } finally {
        busy.delete(roomId);
      }
      startWatch(roomId);
    });
  }

  return {
    sync,
    /** Claude 실행 직전: 실행이 공유 폴더를 서버 내용으로 덮기 전에 직접 고친 것을 올린다 */
    pushLocal: (roomId) => serial(roomId, () => pushLocal(roomId)),
    close() {
      for (const w of watchers.values()) w.close();
      for (const t of timers.values()) clearTimeout(t);
      watchers.clear();
    },
  };
}

export const _test = { junk, conflictName };
