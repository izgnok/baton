import WebSocket from 'ws';
import { MSG } from '@rooms/shared/protocol.js';

const trim = (url) => String(url).replace(/\/+$/, '');

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
  };

  connect();

  return {
    http,
    get connected() { return connected; },
    request(type, payload = {}) {
      if (!connected) return Promise.reject(new Error('DISCONNECTED'));
      return rawRequest(ws, type, payload);
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
