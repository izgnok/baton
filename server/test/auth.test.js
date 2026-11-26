import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { signup, login, userByToken } from '../src/auth.js';

const A = { email: 'a@x.com', password: 'password1', name: '가' };

test('signup → login → userByToken 이 같은 사용자', () => {
  const db = openDb(':memory:');
  const s = signup(db, A);
  const l = login(db, { email: A.email, password: A.password });
  assert.deepEqual(l.user, s.user);
  assert.notEqual(l.token, s.token);
  assert.deepEqual(userByToken(db, s.token), s.user);
  assert.deepEqual(userByToken(db, l.token), s.user);
});

test('같은 이메일(대소문자 다름 포함) 재가입은 EMAIL_TAKEN', () => {
  const db = openDb(':memory:');
  signup(db, A);
  assert.throws(() => signup(db, A), { message: 'EMAIL_TAKEN' });
  assert.throws(() => signup(db, { ...A, email: ' A@X.COM ' }), { message: 'EMAIL_TAKEN' });
});

test('틀린 비밀번호, 없는 이메일은 BAD_CREDENTIALS', () => {
  const db = openDb(':memory:');
  signup(db, A);
  assert.throws(() => login(db, { email: A.email, password: 'wrongpass1' }), { message: 'BAD_CREDENTIALS' });
  assert.throws(() => login(db, { email: 'no@x.com', password: A.password }), { message: 'BAD_CREDENTIALS' });
});

test('7자 비밀번호는 WEAK_PASSWORD', () => {
  const db = openDb(':memory:');
  assert.throws(() => signup(db, { ...A, password: '1234567' }), { message: 'WEAK_PASSWORD' });
});

test('이메일·이름이 비면 INVALID_INPUT', () => {
  const db = openDb(':memory:');
  assert.throws(() => signup(db, { ...A, email: ' ' }), { message: 'INVALID_INPUT' });
  assert.throws(() => signup(db, { ...A, name: '' }), { message: 'INVALID_INPUT' });
});

test('모르는 토큰은 null', () => {
  const db = openDb(':memory:');
  assert.equal(userByToken(db, 'nope'), null);
});

test('비밀번호 원문은 DB 에 저장되지 않는다', () => {
  const db = openDb(':memory:');
  signup(db, A);
  const { password_hash } = db.prepare('SELECT password_hash FROM users').get();
  assert.ok(!password_hash.includes(A.password));
  assert.match(password_hash, /^[0-9a-f]{32}:[0-9a-f]{128}$/);
});
