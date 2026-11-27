import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createStdioServer } from '../main/stdio.js';

// 입력·출력 스트림과 출력 줄 모으기
function setup(handlers = {}, opts = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines = [];
  let buf = '';
  output.on('data', (d) => {
    buf += d.toString();
    const parts = buf.split('\n');
    buf = parts.pop();
    lines.push(...parts.map((l) => JSON.parse(l)));
  });
  const logs = [];
  const server = createStdioServer({ input, output, handlers, log: (m) => logs.push(m), ...opts });
  const until = async (n) => { for (let i = 0; i < 200 && lines.length < n; i++) await new Promise((r) => setTimeout(r, 5)); };
  return { input, output, lines, logs, server, until };
}

test('stdio: 요청에 같은 id 로 ok/data 응답', async () => {
  const t = setup({ echo: (a) => a, nothing: () => undefined });
  t.input.write('{"id":1,"call":"echo","args":{"a":"한글"}}\n{"id":2,"call":"nothing"}\n');
  await t.until(2);
  assert.deepEqual(t.lines, [{ id: 1, ok: true, data: { a: '한글' } }, { id: 2, ok: true, data: null }]);
});

test('stdio: 처리기 오류는 ok:false error 코드', async () => {
  const t = setup({ fail: async () => { throw new Error('NOT_FOUND'); } });
  t.input.write('{"id":1,"call":"fail","args":{}}\n{"id":2,"call":"nope"}\n');
  await t.until(2);
  // 응답 순서는 처리 끝난 순서다(id 로 짝을 맞춘다)
  assert.deepEqual(t.lines.sort((a, b) => a.id - b.id), [{ id: 1, ok: false, error: 'NOT_FOUND' }, { id: 2, ok: false, error: 'UNKNOWN_CALL' }]);
});

test('stdio: 잘못된 줄은 무시하고 다음 줄은 처리', async () => {
  const t = setup({ echo: (a) => a });
  t.input.write('not json\n{"call":"echo"}\n{"id":3,"call":"echo","args":1}\n');
  await t.until(1);
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(t.lines, [{ id: 3, ok: true, data: 1 }]);
  assert.equal(t.logs.length, 2);
});

test('stdio: 두 줄이 한 조각, 한 줄이 두 조각으로 와도 처리', async () => {
  const t = setup({ echo: (a) => a });
  const line = Buffer.from('{"id":2,"call":"echo","args":"가나"}\n');
  t.input.write('{"id":1,"call":"echo","args":"a"}\n');
  t.input.write(line.subarray(0, 30)); // 한글 중간에서 끊긴다
  t.input.write(line.subarray(30));
  await t.until(2);
  assert.deepEqual(t.lines.map((l) => l.data), ['a', '가나']);
});

test('stdio: emit 은 event/payload 한 줄, setHandler 로 처리기 추가', async () => {
  const t = setup();
  t.server.emit('usage', { fiveHour: 1 });
  t.server.emit('relaunch');
  t.server.setHandler('later', () => 'ok');
  t.input.write('{"id":1,"call":"later"}\n');
  await t.until(3);
  assert.deepEqual(t.lines, [{ event: 'usage', payload: { fiveHour: 1 } }, { event: 'relaunch', payload: null }, { id: 1, ok: true, data: 'ok' }]);
});

test('stdio: 입력이 끝나면 onEnd 호출', async () => {
  let ended = false;
  const t = setup({}, { onEnd: () => { ended = true; } });
  t.input.end();
  for (let i = 0; i < 100 && !ended; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(ended, true);
});
