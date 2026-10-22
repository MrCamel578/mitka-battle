'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Проверяем настоящий admin.js без браузера, сети и дополнительных зависимостей.
const elements = new Map();
function element(id) {
  if (!elements.has(id)) elements.set(id, { innerHTML: '', textContent: '', value: '', disabled: false, addEventListener() {} });
  return elements.get(id);
}
const pendingAudits = [];
const context = {
  user: { id: 1, role: 'admin' }, page: 'admin', $: element,
  escapeHtml: value => String(value), money: value => String(value),
  toast() {}, go() {}, skinCard() { return ''; },
  document: { querySelectorAll() { return []; } },
  api(url) {
    if (url === '/api/admin/audit') return new Promise(resolve => pendingAudits.push(resolve));
    if (url.startsWith('/api/admin/users?')) return Promise.resolve({ users: [], total: 0 });
    throw new Error(`Unexpected endpoint ${url}`);
  }
};
context.setUser = next => { context.user = next; };
context.window = context;
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'admin.js'), 'utf8'), context);
function log(action) { return { action, admin: 'Admin', target: 'Alice', createdAt: '2026-10-22T12:00:00Z' }; }
(async () => {
  const firstRender = context.renderAdmin();
  const refresh = context.adminRefresh();
  assert.equal(pendingAudits.length, 2);
  pendingAudits[1]({ logs: [log('NEW_TRANSACTION')] });
  await refresh;
  assert.match(element('adminAudit').innerHTML, /NEW_TRANSACTION/);
  pendingAudits[0]({ logs: [log('OLD_SNAPSHOT')] });
  await firstRender;
  assert.match(element('adminAudit').innerHTML, /NEW_TRANSACTION/, 'late response cannot replace the current audit log');
  assert.doesNotMatch(element('adminAudit').innerHTML, /OLD_SNAPSHOT/);
  console.log('Admin UI stale-response test passed');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
