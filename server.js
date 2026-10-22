'use strict';
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit').rateLimit;
const CATALOG = require('./catalog.json');
// Одинаковые независимые шансы для одиночного и массового открытия.
const { pickCaseItem } = require('./lib/case-balance');

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
  await pool.query(`ALTER TABLE app_users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'player'`);
  await pool.query(`ALTER TABLE app_users ADD COLUMN IF NOT EXISTS banned BOOLEAN NOT NULL DEFAULT FALSE`);
  await pool.query(`ALTER TABLE app_users ADD COLUMN IF NOT EXISTS ban_reason TEXT`);
  await pool.query(`ALTER TABLE app_users ADD COLUMN IF NOT EXISTS last_seen TIMESTAMPTZ`);
  await pool.query(`CREATE TABLE IF NOT EXISTS admin_audit (
    id BIGSERIAL PRIMARY KEY, admin_id BIGINT REFERENCES app_users(id), admin_name TEXT NOT NULL,
    action TEXT NOT NULL, target TEXT, details JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS chat_messages (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    sender_id BIGINT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    sender_name TEXT NOT NULL,
    sender_role TEXT NOT NULL DEFAULT 'player',
    body TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 1000),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  // The site owner account is the designated chat administrator.
  await pool.query("UPDATE app_users SET role='admin' WHERE username_key='idi0t578'");
  // Promote the configured existing account without changing its password.
  // If it does not exist yet, create one only when both credentials are explicitly configured.
  if (process.env.ADMIN_USERNAME) {
    const username = process.env.ADMIN_USERNAME.trim();
    const key = username.toLocaleLowerCase('ru');
    const existing = await pool.query("UPDATE app_users SET role='admin' WHERE username_key=$1 RETURNING id", [key]);
    if (!existing.rowCount && process.env.ADMIN_PASSWORD) {
      const hash = await bcrypt.hash(process.env.ADMIN_PASSWORD, 12);
      await pool.query(`INSERT INTO app_users (username_key, username, password_hash, profile_json, role)
        VALUES ($1,$2,$3,$4::jsonb,'admin') ON CONFLICT (username_key) DO UPDATE SET role='admin'`,
        [key, username, hash, JSON.stringify(sanitizeProfile({name: username, bal: 0, inv: [], opened: 0, best: 0, bonus: 0, fav: []}))]);
    } else if (!existing.rowCount) {
      console.warn('ADMIN_USERNAME не найден в базе. Для создания нового администратора нужны ADMIN_USERNAME и ADMIN_PASSWORD; существующие пароли не изменяются.');
    }
  }
  console.log('PostgreSQL tables ready');
}
function sanitizeProfile(p) {
  const bal = Number(p?.bal), best = Number(p?.best), opened = Number(p?.opened), bonus = Number(p?.bonus);
  const inv = Array.isArray(p?.inv) ? p.inv.slice(0, 5000).filter(x => x && typeof x.n === 'string' && x.n.length <= 180 && Number.isFinite(Number(x.p)) && Number(x.p) >= 0 && ['c','b','p','k','g','y'].includes(x.r)).map(x => ({ n: x.n.replace(/[<>]/g, '').slice(0, 180), p: Math.min(1e12, Number(x.p)), r: x.r, locked: Boolean(x.locked) })) : [];
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
  return { ...sanitizeProfile({ ...profile, name: row.username }), id: Number(row.id), role: row.role || 'player', banned: Boolean(row.banned), banReason: row.ban_reason || null };
}
function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Сначала войдите в аккаунт' });
  next();
}
async function requireAdmin(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Сначала войдите в аккаунт' });
  try {
    const r = await pool.query('SELECT role FROM app_users WHERE id=$1', [req.session.userId]);
    if (r.rows[0]?.role !== 'admin') return res.status(403).json({ error: 'Недостаточно прав' });
    next();
  } catch (e) { console.error('admin auth error', e); res.status(500).json({ error: 'Ошибка проверки прав' }); }
}
async function audit(req, action, target, details={}) {
  return auditWithClient(pool, req, action, target, details);
}
async function auditWithClient(client, req, action, target, details={}) {
  await client.query('INSERT INTO admin_audit (admin_id, admin_name, action, target, details) VALUES ($1,$2,$3,$4,$5::jsonb)',
    [req.session.userId, req.session.username || 'admin', action, String(target || ''), JSON.stringify(details)]);
}
function parseAdminUserId(value) {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
}
function inventoryVersion(inv) {
  const sanitizedInventory = sanitizeProfile({ inv }).inv;
  return crypto.createHash('sha256').update(JSON.stringify(sanitizedInventory)).digest('hex');
}
function adminError(message, status) {
  return Object.assign(new Error(message), { status });
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
      req.session.userId = String(row.id); req.session.username = row.username;
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
      req.session.userId = String(row.id); req.session.username = row.username;
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
    const result = await pool.query('SELECT id, username, profile_json, role, banned, ban_reason FROM app_users WHERE id = $1', [req.session.userId]);
    const row = result.rows[0];
    if (!row) { req.session.destroy(() => {}); return res.json({ user: null }); }
    res.json({ user: publicUser(row) });
  } catch (e) { console.error('me error', e); res.status(500).json({ error: 'Не удалось загрузить аккаунт' }); }
});
app.put('/api/state', requireAuth, async (req, res) => {
  const cx = await pool.connect();
  try {
    await cx.query('BEGIN');
    const { row, profile: existing } = await loadLockedUser(cx, req.session.userId);
    // The client may persist favourites only. Balance and inventory always remain authoritative on the server.
    const profile = { ...existing, fav: sanitizeProfile({ ...existing, fav: req.body?.fav }).fav, name: row.username };
    await cx.query('UPDATE app_users SET profile_json = $1::jsonb, updated_at = NOW() WHERE id = $2', [JSON.stringify(profile), row.id]);
    await cx.query('COMMIT');
    res.json({ ok: true, user: publicUser({ ...row, profile_json: profile }) });
  } catch (e) {
    await cx.query('ROLLBACK');
    console.error('state error', e);
    res.status(e.status || 500).json({ error: e.message || 'Не удалось сохранить настройки' });
  } finally { cx.release(); }
});
async function loadLockedUser(client, userId) {
  const r = await client.query('SELECT id,username,profile_json,role,banned,ban_reason FROM app_users WHERE id=$1 FOR UPDATE', [userId]);
  if (!r.rowCount) throw Object.assign(new Error('Аккаунт не найден'), { status: 401 });
  const row = r.rows[0];
  if (row.banned) throw Object.assign(new Error(`Вы забанены${row.ban_reason ? ': ' + row.ban_reason : ''}`), { status: 403 });
  return { row, profile: sanitizeProfile(row.profile_json) };
}
async function persistProfile(client, row, profile) {
  await client.query('UPDATE app_users SET profile_json=$1::jsonb,updated_at=NOW(),last_seen=NOW() WHERE id=$2', [JSON.stringify(profile), row.id]);
  return publicUser({ ...row, profile_json: profile });
}
app.post('/api/open-case', requireAuth, async (req,res) => {
  const caseId=Number(req.body?.caseId), count=Number(req.body?.count);
  if(!Number.isInteger(caseId)||!Number.isInteger(count)||count<1||count>10)return res.status(400).json({error:'Некорректное количество кейсов'});
  const c=CATALOG.CASES.find(x=>x.id===caseId);if(!c)return res.status(404).json({error:'Кейс не найден'});
  const cx=await pool.connect();try{await cx.query('BEGIN');const {row,profile}=await loadLockedUser(cx,req.session.userId);const cost=c.price*count;if(profile.bal<cost)throw Object.assign(new Error('Не хватает денег'),{status:400});profile.bal-=cost;profile.opened+=count;const wins=[];const winIndices=[];for(let i=0;i<count;i++){const item=pickCaseItem(c);wins.push(item);profile.inv.push(item);winIndices.push(profile.inv.length-1);profile.best=Math.max(profile.best,item.p);}const user=await persistProfile(cx,row,profile);await cx.query('COMMIT');res.json({ok:true,user,wins,winIndices,casePrice:c.price});}catch(e){await cx.query('ROLLBACK');res.status(e.status||500).json({error:e.message||'Не удалось открыть кейс'});}finally{cx.release();}
});
app.post('/api/upgrade', requireAuth, async (req,res) => {
  const indices=Array.isArray(req.body?.indices)?req.body.indices:[],targetIndex=Number(req.body?.targetIndex);
  if(indices.length<1||indices.length>500||indices.some(i=>!Number.isInteger(i)||i<0)||new Set(indices).size!==indices.length||!Number.isInteger(targetIndex)||!CATALOG.SK[targetIndex])return res.status(400).json({error:'Некорректные предметы или цель'});
  const cx=await pool.connect();try{await cx.query('BEGIN');const {row,profile}=await loadLockedUser(cx,req.session.userId);if(indices.some(i=>i>=profile.inv.length))throw Object.assign(new Error('Инвентарь изменился. Обновите страницу'),{status:409});if(indices.some(i=>profile.inv[i].locked))throw Object.assign(new Error('Заблокированные скины нельзя использовать в апгрейде'),{status:400});const stake=indices.reduce((sum,i)=>sum+profile.inv[i].p,0);const target=CATALOG.SK[targetIndex];const targetItem={n:target[0],p:Number(target[1]),r:target[2]};if(targetItem.p<=stake)throw Object.assign(new Error('Цель должна быть дороже выбранных предметов'),{status:400});const chance=Math.min(90,stake/targetItem.p*95);const win=Math.random()*100<chance;for(const i of [...indices].sort((a,b)=>b-a))profile.inv.splice(i,1);if(win){profile.inv.push(targetItem);profile.best=Math.max(profile.best,targetItem.p);}const user=await persistProfile(cx,row,profile);await cx.query('COMMIT');res.json({ok:true,user,win,item:win?targetItem:null,chance});}catch(e){await cx.query('ROLLBACK');res.status(e.status||500).json({error:e.message||'Не удалось выполнить апгрейд'});}finally{cx.release();}
});
app.post('/api/sell', requireAuth, async (req,res) => {
  const all=req.body?.all===true,indices=Array.isArray(req.body?.indices)?req.body.indices:[];
  if(!all&&(!indices.length||indices.some(i=>!Number.isInteger(i)||i<0)||new Set(indices).size!==indices.length))return res.status(400).json({error:'Выберите предметы для продажи'});
  const cx=await pool.connect();try{await cx.query('BEGIN');const {row,profile}=await loadLockedUser(cx,req.session.userId);const chosen=all?profile.inv.map((item,i)=>item.locked?-1:i).filter(i=>i>=0):indices;if(chosen.some(i=>i>=profile.inv.length))throw Object.assign(new Error('Инвентарь изменился. Обновите страницу'),{status:409});if(chosen.some(i=>profile.inv[i].locked))throw Object.assign(new Error('Сначала разблокируйте выбранные скины'),{status:400});let amount=0;for(const i of chosen)amount+=profile.inv[i].p;for(const i of [...chosen].sort((a,b)=>b-a))profile.inv.splice(i,1);profile.bal+=amount;const user=await persistProfile(cx,row,profile);await cx.query('COMMIT');res.json({ok:true,user,amount});}catch(e){await cx.query('ROLLBACK');res.status(e.status||500).json({error:e.message||'Не удалось продать предметы'});}finally{cx.release();}
});
app.post('/api/bonus', requireAuth, async (req,res) => {
  const cx=await pool.connect();try{await cx.query('BEGIN');const {row,profile}=await loadLockedUser(cx,req.session.userId);const now=Date.now();if(now-Number(profile.bonus||0)<86400000)throw Object.assign(new Error('Бонус уже получен. Приходи завтра.'),{status:400});profile.bonus=now;profile.bal+=100;const user=await persistProfile(cx,row,profile);await cx.query('COMMIT');res.json({ok:true,user,amount:100});}catch(e){await cx.query('ROLLBACK');res.status(e.status||500).json({error:e.message||'Не удалось забрать бонус'});}finally{cx.release();}
});
// Presence is updated by the client heartbeat; only minimal public profile details are exposed to admins.
app.post('/api/guard', requireAuth, async (req,res) => {
  try { const r=await pool.query('SELECT banned,ban_reason FROM app_users WHERE id=$1',[req.session.userId]); if(!r.rowCount)return res.status(401).json({error:'Аккаунт не найден'}); if(r.rows[0].banned)return res.status(403).json({error:`Вы забанены${r.rows[0].ban_reason?': '+r.rows[0].ban_reason:''}`,banned:true}); res.json({ok:true}); }
  catch(e){console.error('guard error',e);res.status(500).json({error:'Не удалось проверить доступ'});}
});
app.post('/api/presence', requireAuth, async (req, res) => {
  try {
    const r = await pool.query('UPDATE app_users SET last_seen=NOW() WHERE id=$1 RETURNING banned, ban_reason', [req.session.userId]);
    if (!r.rowCount) return res.status(401).json({error:'Аккаунт не найден'});
    if (r.rows[0].banned) return res.status(403).json({error:`Вы забанены${r.rows[0].ban_reason ? ': '+r.rows[0].ban_reason : ''}`, banned:true});
    res.json({ok:true});
  } catch(e) { console.error('presence error',e); res.status(500).json({error:'Не удалось обновить статус'}); }
});
app.get('/api/admin/users', requireAuth, requireAdmin, async (req, res) => {
  const rawSearch = req.query?.search;
  const rawOffset = req.query?.offset;
  const rawLimit = req.query?.limit;
  const search = rawSearch === undefined ? '' : (typeof rawSearch === 'string' ? rawSearch.trim() : null);
  const offset = rawOffset === undefined ? 0 : (/^\d+$/.test(String(rawOffset)) ? Number(rawOffset) : NaN);
  const limit = rawLimit === undefined ? 50 : (/^\d+$/.test(String(rawLimit)) ? Number(rawLimit) : NaN);
  if (search === null || search.length > 80 || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    return res.status(400).json({ error: 'Некорректные параметры списка игроков' });
  }
  try {
    const searchId = parseAdminUserId(search);
    const where = !search ? "WHERE role <> 'admin'" : searchId
      ? "WHERE role <> 'admin' AND (username ILIKE $1 OR id=$2)"
      : "WHERE role <> 'admin' AND username ILIKE $1";
    const searchArgs = search ? [`%${search}%`] : [];
    if (searchId) searchArgs.push(searchId);
    const count = await pool.query(`SELECT COUNT(*)::int AS total FROM app_users ${where}`, searchArgs);
    const pageArgs = [...searchArgs, limit, offset];
    const limitParam = `$${searchArgs.length + 1}`;
    const offsetParam = `$${searchArgs.length + 2}`;
    const result = await pool.query(`SELECT id, username, profile_json, banned, last_seen,
      (last_seen > NOW() - INTERVAL '90 seconds') AS online
      FROM app_users ${where} ORDER BY last_seen DESC NULLS LAST, id DESC LIMIT ${limitParam} OFFSET ${offsetParam}`, pageArgs);
    const users = result.rows.map(row => {
      const profile = sanitizeProfile(row.profile_json);
      return {
        id: Number(row.id), username: row.username, bal: profile.bal, items: profile.inv.length,
        banned: Boolean(row.banned), lastSeen: row.last_seen || null, online: Boolean(row.online)
      };
    });
    res.json({ users, total: Number(count.rows[0]?.total || 0), offset, limit });
  } catch (e) { console.error('admin users error', e); res.status(500).json({ error: 'Не удалось загрузить список игроков' }); }
});
app.get('/api/admin/users/:id/inventory', requireAuth, requireAdmin, async (req, res) => {
  const userId = parseAdminUserId(req.params.id);
  if (!userId) return res.status(400).json({ error: 'Некорректный ID игрока' });
  try {
    const result = await pool.query("SELECT id, username, profile_json, banned FROM app_users WHERE id=$1 AND role <> 'admin'", [userId]);
    if (!result.rowCount) return res.status(404).json({ error: 'Игрок не найден' });
    const row = result.rows[0];
    const profile = sanitizeProfile(row.profile_json);
    const items = profile.inv.map((item, index) => ({ index, n: item.n, p: item.p, r: item.r, locked: item.locked }));
    res.json({
      player: { id: Number(row.id), username: row.username, bal: profile.bal, banned: Boolean(row.banned) },
      items,
      inventoryVersion: inventoryVersion(profile.inv)
    });
  } catch (e) { console.error('admin inventory error', e); res.status(500).json({ error: 'Не удалось загрузить инвентарь игрока' }); }
});
app.get('/api/admin/online', requireAuth, requireAdmin, async (req,res) => {
  try {
    const r=await pool.query(`SELECT id,username,profile_json,banned,last_seen FROM app_users WHERE role <> 'admin' AND last_seen > NOW()-INTERVAL '90 seconds' ORDER BY last_seen DESC LIMIT 200`);
    res.json({users:r.rows.map(x=>{const p=publicUser({...x,role:'player'});return {id:Number(x.id),username:x.username,bal:p.bal,items:p.inv.length,banned:x.banned,lastSeen:x.last_seen};})});
  } catch(e){console.error('online list error',e);res.status(500).json({error:'Не удалось загрузить список игроков'});}
});
app.get('/api/admin/audit', requireAuth, requireAdmin, async (_req,res) => {
  try { const r=await pool.query('SELECT admin_name,action,target,details,created_at FROM admin_audit ORDER BY id DESC LIMIT 100'); res.json({logs:r.rows.map(x=>({admin:x.admin_name,action:x.action,target:x.target,details:x.details||{},createdAt:x.created_at}))}); }
  catch(e){console.error('audit read error',e);res.status(500).json({error:'Не удалось загрузить журнал'});}
});
app.post('/api/admin/users/:id/money', requireAuth, requireAdmin, async (req,res) => {
  const userId = parseAdminUserId(req.params.id);
  const amount = Number(req.body?.amount);
  const mode = req.body?.mode === undefined ? 'add' : req.body.mode;
  if (!userId) return res.status(400).json({ error: 'Некорректный ID игрока' });
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1e9 || !['add', 'remove'].includes(mode)) return res.status(400).json({ error: 'Сумма должна быть больше 0 и не превышать 1 000 000 000; mode: add или remove' });
  const cx=await pool.connect();
  try {
    await cx.query('BEGIN');
    const r=await cx.query("SELECT id,username,profile_json FROM app_users WHERE id=$1 AND role <> 'admin' FOR UPDATE",[userId]);
    if(!r.rowCount) throw adminError('Игрок не найден', 404);
    const row = r.rows[0];
    const p=sanitizeProfile(row.profile_json);
    if (mode === 'remove' && p.bal < amount) throw adminError('Недостаточно средств на балансе игрока', 400);
    const actualAmount = mode === 'add' ? Math.min(amount, Math.max(0, 1e12 - p.bal)) : amount;
    if (actualAmount <= 0) throw adminError('Баланс игрока уже достиг лимита', 400);
    p.bal = mode === 'add' ? p.bal + actualAmount : p.bal - actualAmount;
    await cx.query('UPDATE app_users SET profile_json=$1::jsonb,updated_at=NOW() WHERE id=$2',[JSON.stringify(p),row.id]);
    await auditWithClient(cx, req, mode === 'add' ? 'Выдача денег' : 'Списание денег', row.username, { mode, amount: actualAmount, requestedAmount: amount, balance: p.bal });
    await cx.query('COMMIT');
    res.json({ok:true,balance:p.bal,amount:actualAmount});
  }catch(e){await cx.query('ROLLBACK');if(!e.status)console.error('money mutation error',e);res.status(e.status||500).json({error:e.message||'Не удалось изменить баланс'});}finally{cx.release();}
});
app.post('/api/admin/users/:id/skin', requireAuth, requireAdmin, async (req,res) => {
  const userId = parseAdminUserId(req.params.id);
  const name=typeof req.body?.name==='string'?req.body.name.trim().slice(0,180):'';
  const price=Number(req.body?.price);
  if (!userId) return res.status(400).json({ error: 'Некорректный ID игрока' });
  if(!name||!Number.isFinite(price)||price<0||price>1e12)return res.status(400).json({error:'Укажите название и корректную стоимость'});
  const cx=await pool.connect();
  try {
    await cx.query('BEGIN');
    const r=await cx.query("SELECT id,username,profile_json FROM app_users WHERE id=$1 AND role <> 'admin' FOR UPDATE",[userId]);
    if(!r.rowCount) throw adminError('Игрок не найден', 404);
    const row = r.rows[0];
    const p=sanitizeProfile(row.profile_json);
    if (p.inv.length >= 5000) throw adminError('Лимит инвентаря игрока: 5000 предметов', 400);
    const item={n:name,p:price,r:price>=100000?'y':price>=10000?'g':price>=1000?'p':price>=100?'b':'c',locked:false};
    p.inv.push(item);
    await cx.query('UPDATE app_users SET profile_json=$1::jsonb,updated_at=NOW() WHERE id=$2',[JSON.stringify(p),row.id]);
    await auditWithClient(cx, req, 'Выдача скина', row.username, item);
    await cx.query('COMMIT');
    res.json({ok:true});
  }catch(e){await cx.query('ROLLBACK');if(!e.status)console.error('grant skin error',e);res.status(e.status||500).json({error:e.message||'Не удалось выдать скин'});}finally{cx.release();}
});
app.post('/api/admin/users/:id/skins/remove', requireAuth, requireAdmin, async (req,res) => {
  const userId = parseAdminUserId(req.params.id);
  const indices = Array.isArray(req.body?.indices) ? req.body.indices : [];
  const expectedVersion = req.body?.inventoryVersion;
  if (!userId) return res.status(400).json({ error: 'Некорректный ID игрока' });
  if (!indices.length || indices.length > 5000 || indices.some(index => !Number.isInteger(index) || index < 0) || new Set(indices).size !== indices.length || typeof expectedVersion !== 'string' || !/^[a-f0-9]{64}$/.test(expectedVersion)) {
    return res.status(400).json({ error: 'Укажите уникальные индексы предметов и актуальную версию инвентаря' });
  }
  const cx=await pool.connect();
  try {
    await cx.query('BEGIN');
    const r=await cx.query("SELECT id,username,profile_json FROM app_users WHERE id=$1 AND role <> 'admin' FOR UPDATE",[userId]);
    if(!r.rowCount) throw adminError('Игрок не найден', 404);
    const row = r.rows[0];
    const p = sanitizeProfile(row.profile_json);
    if (inventoryVersion(p.inv) !== expectedVersion) throw adminError('Инвентарь изменился. Обновите страницу', 409);
    if (indices.some(index => index >= p.inv.length)) throw adminError('Некорректный индекс предмета', 400);
    const removed = indices.map(index => ({ ...p.inv[index] }));
    for (const index of [...indices].sort((a, b) => b - a)) p.inv.splice(index, 1);
    await cx.query('UPDATE app_users SET profile_json=$1::jsonb,updated_at=NOW() WHERE id=$2',[JSON.stringify(p),row.id]);
    await auditWithClient(cx, req, 'Изъятие скинов', row.username, { indices, removed, inventoryVersion: expectedVersion });
    await cx.query('COMMIT');
    res.json({ok:true,removed,balance:p.bal,items:p.inv.length});
  }catch(e){await cx.query('ROLLBACK');if(!e.status)console.error('remove skins error',e);res.status(e.status||500).json({error:e.message||'Не удалось изъять скины'});}finally{cx.release();}
});
app.post('/api/admin/users/:id/ban', requireAuth, requireAdmin, async (req,res) => {
  const userId = parseAdminUserId(req.params.id);
  const banned=Boolean(req.body?.banned);const reason=typeof req.body?.reason==='string'?req.body.reason.trim().slice(0,500):'';
  if (!userId) return res.status(400).json({ error: 'Некорректный ID игрока' });
  const cx=await pool.connect();
  try {
    await cx.query('BEGIN');
    const r=await cx.query("SELECT id,username FROM app_users WHERE id=$1 AND role <> 'admin' FOR UPDATE",[userId]);
    if(!r.rowCount) throw adminError('Игрок не найден', 404);
    const row = r.rows[0];
    await cx.query('UPDATE app_users SET banned=$1,ban_reason=$2,updated_at=NOW() WHERE id=$3',[banned,banned?reason:null,row.id]);
    await auditWithClient(cx, req, banned?'Бан':'Разбан', row.username, { reason });
    await cx.query('COMMIT');
    res.json({ok:true});
  }catch(e){await cx.query('ROLLBACK');if(!e.status)console.error('ban error',e);res.status(e.status||500).json({error:e.message||'Не удалось изменить статус бана'});}finally{cx.release();}
});
app.post('/api/contracts', requireAuth, async (req,res) => {
  const indices=Array.isArray(req.body?.indices)?req.body.indices:[];
  if(indices.length<3||indices.length>10||indices.some(i=>!Number.isInteger(i)||i<0)||new Set(indices).size!==indices.length)return res.status(400).json({error:'Выберите от 3 до 10 предметов'});
  const cx=await pool.connect();
  try {
    await cx.query('BEGIN');
    const {row,profile}=await loadLockedUser(cx,req.session.userId);
    if(indices.some(i=>i>=profile.inv.length))throw Object.assign(new Error('Инвентарь изменился. Обновите страницу'),{status:409});
    if(indices.some(i=>profile.inv[i].locked))throw Object.assign(new Error('Разблокируйте скины, которые хотите положить в контракт'),{status:400});
    const selected=indices.map(i=>profile.inv[i]);
    const total=selected.reduce((a,x)=>a+x.p,0);
    // Контракт гарантированно возвращает один предмет. Основной диапазон наград — 0.85–2.2x стоимости входа;
    // если в каталоге нет подходящих предметов, берём ближайшие по цене, чтобы результат не был пустым.
    const min=Math.max(1,total*0.85), max=Math.max(2,total*2.2);
    let candidates=CATALOG.SK.filter(x=>Number(x[1])>=min&&Number(x[1])<=max);
    if(!candidates.length)candidates=CATALOG.SK.slice().sort((a,b)=>Math.abs(Number(a[1])-total)-Math.abs(Number(b[1])-total)).slice(0,Math.min(30,CATALOG.SK.length));
    const weighted=candidates.map(x=>({x,w:({c:1.0,b:1.15,p:1.3,k:1.5,g:1.7,y:1.9}[x[2]]||1)}));
    const weightTotal=weighted.reduce((a,x)=>a+x.w,0);let roll=Math.random()*weightTotal;let target=weighted[weighted.length-1].x;
    for(const candidate of weighted){roll-=candidate.w;if(roll<=0){target=candidate.x;break;}}
    const item={n:target[0],p:Number(target[1]),r:target[2],locked:false};
    for(const i of [...indices].sort((a,b)=>b-a))profile.inv.splice(i,1);
    profile.inv.push(item);profile.best=Math.max(profile.best,item.p);
    const user=await persistProfile(cx,row,profile);await cx.query('COMMIT');
    res.json({ok:true,win:true,item,user,inputValue:total,multiplier:item.p/Math.max(total,0.01)});
  } catch(e) { await cx.query('ROLLBACK');res.status(e.status||500).json({error:e.message||'Не удалось выполнить контракт'}); }
  finally { cx.release(); }
});
app.post('/api/lock-skin', requireAuth, async (req,res) => {
  const index=Number(req.body?.index), locked=Boolean(req.body?.locked);
  if(!Number.isInteger(index)||index<0)return res.status(400).json({error:'Некорректный индекс скина'});
  const cx=await pool.connect();
  try {
    await cx.query('BEGIN');
    const {row,profile}=await loadLockedUser(cx,req.session.userId);
    if(index>=profile.inv.length)throw Object.assign(new Error('Инвентарь изменился. Обновите страницу'),{status:409});
    profile.inv[index].locked=locked;
    const user=await persistProfile(cx,row,profile);
    await cx.query('COMMIT');res.json({ok:true,user,index,locked});
  } catch(e) { await cx.query('ROLLBACK');res.status(e.status||500).json({error:e.message||'Не удалось изменить блокировку'}); }
  finally { cx.release(); }
});
app.get('/api/chat/messages', requireAuth, async (req, res) => {
  try {
    const me = await pool.query('SELECT id, username, role FROM app_users WHERE id=$1', [req.session.userId]);
    if (!me.rowCount) return res.status(401).json({ error: 'Аккаунт не найден' });
    const admin = me.rows[0].role === 'admin';
    const requested = Number(req.query.userId);
    const userId = admin ? requested : Number(req.session.userId);
    if (!Number.isInteger(userId) || userId < 1) return res.status(400).json({ error: 'Не указан игрок для чата' });
    if (!admin && userId !== Number(req.session.userId)) return res.status(403).json({ error: 'Нет доступа к этому чату' });
    const result = await pool.query(`SELECT id, user_id AS "userId", sender_id AS "senderId", sender_name AS "senderName", sender_role AS "senderRole", body, created_at AS "createdAt"
      FROM chat_messages WHERE user_id=$1 ORDER BY id DESC LIMIT 200`, [userId]);
    res.json({ ok: true, admin, userId, messages: result.rows.reverse() });
  } catch (e) { console.error('chat messages error', e); res.status(500).json({ error: 'Не удалось загрузить сообщения' }); }
});
app.get('/api/chat/conversations', requireAuth, requireAdmin, async (_req, res) => {
  try {
    const result = await pool.query(`SELECT u.id, u.username, MAX(m.created_at) AS "lastAt", COUNT(m.id)::int AS "messages"
      FROM app_users u JOIN chat_messages m ON m.user_id=u.id WHERE u.role <> 'admin'
      GROUP BY u.id, u.username ORDER BY "lastAt" DESC LIMIT 100`);
    res.json({ ok: true, conversations: result.rows });
  } catch (e) { console.error('chat conversations error', e); res.status(500).json({ error: 'Не удалось загрузить список чатов' }); }
});
app.post('/api/chat/messages', requireAuth, async (req, res) => {
  const body = typeof req.body?.body === 'string' ? req.body.body.trim() : '';
  if (!body || body.length > 1000) return res.status(400).json({ error: 'Сообщение должно содержать от 1 до 1000 символов' });
  try {
    const me = await pool.query('SELECT id, username, role FROM app_users WHERE id=$1', [req.session.userId]);
    if (!me.rowCount) return res.status(401).json({ error: 'Аккаунт не найден' });
    const admin = me.rows[0].role === 'admin';
    const requested = Number(req.body?.userId);
    const userId = admin ? requested : Number(req.session.userId);
    if (!Number.isInteger(userId) || userId < 1) return res.status(400).json({ error: 'Не указан игрок для чата' });
    if (!admin && userId !== Number(req.session.userId)) return res.status(403).json({ error: 'Нет доступа к этому чату' });
    const target = await pool.query('SELECT id FROM app_users WHERE id=$1', [userId]);
    if (!target.rowCount) return res.status(404).json({ error: 'Игрок не найден' });
    const sender = me.rows[0];
    const result = await pool.query(`INSERT INTO chat_messages (user_id, sender_id, sender_name, sender_role, body)
      VALUES ($1,$2,$3,$4,$5) RETURNING id, user_id AS "userId", sender_id AS "senderId", sender_name AS "senderName", sender_role AS "senderRole", body, created_at AS "createdAt"`,
      [userId, sender.id, sender.username, sender.role, body]);
    res.status(201).json({ ok: true, message: result.rows[0] });
  } catch (e) { console.error('chat send error', e); res.status(500).json({ error: 'Не удалось отправить сообщение' }); }
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
