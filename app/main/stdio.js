import { createInterface } from 'node:readline';

/**
 * 한 줄에 JSON 하나로 주고받는 코어 통신.
 * 요청 {"id","call","args"} → 응답 {"id","ok":true,"data"} / {"id","ok":false,"error"}, 알림 {"event","payload"}
 * @param {{input: import('node:stream').Readable, output: import('node:stream').Writable,
 *   handlers: Record<string, (args: any) => any>, onEnd?: () => void, log?: (msg: string) => void}} p
 */
export function createStdioServer({ input, output, handlers, onEnd = () => {}, log = (m) => process.stderr.write(`${m}\n`) }) {
  const table = { ...handlers };
  const send = (obj) => output.write(`${JSON.stringify(obj)}\n`);

  const rl = createInterface({ input, crlfDelay: Infinity });
  rl.on('line', async (line) => {
    if (!line.trim()) return;
    let m;
    try { m = JSON.parse(line); } catch { return log(`잘못된 줄: ${line.slice(0, 200)}`); }
    if (m?.id == null || typeof m.call !== 'string') return log(`id·call 없는 줄: ${line.slice(0, 200)}`);
    const fn = Object.hasOwn(table, m.call) ? table[m.call] : null;
    if (!fn) return send({ id: m.id, ok: false, error: 'UNKNOWN_CALL' });
    try {
      send({ id: m.id, ok: true, data: (await fn(m.args ?? {})) ?? null });
    } catch (e) {
      send({ id: m.id, ok: false, error: String(e?.message ?? e) });
    }
  });
  rl.on('close', onEnd);

  return {
    emit: (event, payload) => send({ event, payload: payload ?? null }),
    setHandler: (name, fn) => { table[name] = fn; },
  };
}
