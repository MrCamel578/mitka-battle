'use strict';

// No network or PostgreSQL server is used: server.js runs in a VM with Express and Pool fakes.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const routes = [];
const db = { users: new Map(), audits: [], calls: [] };

function profile(bal, inv, fav = []) {
  return { name: 'Игрок', bal, inv, opened: 0, best: 0, bonus: 0, fav };
}
function user(id, username, role, bal, inv, banned = false, lastSeen = null) {
  return {
    id: String(id), username, username_key: username.toLowerCase(), role, banned, ban_reason: null,
    profile_json: profile(bal, inv), last_seen: lastSeen
  };
}
function result(rows = []) { return { rows, rowCount: rows.length }; }
function nonAdminById(id) {
  const row = db.users.get(Number(id));
  return row && row.role !== 'admin' ? row : null;
}
function searchUsers(sql, args) {
  const all = [...db.users.values()].filter(row => row.role !== 'admin');
  if (!sql.includes('ILIKE')) return all;
  const term = String(args[0]).replace(/^%/, '').replace(/%$/, '').toLowerCase();
  return all.filter(row => row.username.toLowerCase().includes(term) ||
    (sql.includes('OR id=$2') && Number(row.id) === Number(args[1])));
}
function isRecent(lastSeen) {
  return Boolean(lastSeen && new Date(lastSeen).getTime() > Date.now() - 90_000);
}

const pool = {
  async query(sql, args = []) {
    db.calls.push({ sql: String(sql), args: [...args] });
    const text = String(sql).replace(/\s+/g, ' ').trim();
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(text) || /^(CREATE|ALTER) /i.test(text)) return result();
    if (text.startsWith("UPDATE app_users SET role='admin'")) return result();
    if (text.startsWith('SELECT role FROM app_users WHERE id=$1')) {
      const row = db.users.get(Number(args[0]));
      return result(row ? [{ role: row.role }] : []);
    }
    if (text.startsWith('SELECT COUNT(*)::int AS total FROM app_users')) return result([{ total: searchUsers(text, args).length }]);
    if (text.startsWith('SELECT id, username, profile_json, banned, last_seen,')) {
      const rows = searchUsers(text, args).sort((a, b) => Number(b.id) - Number(a.id));
      const limit = Number(args[args.length - 2]);
      const offset = Number(args[args.length - 1]);
      return result(rows.slice(offset, offset + limit).map(row => ({
        id: row.id, username: row.username, profile_json: row.profile_json, banned: row.banned,
        last_seen: row.last_seen, online: isRecent(row.last_seen)
      })));
    }
    if (text.startsWith('SELECT id, username, profile_json, banned FROM app_users')) {
      const row = nonAdminById(args[0]);
      return result(row ? [{ id: row.id, username: row.username, profile_json: row.profile_json, banned: row.banned }] : []);
    }
    if (text.startsWith('SELECT id,username,profile_json,role,banned,ban_reason FROM app_users')) {
      const row = db.users.get(Number(args[0]));
      return result(row ? [{ ...row }] : []);
    }
    if (text.startsWith('SELECT id,username,profile_json FROM app_users')) {
      const row = nonAdminById(args[0]);
      return result(row ? [{ id: row.id, username: row.username, profile_json: row.profile_json }] : []);
    }
    if (text.startsWith('SELECT id,username FROM app_users')) {
      const row = nonAdminById(args[0]);
      return result(row ? [{ id: row.id, username: row.username }] : []);
    }
    if (text.startsWith('UPDATE app_users SET profile_json')) {
      const row = db.users.get(Number(args[1]));
      assert.ok(row, 'profile update has a valid target');
      row.profile_json = JSON.parse(args[0]);
      return result();
    }
    if (text.startsWith('UPDATE app_users SET banned=')) {
      const row = db.users.get(Number(args[2]));
      assert.ok(row, 'ban update has a valid target');
      row.banned = args[0]; row.ban_reason = args[1];
      return result();
    }
    if (text.startsWith('INSERT INTO admin_audit')) {
      db.audits.push({ adminId: args[0], admin: args[1], action: args[2], target: args[3], details: JSON.parse(args[4]) });
      return result();
    }
    // Startup statements and unrelated routes are intentionally inert in this isolated fake.
    return result();
  },
  async connect() {
    return { query: this.query.bind(this), release() {} };
  }
};

function makeApp() {
  const app = {};
  for (const method of ['get', 'post', 'put']) {
    app[method] = (routePath, ...handlers) => { routes.push({ method: method.toUpperCase(), path: routePath, handlers }); return app; };
  }
  app.disable = app.set = app.use = () => app;
  app.listen = () => ({ close() {} });
  return app;
}
function express() { return makeApp(); }
express.json = () => (_req, _res, next) => next();
express.static = () => (_req, _res, next) => next();

function localRequire(request) {
  if (request === 'express') return express;
  if (request === 'express-session') return () => (_req, _res, next) => next();
  if (request === 'connect-pg-simple') return () => function PgSession() {};
  if (request === 'pg') return { Pool: class Pool { constructor() { return pool; } } };
  if (request === 'bcryptjs') return { hash: async () => 'hash', compare: async () => false };
  if (request === 'helmet') return () => (_req, _res, next) => next();
  if (request === 'express-rate-limit') return { rateLimit: () => (_req, _res, next) => next() };
  if (request === './catalog.json') return require(path.join(ROOT, 'catalog.json'));
  if (request === './lib/case-balance') return require(path.join(ROOT, 'lib', 'case-balance'));
  if (request.startsWith('node:')) return require(request);
  throw new Error(`Unexpected module in VM: ${request}`);
}

vm.runInNewContext(source, {
  require: localRequire,
  __dirname: ROOT,
  console: { log() {}, warn() {}, error() {} },
  process: { env: { DATABASE_URL: 'postgres://local-fake' }, exit(code) { throw new Error(`unexpected exit ${code}`); } },
  setTimeout, clearTimeout
}, { filename: 'server.js' });

function findRoute(method, routePath) {
  const route = routes.find(entry => entry.method === method && entry.path === routePath);
  assert.ok(route, `route ${method} ${routePath} is registered`);
  return route;
}
async function invoke(method, routePath, { params = {}, body = {}, query = {}, session = { userId: '1', username: 'Root' } } = {}) {
  const route = findRoute(method, routePath);
  const req = { params, body, query, session };
  const res = {
    statusCode: 200, body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(bodyValue) { this.body = bodyValue; return this; }
  };
  async function run(index) {
    if (index >= route.handlers.length) return;
    let chained;
    const next = () => { chained = run(index + 1); return chained; };
    await route.handlers[index](req, res, next);
    if (chained) await chained;
  }
  await run(0);
  return res;
}
function txOrder(calls) {
  return calls.map(call => call.sql.replace(/\s+/g, ' ').trim());
}
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}
function freshData() {
  db.users.clear(); db.audits.length = 0; db.calls.length = 0;
  db.users.set(1, user(1, 'Root', 'admin', 0, []));
  db.users.set(2, user(2, 'Alice', 'player', 120, [
    { n: 'Locked AK', p: 30, r: 'b', locked: true },
    { n: 'USP', p: 40, r: 'b', locked: false },
    { n: 'AWP', p: 50, r: 'p', locked: false }
  ], false, new Date().toISOString()));
  db.users.set(3, user(3, 'Banned Bob', 'player', 50, [], true, new Date(Date.now() - 600_000).toISOString()));
  db.users.set(4, user(4, 'Offline Cara', 'player', 5, [], false, null));
  db.users.set(5, user(5, 'OtherAdmin', 'admin', 999, []));
}

(async () => {
  // Let the server startup IIFE finish before clearing its fake-schema calls.
  await new Promise(resolve => setImmediate(resolve));
  freshData();

  let response = await invoke('GET', '/api/admin/users', { query: { offset: '0', limit: '50' } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.total, 3);
  assert.equal(response.body.users.length, 3);
  assert.deepEqual(Object.keys(response.body.users[0]).sort(), ['bal', 'banned', 'id', 'items', 'lastSeen', 'online', 'username']);
  assert.equal(response.body.users.find(entry => entry.username === 'Banned Bob').banned, true, 'banned/offline players remain visible');
  assert.equal(response.body.users.find(entry => entry.username === 'Offline Cara').online, false);
  assert.ok(!response.body.users.some(entry => entry.username === 'OtherAdmin'), 'admin targets are hidden');

  response = await invoke('GET', '/api/admin/users', { query: { search: 'alice', offset: '0', limit: '50' } });
  assert.equal(response.body.total, 1);
  assert.equal(response.body.users[0].username, 'Alice');

  response = await invoke('GET', '/api/admin/users', { query: { search: '2', offset: '0', limit: '50' } });
  assert.equal(response.body.total, 1, 'numeric search finds a player whose username has no digits');
  assert.equal(response.body.users[0].id, 2);
  response = await invoke('GET', '/api/admin/users', { query: { search: '5', offset: '0', limit: '50' } });
  assert.equal(response.body.total, 0, 'numeric search does not expose administrator targets');

  response = await invoke('GET', '/api/admin/users/:id/inventory', { params: { id: '2' } });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(plain(response.body.player), { id: 2, username: 'Alice', bal: 120, banned: false });
  assert.deepEqual(plain(response.body.items.map(item => item.index)), [0, 1, 2]);
  const expectedVersion = crypto.createHash('sha256').update(JSON.stringify(db.users.get(2).profile_json.inv)).digest('hex');
  assert.equal(response.body.inventoryVersion, expectedVersion);
  const inventoryVersion = response.body.inventoryVersion;

  db.calls.length = 0;
  response = await invoke('POST', '/api/admin/users/:id/money', { params: { id: '2' }, body: { mode: 'remove', amount: 70 } });
  assert.deepEqual(plain(response.body), { ok: true, balance: 50, amount: 70 });
  assert.equal(db.users.get(2).profile_json.bal, 50);
  assert.deepEqual(db.audits.at(-1).details, { mode: 'remove', amount: 70, requestedAmount: 70, balance: 50 });
  let order = txOrder(db.calls);
  assert.ok(order.findIndex(sql => sql === 'BEGIN') < order.findIndex(sql => sql.startsWith('UPDATE app_users SET profile_json=')));
  assert.ok(order.findIndex(sql => sql.startsWith('INSERT INTO admin_audit')) < order.findIndex(sql => sql === 'COMMIT'), 'audit commits with the profile mutation');

  response = await invoke('POST', '/api/admin/users/:id/money', { params: { id: '2' }, body: { mode: 'remove', amount: 51 } });
  assert.equal(response.statusCode, 400);
  assert.equal(db.users.get(2).profile_json.bal, 50, 'insufficient removal cannot create a negative balance');

  response = await invoke('POST', '/api/admin/users/:id/skins/remove', { params: { id: '2' }, body: { indices: [0], inventoryVersion: '0'.repeat(64) } });
  assert.equal(response.statusCode, 409, 'stale inventory snapshots are rejected under the lock');
  assert.equal(db.users.get(2).profile_json.inv.length, 3);

  // Restore Alice's balance to make the resulting removal response easy to inspect.
  db.users.get(2).profile_json.bal = 120;
  response = await invoke('POST', '/api/admin/users/:id/skins/remove', { params: { id: '2' }, body: { indices: [0, 2], inventoryVersion } });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(plain(response.body.removed), [
    { n: 'Locked AK', p: 30, r: 'b', locked: true },
    { n: 'AWP', p: 50, r: 'p', locked: false }
  ], 'locked items can be confiscated and selected indexes are removed without shifting');
  assert.equal(response.body.balance, 120, 'confiscation does not credit the player');
  assert.equal(response.body.items, 1);
  assert.deepEqual(db.audits.at(-1).details.removed, plain(response.body.removed));

  // Simulate a server-side concurrent balance/inventory update; state may change favourites only.
  db.users.get(2).profile_json.bal = 777;
  db.users.get(2).profile_json.inv.push({ n: 'Server-only', p: 99, r: 'b', locked: false });
  response = await invoke('PUT', '/api/state', {
    body: { fav: ['Server-only'], bal: 0, inv: [] },
    session: { userId: '2', username: 'Alice' }
  });
  assert.equal(response.statusCode, 200);
  assert.equal(db.users.get(2).profile_json.bal, 777);
  assert.equal(db.users.get(2).profile_json.inv.length, 2);
  assert.deepEqual(db.users.get(2).profile_json.fav, ['Server-only']);

  response = await invoke('GET', '/api/admin/users/:id/inventory', { params: { id: '5' } });
  assert.equal(response.statusCode, 404, 'administrator targets are protected');
  response = await invoke('POST', '/api/admin/users/:id/money', { params: { id: 'not-an-id' }, body: { amount: 1 } });
  assert.equal(response.statusCode, 400, 'bad path ids fail cleanly rather than reaching PostgreSQL');

  db.users.get(4).profile_json.inv = Array.from({ length: 5000 }, (_unused, index) => ({ n: `Item ${index}`, p: 1, r: 'c', locked: false }));
  db.calls.length = 0;
  response = await invoke('POST', '/api/admin/users/:id/skin', { params: { id: '4' }, body: { name: 'Over limit', price: 10 } });
  assert.equal(response.statusCode, 400);
  assert.equal(db.users.get(4).profile_json.inv.length, 5000, 'skin grants cannot exceed the inventory cap');
  assert.ok(txOrder(db.calls).some(sql => sql.includes('FOR UPDATE')), 'skin grant reads the target profile under a row lock');
  assert.ok(!txOrder(db.calls).some(sql => sql.startsWith('INSERT INTO admin_audit')), 'rejected grants do not create an audit event');

  response = await invoke('GET', '/api/admin/users', { session: {} });
  assert.equal(response.statusCode, 401, 'anonymous callers cannot inspect players');
  response = await invoke('GET', '/api/admin/users/:id/inventory', { params: { id: '4' }, session: { userId: '2' } });
  assert.equal(response.statusCode, 403, 'players cannot inspect private inventories');
  response = await invoke('POST', '/api/admin/users/:id/money', { params: { id: '4' }, body: { mode: 'remove', amount: 1 }, session: { userId: '2' } });
  assert.equal(response.statusCode, 403, 'players cannot use confiscation endpoints');

  const catalog = require('../catalog.json');
  const expensiveCase = catalog.CASES.find(c => c.id === 37);
  const distribution = require('../lib/case-balance').getCaseDistribution(expensiveCase);
  const rolls = [0.01, 0.15, 0.3, 0.5, 0.65, 0.8, 0.91, 0.96, 0.99, 0.999];
  const expected = rolls.map(roll => distribution.items[distribution.cumulativeWeights.findIndex(total => roll < total)]);
  const originalRandom = Math.random;
  try {
    db.users.get(2).profile_json = profile(100000, []);
    let draws = 0;
    Math.random = () => rolls[draws++];
    response = await invoke('POST', '/api/open-case', { body: { caseId: 37, count: 10 }, session: { userId: '2', username: 'Alice' } });
    assert.equal(response.statusCode, 200);
    assert.equal(draws, 10, 'batch performs exactly ten independent draws');
    assert.deepEqual(plain(response.body.wins), plain(expected), 'API uses calibrated distribution, not legacy rarity weights');
    assert.equal(response.body.user.bal, 100000 - expensiveCase.price * 10);
    assert.equal(response.body.user.opened, 10);
    assert.equal(response.body.user.inv.length, 10);

    db.users.get(2).profile_json = profile(100000, []);
    draws = 0;
    response = await invoke('POST', '/api/open-case', { body: { caseId: 37, count: 1 }, session: { userId: '2', username: 'Alice' } });
    assert.equal(draws, 1);
    assert.deepEqual(plain(response.body.wins[0]), plain(expected[0]), 'single and batch use identical odds');
  } finally { Math.random = originalRandom; }

  console.log('Admin/state/open-case VM tests passed');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
