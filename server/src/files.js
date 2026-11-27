import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { once } from 'node:events';
import { safeJoin } from '@baton/shared/paths.js';
import { listFiles } from '@baton/shared/manifest.js';

/** 코드 묶음 상한(2GB). createFileStore 의 maxBundle 로 바꿀 수 있다 */
export const MAX_BUNDLE = 2 * 1024 ** 3;
const BUNDLE_HEAD = /^# v[23] git bundle/;
const UPLOAD_ID = /^[0-9a-f]{16,64}$/;
const UPLOAD_PREFIX = '.upload-';
const UPLOAD_MAX_AGE = 60 * 60 * 1000;

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

// 폴더의 .upload-* 임시 파일 중 minAge(ms) 이상 묵은 것을 지운다
function purgeUploads(dir, minAge) {
  let names;
  try { names = fs.readdirSync(dir); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
  for (const n of names) {
    if (!n.startsWith(UPLOAD_PREFIX)) continue;
    const f = path.join(dir, n);
    try { if (Date.now() - fs.statSync(f).mtimeMs >= minAge) fs.rmSync(f, { force: true }); } catch { /* 그 사이 지워짐 */ }
  }
}

/**
 * 대화 원본·공유 파일·코드 묶음 저장소. 묶음 업로드(receiveBundle)만 비동기
 * @param {string} dataDir
 * @param {{maxBundle?: number}} [opts]
 */
export function createFileStore(dataDir, { maxBundle = MAX_BUNDLE } = {}) {
  const roomDir = (roomId) => {
    if (!/^\d+$/.test(String(roomId))) throw new Error('BAD_PATH');
    return path.join(dataDir, 'rooms', String(roomId));
  };
  const transcriptFile = (roomId) => path.join(roomDir(roomId), 'transcript.jsonl');
  const sharedDir = (roomId) => path.join(roomDir(roomId), 'shared');
  const codeDir = (roomId) => path.join(roomDir(roomId), 'code');
  const uploadFile = (roomId, uploadId) => {
    if (!UPLOAD_ID.test(String(uploadId))) throw new Error('BAD_PATH');
    return path.join(codeDir(roomId), `${UPLOAD_PREFIX}${uploadId}`);
  };
  const partFile = (roomId, repoId, seq) => {
    if (!/^\d+$/.test(String(repoId)) || !/^\d+$/.test(String(seq))) throw new Error('BAD_PATH');
    return path.join(codeDir(roomId), `${repoId}-${seq}.bundle`);
  };
  const partNames = (roomId, repoId) => {
    if (!/^\d+$/.test(String(repoId))) throw new Error('BAD_PATH');
    const re = new RegExp(`^${repoId}-\\d+\\.bundle$`);
    try { return fs.readdirSync(codeDir(roomId)).filter((n) => re.test(n)); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  };

  return {
    maxBundle,

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

    /** 조각 하나를 스트림으로 연다(받기 HTTP 용). 없으면 null */
    openPart(roomId, repoId, seq) {
      const file = partFile(roomId, repoId, seq);
      let size;
      try { size = fs.statSync(file).size; } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
      return { size, stream: fs.createReadStream(file) };
    },

    /** 레포의 조각 파일(<repoId>-<seq>.bundle)을 모두 지운다 */
    removeParts(roomId, repoId) {
      for (const n of partNames(roomId, repoId)) fs.rmSync(path.join(codeDir(roomId), n), { force: true });
    },

    /** 레포의 조각 파일을 다른 방·다른 레포 id 로 복사한다(없으면 건너뜀) */
    copyParts(fromRoom, fromRepo, toRoom, toRepo) {
      for (const n of partNames(fromRoom, fromRepo)) {
        const seq = n.slice(`${fromRepo}-`.length, -'.bundle'.length);
        const to = partFile(toRoom, toRepo, seq);
        fs.mkdirSync(path.dirname(to), { recursive: true });
        const tmp = path.join(path.dirname(to), tmpName());
        try {
          fs.copyFileSync(path.join(codeDir(fromRoom), n), tmp);
          fs.renameSync(tmp, to);
        } catch (e) {
          fs.rmSync(tmp, { force: true });
          throw e;
        }
      }
    },

    /**
     * 업로드 본문(스트림)을 메모리에 모으지 않고 code/.upload-<id> 로 저장한다.
     * 상한을 넘으면 BUNDLE_TOO_BIG, 앞부분이 git bundle 이 아니면 INVALID_INPUT, 어느 경우든(끊김 포함) 임시 파일은 지운다
     * @returns {Promise<{uploadId: string, size: number}>}
     */
    async receiveBundle(roomId, stream) {
      const dir = codeDir(roomId);
      fs.mkdirSync(dir, { recursive: true });
      const uploadId = randomBytes(16).toString('hex');
      const file = uploadFile(roomId, uploadId);
      const out = fs.createWriteStream(file);
      let size = 0;
      let head = Buffer.alloc(0);
      try {
        // for await 로 돌리면 도중에 throw 할 때 요청 소켓이 끊겨 413 을 못 보내므로 직접 읽는다
        const it = stream[Symbol.asyncIterator]();
        for (let r = await it.next(); !r.done; r = await it.next()) {
          const chunk = r.value;
          size += chunk.length;
          if (size > maxBundle) throw new Error('BUNDLE_TOO_BIG');
          if (head.length < 32) head = Buffer.concat([head, chunk.subarray(0, 32 - head.length)]);
          if (!out.write(chunk)) await once(out, 'drain');
        }
        out.end();
        await once(out, 'close');
        if (!BUNDLE_HEAD.test(head.toString('latin1'))) throw new Error('INVALID_INPUT');
      } catch (e) {
        if (!out.closed) { out.destroy(); await once(out, 'close').catch(() => {}); }
        fs.rmSync(file, { force: true });
        throw e;
      }
      return { uploadId, size };
    },

    hasUpload(roomId, uploadId) {
      return UPLOAD_ID.test(String(uploadId)) && fs.existsSync(uploadFile(roomId, uploadId));
    },

    removeUpload(roomId, uploadId) {
      fs.rmSync(uploadFile(roomId, uploadId), { force: true });
    },

    /** 올라온 임시 파일을 레포의 seq 번째 조각으로 바꿔 놓고 크기를 돌려준다 */
    adoptUpload(roomId, repoId, seq, uploadId) {
      const from = uploadFile(roomId, uploadId);
      const size = fs.statSync(from).size;
      fs.renameSync(from, partFile(roomId, repoId, seq));
      return size;
    },

    /** 그 방의 1시간 넘은 임시 업로드 파일 삭제(업로드 때마다 부른다) */
    purgeOldUploads(roomId) {
      purgeUploads(codeDir(roomId), UPLOAD_MAX_AGE);
    },

    /** 서버 시작 때: 모든 방의 임시 업로드 파일 삭제 */
    purgeAllUploads() {
      let rooms = [];
      try { rooms = fs.readdirSync(path.join(dataDir, 'rooms')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      for (const r of rooms) purgeUploads(path.join(dataDir, 'rooms', r, 'code'), 0);
    },

    /** 대화 원본과 공유 파일을 다른 방 폴더로 복사한다(없으면 건너뜀). code/ 는 레포 id 가 바뀌므로 복사하지 않는다 */
    copyRoom(fromId, toId) {
      if (!fs.existsSync(roomDir(fromId))) return;
      fs.cpSync(roomDir(fromId), roomDir(toId), {
        recursive: true, force: true, errorOnExist: false, filter: (src) => src !== codeDir(fromId),
      });
    },

    removeRoom(roomId) {
      fs.rmSync(roomDir(roomId), { recursive: true, force: true });
    },
  };
}
