'use strict';
const path = require('node:path');
const fs = require('node:fs');
const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit').rateLimit;
const Database = require('better-sqlite3');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const isProd = process.env.NODE_ENV === 'production';
if (isProd && (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32)) {
  console.error('Для production задайте SESSION_SECRET длиной не менее 32 символов.');
  process.exit(1);
}
const sessionSecret = process.env.SESSION_SECRET || 'local-development-secret-change-before-deploy-7c0c9b';
const db = new Database(path.join(DATA_DIR, 'accounts.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username_key TEXT NOT NULL UNIQUE,
  username TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  profile_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);
const findUser = db.prepare('SELECT * FROM users WHERE username_key = ?');
const createUser = db.prepare('INSERT INTO users (username_key, username, password_hash, profile_json) VALUES (?, ?, ?, ?)');
const updateProfile = db.prepare('UPDATE users SET profile_json = ?, updated_at = datetime(\'now\') WHERE id = ?');
const publicUser = row => {
  if (!row) return null;
  let profile = {};
  try { profile = JSON.parse(row.profile_json); } catch {}
  return sanitizeProfile({ ...profile, name: row.username });
};
function sanitizeProfile(p) {
  const bal = Number(p?.bal);
  const best = Number(p?.best);
  const opened = Number(p?.opened);
  const bonus = Number(p?.bonus);
  const inv = Array.isArray(p?.inv) ? p.inv.slice(0, 5000).filter(x => x && typeof x.n === 'string' && x.n.length <= 180 && Number.isFinite(Number(x.p)) && Number(x.p) >= 0 && ['c','b','p','k','g','y'].includes(x.r)) .map(x => ({ n: x.n.replace(/[<>]/g, '').slice(0, 180), p: Math.min(1e12, Number(x.p)), r: x.r })) : [];
  const fav = Array.isArray(p?.fav) ? [...new Set(p.fav.filter(x => Number.isInteger(x) || (typeof x === 'string' && x.length < 80)))].slice(0, 1000) : [];
  return {
    name: typeof p?.name === 'string' ? p.name.slice(0, 16) : 'Игрок',
    bal: Number.isFinite(bal) ? Math.max(0, Math.min(1e12, bal)) : 1000,
    inv,
    opened: Number.isFinite(opened) ? Math.max(0, Math.min(1e9, Math.floor(opened))) : 0,
    best: Number.isFinite(best) ? Math.max(0, Math.min(1e12, best)) : 0,
    bonus: Number.isFinite(bonus) ? Math.max(0, Math.min(1e15, bonus)) : 0,
    fav
  };
}
function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Сначала войдите в аккаунт' });
  next();
}
app.disable('x-powered-by');
// Render and other reverse-proxy hosts terminate HTTPS before forwarding to Node.
if (isProd) app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(express.json({ limit: '1mb', strict: true }));
app.use(session({
  name: 'mitka.sid', secret: sessionSecret, resave: false, saveUninitialized: false,
  store: new SQLiteStore({ db: 'sessions.sqlite', dir: DATA_DIR, concurrentDB: true }),
  cookie: { httpOnly: true, sameSite: 'strict', secure: isProd, maxAge: 7 * 24 * 60 * 60 * 1000 },
  rolling: true
}));
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 12, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Слишком много попыток. Подождите 15 минут.' } });
app.post('/api/register', authLimiter, async (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!/^[\p{L}\p{N}_-]{3,16}$/u.test(name)) return res.status(400).json({ error: 'Логин: 3–16 символов, буквы, цифры, _ или -' });
  if (password.length < 8 || password.length > 128) return res.status(400).json({ error: 'Пароль должен содержать от 8 до 128 символов' });
  const key = name.toLocaleLowerCase('ru');
  if (findUser.get(key)) return res.status(409).json({ error: 'Этот логин уже занят' });
  const profile = sanitizeProfile({ name, bal: 1000, inv: [], opened: 0, best: 0, bonus: 0, fav: [] });
  try {
    const hash = await bcrypt.hash(password, 12);
    const result = createUser.run(key, name, hash, JSON.stringify(profile));
    req.session.regenerate(err => {
      if (err) return res.status(500).json({ error: 'Не удалось создать сессию' });
      req.session.userId = Number(result.lastInsertRowid);
      req.session.usernameKey = key;
      req.session.save(err2 => err2 ? res.status(500).json({ error: 'Не удалось сохранить сессию' }) : res.status(201).json({ user: profile }));
    });
  } catch (e) {
    if (String(e.code).includes('SQLITE_CONSTRAINT')) return res.status(409).json({ error: 'Этот логин уже занят' });
    console.error(e); res.status(500).json({ error: 'Не удалось зарегистрировать аккаунт' });
  }
});
app.post('/api/login', authLimiter, async (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!name || !password || name.length > 80 || password.length > 128) return res.status(400).json({ error: 'Введите логин и пароль' });
  const key = name.toLocaleLowerCase('ru');
  const row = findUser.get(key);
  if (!row || !(await bcrypt.compare(password, row.password_hash))) return res.status(401).json({ error: 'Неверный логин или пароль' });
  req.session.regenerate(err => {
    if (err) return res.status(500).json({ error: 'Не удалось создать сессию' });
    req.session.userId = row.id; req.session.usernameKey = key;
    req.session.save(err2 => err2 ? res.status(500).json({ error: 'Не удалось сохранить сессию' }) : res.json({ user: publicUser(row) }));
  });
});
app.post('/api/logout', (req, res) => req.session.destroy(err => {
  res.clearCookie('mitka.sid', { httpOnly: true, sameSite: 'strict', secure: isProd });
  if (err) return res.status(500).json({ error: 'Не удалось выйти из аккаунта' });
  res.json({ ok: true });
}));
app.get('/api/me', (req, res) => {
  if (!req.session.userId) return res.json({ user: null });
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  if (!row) { req.session.destroy(() => {}); return res.json({ user: null }); }
  res.json({ user: publicUser(row) });
});
app.put('/api/state', requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  if (!row) return res.status(401).json({ error: 'Аккаунт не найден' });
  const profile = sanitizeProfile({ ...req.body, name: row.username });
  updateProfile.run(JSON.stringify(profile), row.id);
  res.json({ ok: true, user: profile });
});
app.get('/api/leaderboard', (_req, res) => {
  const rows = db.prepare('SELECT username, profile_json FROM users ORDER BY updated_at DESC LIMIT 1000').all();
  const users = rows.map(row => publicUser({ username: row.username, profile_json: row.profile_json }))
    .sort((a, b) => b.best - a.best).slice(0, 20)
    .map(u => ({ name: u.name, best: u.best, opened: u.opened }));
  res.json({ users });
});
app.use('/api', (_req, res) => res.status(404).json({ error: 'API-маршрут не найден' }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'], maxAge: isProd ? '1h' : 0 }));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.listen(PORT, () => console.log(`Митька-Battle запущен: http://localhost:${PORT}`));
