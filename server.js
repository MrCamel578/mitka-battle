'use strict';
const path = require('node:path');
const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit').rateLimit;

const app = express();
const PORT = Number(process.env.PORT || 3000);
const isProd = process.env.NODE_ENV === 'production';
if (!process.env.DATABASE_URL) {
  console.error('Не задан DATABASE_URL. Укажите строку подключения PostgreSQL из Supabase.');
  process.exit(1);
}
if (isProd && (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32)) {
  console.error('Для production задайте SESSION_SECRET длиной не менее 32 символов.');
  process.exit(1);
}
const sessionSecret = process.env.SESSION_SECRET || 'local-development-secret-change-before-deploy-7c0c9b';
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 15000
});

async function initDb() {
  await pool.query(`CREATE TABLE IF NOT EXISTS app_users (
    id BIGSERIAL PRIMARY KEY,
    username_key TEXT NOT NULL UNIQUE,
    username TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    profile_json JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  console.log('PostgreSQL tables ready');
}
function sanitizeProfile(p) {
  const bal = Number(p?.bal), best = Number(p?.best), opened = Number(p?.opened), bonus = Number(p?.bonus);
  const inv = Array.isArray(p?.inv) ? p.inv.slice(0, 5000).filter(x => x && typeof x.n === 'string' && x.n.length <= 180 && Number.isFinite(Number(x.p)) && Number(x.p) >= 0 && ['c','b','p','k','g','y'].includes(x.r)).map(x => ({ n: x.n.replace(/[<>]/g, '').slice(0, 180), p: Math.min(1e12, Number(x.p)), r: x.r })) : [];
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
function publicUser(row) {
  if (!row) return null;
  const profile = typeof row.profile_json === 'string' ? JSON.parse(row.profile_json) : (row.profile_json || {});
  return sanitizeProfile({ ...profile, name: row.username });
}
function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Сначала войдите в аккаунт' });
  next();
}
app.disable('x-powered-by');
if (isProd) app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(express.json({ limit: '1mb', strict: true }));
app.use(session({
  name: 'mitka.sid', secret: sessionSecret, resave: false, saveUninitialized: false,
  store: new pgSession({ pool, tableName: 'user_sessions', createTableIfMissing: true }),
  cookie: { httpOnly: true, sameSite: 'strict', secure: isProd, maxAge: 7 * 24 * 60 * 60 * 1000 }, rolling: true
}));
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 12, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Слишком много попыток. Подождите 15 минут.' } });
app.post('/api/register', authLimiter, async (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!/^[\p{L}\p{N}_-]{3,16}$/u.test(name)) return res.status(400).json({ error: 'Логин: 3–16 символов, буквы, цифры, _ или -' });
  if (password.length < 8 || password.length > 128) return res.status(400).json({ error: 'Пароль должен содержать от 8 до 128 символов' });
  const key = name.toLocaleLowerCase('ru');
  const profile = sanitizeProfile({ name, bal: 1000, inv: [], opened: 0, best: 0, bonus: 0, fav: [] });
  try {
    const hash = await bcrypt.hash(password, 12);
    const result = await pool.query('INSERT INTO app_users (username_key, username, password_hash, profile_json) VALUES ($1,$2,$3,$4::jsonb) RETURNING id, username, profile_json', [key, name, hash, JSON.stringify(profile)]);
    const row = result.rows[0];
    req.session.regenerate(err => {
      if (err) return res.status(500).json({ error: 'Не удалось создать сессию' });
      req.session.userId = String(row.id);
      req.session.save(err2 => err2 ? res.status(500).json({ error: 'Не удалось сохранить сессию' }) : res.status(201).json({ user: publicUser(row) }));
    });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Этот логин уже занят' });
    console.error('register error', e); res.status(500).json({ error: 'Не удалось зарегистрировать аккаунт' });
  }
});
app.post('/api/login', authLimiter, async (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!name || !password || name.length > 80 || password.length > 128) return res.status(400).json({ error: 'Введите логин и пароль' });
  try {
    const result = await pool.query('SELECT * FROM app_users WHERE username_key = $1', [name.toLocaleLowerCase('ru')]);
    const row = result.rows[0];
    if (!row || !(await bcrypt.compare(password, row.password_hash))) return res.status(401).json({ error: 'Неверный логин или пароль' });
    req.session.regenerate(err => {
      if (err) return res.status(500).json({ error: 'Не удалось создать сессию' });
      req.session.userId = String(row.id);
      req.session.save(err2 => err2 ? res.status(500).json({ error: 'Не удалось сохранить сессию' }) : res.json({ user: publicUser(row) }));
    });
  } catch (e) { console.error('login error', e); res.status(500).json({ error: 'Ошибка входа в аккаунт' }); }
});
app.post('/api/logout', (req, res) => req.session.destroy(err => {
  res.clearCookie('mitka.sid', { httpOnly: true, sameSite: 'strict', secure: isProd });
  if (err) return res.status(500).json({ error: 'Не удалось выйти из аккаунта' });
  res.json({ ok: true });
}));
app.get('/api/me', async (req, res) => {
  if (!req.session.userId) return res.json({ user: null });
  try {
    const result = await pool.query('SELECT id, username, profile_json FROM app_users WHERE id = $1', [req.session.userId]);
    const row = result.rows[0];
    if (!row) { req.session.destroy(() => {}); return res.json({ user: null }); }
    res.json({ user: publicUser(row) });
  } catch (e) { console.error('me error', e); res.status(500).json({ error: 'Не удалось загрузить аккаунт' }); }
});
app.put('/api/state', requireAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT id, username FROM app_users WHERE id = $1', [req.session.userId]);
    const row = result.rows[0];
    if (!row) return res.status(401).json({ error: 'Аккаунт не найден' });
    const profile = sanitizeProfile({ ...req.body, name: row.username });
    await pool.query('UPDATE app_users SET profile_json = $1::jsonb, updated_at = NOW() WHERE id = $2', [JSON.stringify(profile), row.id]);
    res.json({ ok: true, user: profile });
  } catch (e) { console.error('state error', e); res.status(500).json({ error: 'Не удалось сохранить прогресс' }); }
});
app.get('/api/leaderboard', async (_req, res) => {
  try {
    const result = await pool.query("SELECT username, profile_json FROM app_users ORDER BY updated_at DESC LIMIT 1000");
    const users = result.rows.map(publicUser).sort((a, b) => b.best - a.best).slice(0, 20).map(u => ({ name: u.name, best: u.best, opened: u.opened }));
    res.json({ users });
  } catch (e) { console.error('leaderboard error', e); res.status(500).json({ error: 'Не удалось загрузить рейтинг' }); }
});
app.use('/api', (_req, res) => res.status(404).json({ error: 'API-маршрут не найден' }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'], maxAge: isProd ? '1h' : 0 }));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
(async () => {
  try {
    await initDb();
    app.listen(PORT, () => console.log(`Митька-Battle запущен на порту ${PORT}`));
  } catch (e) {
    console.error('Не удалось подключиться к PostgreSQL. Проверьте DATABASE_URL.', e.message);
    process.exit(1);
  }
})();
