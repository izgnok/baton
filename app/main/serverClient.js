import fs from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import WebSocket from 'ws';
import { MSG } from '@baton/shared/protocol.js';

// 끝의 / 를 떼고, 스킴이 없으면 http:// 를 붙인다(`10.0.0.5:4310` 처럼 입력해도 되게)
const trim = (url) => {
  const s = String(url).trim().replace(/\/+$/, '');
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `http://${s}`;
};

async function authPost(serverUrl, route, body) {
  let res;
  try {
    res = await fetch(`${trim(serverUrl)}${route}`, { method: 'POST', body: JSON.stringify(body) });
  } catch {
    throw new Error('SERVER_UNREACHABLE');
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? `HTTP_${res.status}`);
  return json;
}

/** 회원가입 → {token, user} */
export const signup = (serverUrl, { email, password, name }) => authPost(serverUrl, '/signup', { email, password, name });

/** 로그인 → {token, user} */
export const login = (serverUrl, { email, password }) => authPost(serverUrl, '/login', { email, password });

/** 서버가 시작할 때 정한 git commit(짧은 해시). 모르면 null */
export async function getServerCommit(serverUrl) {
  try {
    const res = await fetch(`${trim(serverUrl)}/version`);
    return (await res.json()).commit ?? null;
  } catch {
    return null;
  }
}

/**
 * 서버 웹소켓 클라이언트. 끊기면 자동 재연결하고, 인증 실패는 재연결하지 않는다
 * @param {{serverUrl: string, token: string, WebSocketImpl?: typeof WebSocket, backoffMs?: number[]}} opts
 */
export function createServerClient({ serverUrl, token, WebSocketImpl = WebSocket, backoffMs = [1000, 2000, 4000, 8000] }) {
  const base = trim(serverUrl);
  const wsUrl = `${base.replace(/^http/, 'ws')}/ws`;
  const waits = new Map(); // id → {res, rej}
  const listeners = new Map(); // type → Set<fn> ('*' 은 모든 알림)
  let ws = null;
  let connected = false;
  let closed = false;
  let authFailed = false;
  let attempt = 0;
  let nextId = 1;
  let timer = null;
  let lastStatus;

  const emit = (type, payload) => {
    for (const key of [type, ...(type === '*' ? [] : ['*'])]) {
      for (const fn of listeners.get(key) ?? []) {
        try { fn(payload); } catch { /* 구독자 오류는 무시 */ }
      }
    }
  };
  const setStatus = (status) => {
    const key = JSON.stringify(status);
    if (key === lastStatus) return;
    lastStatus = key;
    for (const fn of listeners.get('status') ?? []) {
      try { fn(status); } catch { /* 무시 */ }
    }
  };
  const rejectAll = (code) => {
    for (const w of waits.values()) w.rej(new Error(code));
    waits.clear();
  };

  function rawRequest(socket, type, payload) {
    return new Promise((res, rej) => {
      const id = nextId++;
      waits.set(id, { res, rej });
      socket.send(JSON.stringify({ type, id, ...payload }), (err) => {
        if (err) { waits.delete(id); rej(new Error('DISCONNECTED')); }
      });
    });
  }

  function connect() {
    if (closed) return;
    const socket = new WebSocketImpl(wsUrl);
    ws = socket;
    socket.on('error', () => {}); // 실패는 close 에서 처리한다
    socket.on('open', async () => {
      try {
        await rawRequest(socket, MSG.AUTH, { token });
        connected = true;
        attempt = 0;
        setStatus({ connected: true });
      } catch (e) {
        if (e.message === 'UNAUTHENTICATED') {
          authFailed = true;
          setStatus({ connected: false, reason: 'UNAUTHENTICATED' });
        }
        socket.close();
      }
    });
    socket.on('message', (raw) => {
      let m;
      try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.type === 'reply') {
        const w = waits.get(m.replyTo);
        if (!w) return;
        waits.delete(m.replyTo);
        if (m.ok) w.res(m.data); else w.rej(new Error(m.error));
        return;
      }
      emit(m.type, m);
    });
    socket.on('close', () => {
      if (socket !== ws) return;
      const was = connected;
      connected = false;
      rejectAll('DISCONNECTED');
      if (closed || authFailed) return;
      if (was || lastStatus === undefined) setStatus({ connected: false });
      timer = setTimeout(connect, backoffMs[Math.min(attempt, backoffMs.length - 1)]);
      attempt++;
    });
  }

  async function get(route) {
    let res;
    try {
      res = await fetch(`${base}${route}`, { headers: { authorization: `Bearer ${token}` } });
    } catch {
      throw new Error('SERVER_UNREACHABLE');
    }
    if (!res.ok && res.status !== 204) {
      const json = await res.json().catch(() => ({}));
      throw new Error(json.error ?? `HTTP_${res.status}`);
    }
    return res;
  }

  const http = {
    getTranscript: async (roomId) => {
      const r = await get(`/rooms/${roomId}/transcript`);
      return r.status === 204 ? null : r.text();
    },
    getManifest: async (roomId) => (await get(`/rooms/${roomId}/shared-manifest`)).json(),
    getShared: async (roomId, p) => Buffer.from(await (await get(`/rooms/${roomId}/shared?path=${encodeURIComponent(p)}`)).arrayBuffer()),
    /** 레포의 코드 조각 목록 → [{seq, prevSnapshot, snapshot, baseCommit, size}] (seq 순) */
    listCodeParts: async (roomId, repoId) => (await (await get(`/rooms/${roomId}/code/${repoId}`)).json()).parts,
    /** 조각 하나를 file 로 흘려 저장한다(메모리에 모으지 않음). 실패하면 반쯤 쓴 파일을 지우고 던진다 */
    downloadCodePart: async (roomId, repoId, seq, file) => {
      const res = await get(`/rooms/${roomId}/code/${repoId}/${seq}`);
      try {
        await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(file));
      } catch (e) {
        fs.rmSync(file, { force: true });
        throw e;
      }
    },
    /** 묶음 파일을 흘려 올린다 → {uploadId, size}. 서버 상한을 넘으면 BUNDLE_TOO_BIG */
    uploadBundle: async (roomId, requestId, file) => {
      const size = fs.statSync(file).size; // 파일이 없으면 스트림을 만들기 전에 던진다
      const body = fs.createReadStream(file);
      let res;
      try {
        res = await fetch(`${base}/rooms/${roomId}/code-upload?requestId=${encodeURIComponent(requestId)}`, {
          method: 'PUT',
          body,
          duplex: 'half',
          headers: { 'content-length': String(size), authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' },
        });
      } catch {
        throw new Error('SERVER_UNREACHABLE');
      } finally {
        body.destroy();
      }
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(res.status === 413 ? 'BUNDLE_TOO_BIG' : json.error ?? `HTTP_${res.status}`);
      return json;
    },
  };

  connect();

  return {
    http,
    get connected() { return connected; },
    request(type, payload = {}) {
      if (connected) return rawRequest(ws, type, payload);
      if (closed || authFailed) return Promise.reject(new Error('DISCONNECTED'));
      // 연결 중(로그인 직후·재연결 중)이면 5초까지 기다렸다가 보낸다
      return new Promise((resolve, reject) => {
        const set = listeners.get('status') ?? new Set();
        listeners.set('status', set);
        const onStatus = (s) => {
          if (!s.connected) return;
          clearTimeout(t);
          set.delete(onStatus);
          rawRequest(ws, type, payload).then(resolve, reject);
        };
        const t = setTimeout(() => { set.delete(onStatus); reject(new Error('DISCONNECTED')); }, 5000);
        set.add(onStatus);
      });
    },
    /** 서버 알림 구독. 'status' 는 {connected}, '*' 는 모든 알림. 해제 함수를 돌려준다 */
    on(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
      return () => listeners.get(type).delete(fn);
    },
    close() {
      closed = true;
      clearTimeout(timer);
      rejectAll('DISCONNECTED');
      ws?.terminate();
    },
  };
}
