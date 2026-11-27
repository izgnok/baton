import { signup, login, userByToken } from './auth.js';
import { isMember, ownRunningRequest, listCodeParts } from './rooms.js';

const MAX_BODY = 1024 * 1024;

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'content-type': type });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
const fail = (res, status, error) => send(res, status, { error });

function readJson(req, res) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        fail(res, 413, 'PAYLOAD_TOO_LARGE');
        req.destroy();
        resolve(undefined);
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (v && typeof v === 'object') return resolve(v);
      } catch { /* 아래에서 처리 */ }
      fail(res, 400, 'INVALID_INPUT');
      resolve(undefined);
    });
    req.on('error', () => resolve(undefined));
  });
}

/**
 * @param {{db: import('node:sqlite').DatabaseSync, files: ReturnType<typeof import('./files.js').createFileStore>, commit?: string|null}} deps
 */
export function createHttpHandler({ db, files, commit = null }) {
  async function auth(req, res, isSignup) {
    const body = await readJson(req, res);
    if (!body) return;
    try {
      send(res, 200, isSignup ? signup(db, body) : login(db, body));
    } catch (e) {
      fail(res, e.message === 'BAD_CREDENTIALS' ? 401 : 400, e.message);
    }
  }

  function roomFile(req, res, url, m) {
    const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
    const user = token && userByToken(db, token);
    if (!user) return fail(res, 401, 'UNAUTHENTICATED');
    const roomId = Number(m[1]);
    if (!db.prepare('SELECT 1 FROM rooms WHERE id = ?').get(roomId)) return fail(res, 404, 'NOT_FOUND');
    if (!isMember(db, user.id, roomId)) return fail(res, 403, 'FORBIDDEN');
    try {
      if (m[3] !== undefined) { // 코드 조각: 목록(JSON) 또는 한 조각(바이트 스트림)
        const repoId = Number(m[3]);
        if (!db.prepare('SELECT 1 FROM room_repos WHERE id = ? AND room_id = ?').get(repoId, roomId)) return fail(res, 404, 'NOT_FOUND');
        if (m[4] === undefined) return send(res, 200, { parts: listCodeParts(db, repoId) });
        const part = db.prepare('SELECT 1 FROM code_parts WHERE repo_id = ? AND seq = ?').get(repoId, Number(m[4])) && files.openPart(roomId, repoId, m[4]);
        if (!part) return fail(res, 404, 'NOT_FOUND');
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': part.size });
        part.stream.on('error', () => res.destroy());
        return void part.stream.pipe(res);
      }
      if (m[2] === 'transcript') {
        const t = files.readTranscript(roomId);
        return t === null ? (res.writeHead(204), res.end()) : send(res, 200, t, 'text/plain; charset=utf-8');
      }
      if (m[2] === 'shared-manifest') return send(res, 200, files.manifest(roomId));
      return send(res, 200, files.readShared(roomId, url.searchParams.get('path')), 'application/octet-stream');
    } catch (e) {
      return fail(res, e.message === 'BAD_PATH' ? 400 : e.message === 'NOT_FOUND' ? 404 : 500,
        e.message === 'BAD_PATH' || e.message === 'NOT_FOUND' ? e.message : 'INTERNAL');
    }
  }

  // 코드 묶음 업로드: 본문은 메모리에 모으지 않고 스트림으로 저장한다(readJson 의 크기 제한과 무관)
  async function codeUpload(req, res, url, m) {
    const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
    const user = token && userByToken(db, token);
    if (!user) return fail(res, 401, 'UNAUTHENTICATED');
    let own;
    try { own = ownRunningRequest(db, user.id, url.searchParams.get('requestId')); } catch { return fail(res, 403, 'FORBIDDEN'); }
    if (own.roomId !== Number(m[1])) return fail(res, 403, 'FORBIDDEN');
    if (Number(req.headers['content-length']) > files.maxBundle) return fail(res, 413, 'BUNDLE_TOO_BIG'); // 읽기 전에 거른다
    try {
      files.purgeOldUploads(own.roomId);
      send(res, 200, await files.receiveBundle(own.roomId, req));
    } catch (e) {
      if (!res.writable) return; // 업로드 중 끊김: 임시 파일은 receiveBundle 이 지웠다
      if (e.message === 'BUNDLE_TOO_BIG') {
        res.setHeader('connection', 'close');
        return fail(res, 413, 'BUNDLE_TOO_BIG');
      }
      if (e.message === 'INVALID_INPUT') return fail(res, 400, 'INVALID_INPUT');
      if (req.destroyed) return; // 끊김
      console.error(e);
      fail(res, 500, 'INTERNAL');
    }
  }

  return (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'POST' && (url.pathname === '/signup' || url.pathname === '/login')) {
      return void auth(req, res, url.pathname === '/signup');
    }
    if (req.method === 'GET' && url.pathname === '/version') return send(res, 200, { commit });
    const up = /^\/rooms\/(\d+)\/code-upload$/.exec(url.pathname);
    if (req.method === 'PUT' && up) return void codeUpload(req, res, url, up);
    const m = /^\/rooms\/(\d+)\/(?:(transcript|shared-manifest|shared)|code\/(\d+)(?:\/(\d+))?)$/.exec(url.pathname);
    if (req.method === 'GET' && m) return roomFile(req, res, url, m);
    return fail(res, 404, 'NOT_FOUND');
  };
}
