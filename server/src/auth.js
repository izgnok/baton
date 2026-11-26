import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

function hashPassword(password) {
  const salt = randomBytes(16);
  return `${salt.toString('hex')}:${scryptSync(password, salt, 64).toString('hex')}`;
}

function checkPassword(password, stored) {
  const [saltHex, hashHex] = stored.split(':');
  const hash = Buffer.from(hashHex, 'hex');
  return timingSafeEqual(scryptSync(password, Buffer.from(saltHex, 'hex'), 64), hash);
}

function newSession(db, user) {
  const token = randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)')
    .run(token, user.id, Date.now());
  return { token, user: { id: user.id, email: user.email, name: user.name } };
}

/** 회원가입 후 토큰 발급 */
export function signup(db, { email, password, name }) {
  email = String(email ?? '').trim().toLowerCase();
  name = String(name ?? '').trim();
  password = String(password ?? '');
  if (!email || !name) throw new Error('INVALID_INPUT');
  if (password.length < 8) throw new Error('WEAK_PASSWORD');
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw new Error('EMAIL_TAKEN');
  const { lastInsertRowid } = db
    .prepare('INSERT INTO users (email, password_hash, name, created_at) VALUES (?, ?, ?, ?)')
    .run(email, hashPassword(password), name, Date.now());
  return newSession(db, { id: Number(lastInsertRowid), email, name });
}

/** 로그인 후 토큰 발급 */
export function login(db, { email, password }) {
  email = String(email ?? '').trim().toLowerCase();
  const row = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!row || !checkPassword(String(password ?? ''), row.password_hash)) {
    throw new Error('BAD_CREDENTIALS');
  }
  return newSession(db, row);
}

/** 토큰의 사용자. 없으면 null */
export function userByToken(db, token) {
  const row = db.prepare(
    'SELECT u.id, u.email, u.name FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?',
  ).get(String(token ?? ''));
  return row ? { ...row } : null;
}
