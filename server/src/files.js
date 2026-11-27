import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { safeJoin } from '@rooms/shared/paths.js';
import { listFiles } from '@rooms/shared/manifest.js';

const tmpName = () => `.tmp-${randomBytes(6).toString('hex')}`;

// 임시 파일에 쓰고 rename 으로 교체
function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), tmpName());
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

/**
 * 대화 원본·공유 파일 저장소. 전부 동기
 * @param {string} dataDir
 */
export function createFileStore(dataDir) {
  const roomDir = (roomId) => {
    if (!/^\d+$/.test(String(roomId))) throw new Error('BAD_PATH');
    return path.join(dataDir, 'rooms', String(roomId));
  };
  const transcriptFile = (roomId) => path.join(roomDir(roomId), 'transcript.jsonl');
  const sharedDir = (roomId) => path.join(roomDir(roomId), 'shared');

  return {
    readTranscript(roomId) {
      try {
        return fs.readFileSync(transcriptFile(roomId), 'utf8');
      } catch (e) {
        if (e.code === 'ENOENT') return null;
        throw e;
      }
    },

    writeTranscript(roomId, text) {
      writeAtomic(transcriptFile(roomId), text);
    },

    manifest(roomId) {
      return listFiles(sharedDir(roomId));
    },

    readShared(roomId, rel) {
      const file = safeJoin(sharedDir(roomId), rel);
      try {
        return fs.readFileSync(file);
      } catch (e) {
        if (e.code === 'ENOENT' || e.code === 'EISDIR') throw new Error('NOT_FOUND');
        throw e;
      }
    },

    applyShared(roomId, changes) {
      const dir = sharedDir(roomId);
      const files = changes.map((c) => safeJoin(dir, c.path)); // 전부 검사한 뒤에 쓴다
      changes.forEach((c, i) => {
        if (c.contentBase64 === null) fs.rmSync(files[i], { force: true });
        else writeAtomic(files[i], Buffer.from(c.contentBase64, 'base64'));
      });
    },

    /**
     * 사람이 직접 고친 파일 올리기. baseSha 는 고치기 전 내용의 sha(새 파일이면 null).
     * 서버 내용이 이미 같으면 그대로 두고, baseSha 와 다르면(누가 먼저 고침) 충돌로 돌려준다
     * @param {{path: string, baseSha: string|null, contentBase64: string|null}[]} changes
     * @returns {{applied: string[], conflicts: string[]}}
     */
    putShared(roomId, changes) {
      const dir = sharedDir(roomId);
      const files = changes.map((c) => safeJoin(dir, c.path));
      const shaOf = (buf) => createHash('sha256').update(buf).digest('hex');
      const applied = [];
      const conflicts = [];
      changes.forEach((c, i) => {
        let cur = null;
        try { cur = shaOf(fs.readFileSync(files[i])); } catch (e) { if (e.code !== 'ENOENT' && e.code !== 'EISDIR') throw e; }
        const data = c.contentBase64 === null ? null : Buffer.from(c.contentBase64, 'base64');
        if (cur === (data && shaOf(data))) return;
        if (cur !== c.baseSha) return void conflicts.push(c.path);
        if (data) writeAtomic(files[i], data); else fs.rmSync(files[i], { force: true });
        applied.push(c.path);
      });
      return { applied, conflicts };
    },

    /** 대화 원본과 공유 파일을 다른 방 폴더로 복사한다(없으면 건너뜀) */
    copyRoom(fromId, toId) {
      if (!fs.existsSync(roomDir(fromId))) return;
      fs.cpSync(roomDir(fromId), roomDir(toId), { recursive: true, force: true, errorOnExist: false });
    },

    removeRoom(roomId) {
      fs.rmSync(roomDir(roomId), { recursive: true, force: true });
    },
  };
}
