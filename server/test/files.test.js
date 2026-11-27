import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { createFileStore } from '../src/files.js';

const dirs = [];
after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

function setup(opts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rooms-files-'));
  dirs.push(dir);
  return { dir, store: createFileStore(dir, opts) };
}
const b64 = (s) => Buffer.from(s).toString('base64');
const sha = (s) => createHash('sha256').update(s).digest('hex');

test('대화 원본 쓰기·읽기·덮어쓰기, 없으면 null, tmp 안 남음', () => {
  const { dir, store } = setup();
  assert.equal(store.readTranscript(1), null);
  store.writeTranscript(1, '{"a":1}\n');
  assert.equal(store.readTranscript(1), '{"a":1}\n');
  store.writeTranscript(1, '{"a":2}\n');
  assert.equal(store.readTranscript(1), '{"a":2}\n');
  assert.deepEqual(fs.readdirSync(path.join(dir, 'rooms', '1')), ['transcript.jsonl']);
});

test('applyShared → manifest 정렬·sha256, 삭제 반영', () => {
  const { store } = setup();
  assert.deepEqual(store.manifest(1), []);
  store.applyShared(1, [
    { path: 'outputs/메모.md', contentBase64: b64('한글 내용') },
    { path: 'memory/INDEX.md', contentBase64: b64('# 목차') },
  ]);
  assert.deepEqual(store.manifest(1), [
    { path: 'memory/INDEX.md', sha256: sha('# 목차') },
    { path: 'outputs/메모.md', sha256: sha('한글 내용') },
  ]);
  assert.equal(store.readShared(1, 'outputs/메모.md').toString(), '한글 내용');
  store.applyShared(1, [{ path: 'memory/INDEX.md', contentBase64: null }, { path: 'nope.md', contentBase64: null }]);
  assert.deepEqual(store.manifest(1).map((m) => m.path), ['outputs/메모.md']);
});

test('나쁜 경로가 하나라도 있으면 아무것도 쓰지 않는다', () => {
  const { store } = setup();
  assert.throws(
    () => store.applyShared(1, [{ path: 'ok.md', contentBase64: b64('x') }, { path: '../evil', contentBase64: b64('y') }]),
    { message: 'BAD_PATH' },
  );
  assert.deepEqual(store.manifest(1), []);
});

test('심볼릭 링크와 .tmp- 파일은 manifest 에 나오지 않는다', () => {
  const { dir, store } = setup();
  store.applyShared(1, [{ path: 'a.md', contentBase64: b64('a') }]);
  const shared = path.join(dir, 'rooms', '1', 'shared');
  fs.symlinkSync(path.join(shared, 'a.md'), path.join(shared, 'link.md'));
  fs.symlinkSync(os.tmpdir(), path.join(shared, 'linkdir'));
  fs.writeFileSync(path.join(shared, '.tmp-abc'), 'x');
  assert.deepEqual(store.manifest(1).map((m) => m.path), ['a.md']);
});

test('readShared 없는 파일은 NOT_FOUND, 나쁜 경로는 BAD_PATH, removeRoom', () => {
  const { dir, store } = setup();
  assert.throws(() => store.readShared(1, 'no.md'), { message: 'NOT_FOUND' });
  assert.throws(() => store.readShared(1, '../x'), { message: 'BAD_PATH' });
  store.writeTranscript(1, 'x');
  store.removeRoom(1);
  assert.equal(fs.existsSync(path.join(dir, 'rooms', '1')), false);
  store.removeRoom(1);
});

test('putShared: 기준이 같으면 반영, 누가 먼저 고쳤으면 충돌, 내용이 이미 같으면 그대로', () => {
  const { store } = setup();
  const sha = (s) => createHash('sha256').update(s).digest('hex');
  store.applyShared(1, [{ path: 'a.md', contentBase64: b64('v1') }, { path: 'b.md', contentBase64: b64('b') }]);
  const r = store.putShared(1, [
    { path: 'a.md', baseSha: sha('v1'), contentBase64: b64('v2') }, // 반영
    { path: 'b.md', baseSha: sha('old'), contentBase64: b64('mine') }, // 충돌
    { path: 'new.md', baseSha: null, contentBase64: b64('n') }, // 새 파일
    { path: 'same.md', baseSha: sha('zzz'), contentBase64: null }, // 이미 없음 → 그대로
  ]);
  assert.deepEqual(r, { applied: ['a.md', 'new.md'], conflicts: ['b.md'] });
  assert.equal(store.readShared(1, 'a.md').toString(), 'v2');
  assert.equal(store.readShared(1, 'b.md').toString(), 'b');
  assert.deepEqual(store.putShared(1, [{ path: 'a.md', baseSha: sha('v1'), contentBase64: b64('v2') }]), { applied: [], conflicts: [] });
  assert.deepEqual(store.putShared(1, [{ path: 'new.md', baseSha: sha('n'), contentBase64: null }]), { applied: ['new.md'], conflicts: [] });
  assert.throws(() => store.putShared(1, [{ path: '../x', baseSha: null, contentBase64: b64('x') }]), { message: 'BAD_PATH' });
});

const part = (dir, room, repo, seq) => path.join(dir, 'rooms', String(room), 'code', `${repo}-${seq}.bundle`);
const adopt = async (store, room, repo, seq, text) => {
  const { uploadId } = await store.receiveBundle(room, Readable.from([Buffer.from(`# v2 git bundle\n${text}`)]));
  return store.adoptUpload(room, repo, seq, uploadId);
};

test('조각: adoptUpload 로 seq 번째 조각이 되고 openPart 로 읽는다, removeParts 는 그 레포 것만, copyParts 는 id 를 바꿔 복사', async () => {
  const { dir, store } = setup();
  assert.equal(store.openPart(1, 5, 1), null);
  assert.equal(await adopt(store, 1, 5, 1, 'a'), 17);
  await adopt(store, 1, 5, 2, 'bb');
  await adopt(store, 1, 55, 1, 'other'); // 5 와 55 는 다른 레포
  const read = async (room, repo, seq) => {
    const p = store.openPart(room, repo, seq);
    const bufs = [];
    for await (const c of p.stream) bufs.push(c);
    return [p.size, Buffer.concat(bufs).toString().slice(16)];
  };
  assert.deepEqual(await read(1, 5, 2), [18, 'bb']);
  assert.equal(store.openPart(1, 5, 3), null);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'rooms', '1', 'code')).sort(), ['5-1.bundle', '5-2.bundle', '55-1.bundle']);

  store.copyParts(1, 5, 2, 9);
  store.copyParts(1, 6, 2, 10); // 없는 레포
  assert.deepEqual(fs.readdirSync(path.join(dir, 'rooms', '2', 'code')).sort(), ['9-1.bundle', '9-2.bundle']);
  assert.deepEqual(await read(2, 9, 1), [17, 'a']);

  store.removeParts(1, 5);
  store.removeParts(1, 5);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'rooms', '1', 'code')), ['55-1.bundle']);
  assert.equal(fs.existsSync(part(dir, 2, 9, 2)), true); // 복사본은 그대로
  assert.throws(() => store.openPart(1, '../x', 1), { message: 'BAD_PATH' });
  assert.throws(() => store.openPart(1, 5, 'a'), { message: 'BAD_PATH' });
  assert.throws(() => store.removeParts(1, 'a'), { message: 'BAD_PATH' });
});

test('copyRoom 은 code/ 를 복사하지 않는다', async () => {
  const { dir, store } = setup();
  store.writeTranscript(1, 't');
  store.applyShared(1, [{ path: 'a.md', contentBase64: b64('a') }]);
  await adopt(store, 1, 5, 1, 'x');
  store.copyRoom(1, 2);
  assert.equal(fs.existsSync(path.join(dir, 'rooms', '2', 'code')), false);
  assert.equal(store.readTranscript(2), 't');
  assert.equal(store.readShared(2, 'a.md').toString(), 'a');
  assert.equal(fs.existsSync(part(dir, 1, 5, 1)), true); // 원래 방은 그대로
});

const chunks = (...parts) => Readable.from(parts.map((p) => Buffer.from(p)));
const uploads = (dir, room = 1) => {
  try { return fs.readdirSync(path.join(dir, 'rooms', String(room), 'code')).filter((n) => n.startsWith('.upload-')); } catch { return []; }
};

test('receiveBundle: 여러 청크를 이어 저장하고, adoptUpload 로 조각이 되며 임시 파일은 사라진다', async () => {
  const { dir, store } = setup();
  const { uploadId, size } = await store.receiveBundle(1, chunks('# v2 git bu', 'ndle\nPA', 'CK'));
  assert.deepEqual([size, /^[0-9a-f]{32}$/.test(uploadId), store.hasUpload(1, uploadId), store.hasUpload(2, uploadId)], [20, true, true, false]);
  assert.equal(store.adoptUpload(1, 7, 1, uploadId), 20);
  assert.equal(fs.readFileSync(part(dir, 1, 7, 1)).toString(), '# v2 git bundle\nPACK');
  assert.deepEqual(uploads(dir), []);
  assert.equal(store.hasUpload(1, uploadId), false);
  assert.equal(store.hasUpload(1, '../x'), false);
  assert.throws(() => store.removeUpload(1, '../x'), { message: 'BAD_PATH' });
});

test('receiveBundle: 상한 초과 BUNDLE_TOO_BIG(딱 상한은 통과)·헤더 틀림 INVALID_INPUT·끊김 모두 임시 파일을 지운다', async () => {
  const { dir, store } = setup({ maxBundle: 20 });
  await assert.rejects(store.receiveBundle(1, chunks('# v2 git bundle\n', 'xxxxx')), { message: 'BUNDLE_TOO_BIG' });
  await assert.rejects(store.receiveBundle(1, chunks('PACK 1234', '5678')), { message: 'INVALID_INPUT' });
  await assert.rejects(store.receiveBundle(1, chunks()), { message: 'INVALID_INPUT' });
  await assert.rejects(store.receiveBundle(1, Readable.from((async function* () {
    yield Buffer.from('# v3 git bundle\n');
    throw new Error('ABORTED');
  })())), { message: 'ABORTED' });
  assert.deepEqual(uploads(dir), []);
  assert.equal((await store.receiveBundle(1, chunks('# v3 git bundle\n', 'xxxx'))).size, 20);
});

test('purgeOldUploads 는 1시간 넘은 것만, purgeAllUploads 는 모든 방의 임시 파일만 지운다', () => {
  const { dir, store } = setup();
  for (const r of [1, 2]) {
    fs.mkdirSync(path.join(dir, 'rooms', String(r), 'code'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'rooms', String(r), 'code', '3.bundle'), 'b');
  }
  const mk = (r, id, ageMs) => {
    const f = path.join(dir, 'rooms', String(r), 'code', `.upload-${id.repeat(32)}`);
    fs.writeFileSync(f, 'x');
    const t = new Date(Date.now() - ageMs);
    fs.utimesSync(f, t, t);
  };
  mk(1, 'a', 2 * 3600e3);
  mk(1, 'b', 60e3);
  mk(2, 'c', 2 * 3600e3);
  store.purgeOldUploads(1);
  assert.deepEqual([uploads(dir, 1), uploads(dir, 2).length], [['.upload-' + 'b'.repeat(32)], 1]);
  store.purgeOldUploads(9); // 방 폴더가 없어도 문제없다
  store.purgeAllUploads();
  assert.deepEqual([uploads(dir, 1), uploads(dir, 2)], [[], []]);
  assert.equal(fs.readFileSync(path.join(dir, 'rooms', '1', 'code', '3.bundle'), 'utf8'), 'b');
});
