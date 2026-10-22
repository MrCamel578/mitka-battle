'use strict';

(function () {
  const state = { search: '', status: 'all', offset: 0, limit: 50, total: 0, playerId: null, inventory: null, selected: new Set(), busy: false, listRequest: 0, inventoryRequest: 0, auditRequest: 0, auditSearch: '', auditLogs: [] };
  const visible = () => page === 'admin' && user?.role === 'admin' && !!$('adminPlayers');
  const esc = value => escapeHtml(String(value ?? ''));
  const validId = value => Number.isSafeInteger(Number(value)) && Number(value) > 0;

  async function renderAdmin() {
    if (!user || user.role !== 'admin') { toast('Нет доступа к админ-панели', 'error'); return go('cases'); }
    $('app').innerHTML = `
      <div class="sectionhead"><div><h2>Админ-панель</h2><div class="subtext">Игроки онлайн и офлайн. Все изменения записываются в журнал.</div></div><button onclick="adminRefresh()">Обновить</button></div>
      <div class="layout2 admin-layout">
        <section class="panel"><h3>Игроки</h3><form id="adminSearchForm" class="toolbar admin-search"><input id="adminSearch" class="field" placeholder="Поиск по логину или ID" maxlength="80" value="${esc(state.search)}"><select id="adminStatus" class="field admin-status-filter" aria-label="Статус игроков"><option value="all"${state.status === 'all' ? ' selected' : ''}>Все статусы</option><option value="online"${state.status === 'online' ? ' selected' : ''}>Только онлайн</option><option value="banned"${state.status === 'banned' ? ' selected' : ''}>Только в бане</option></select><button type="submit">Найти</button></form><p class="subtext admin-filter-hint">Онлайн — активность в последние 90 секунд. Заблокированные аккаунты показываются отдельно.</p><div id="adminPlayers" class="subtext">Загрузка игроков…</div><div class="toolbar admin-pagination"><button id="adminPrev" onclick="adminChangePage(-1)">Назад</button><span id="adminPageInfo" class="subtext"></span><button id="adminNext" onclick="adminChangePage(1)">Далее</button></div></section>
        <section class="panel"><h3>Управление игроком</h3><p class="subtext">Выбери игрока слева или введи его ID. Администраторские аккаунты защищены.</p><div class="toolbar"><input id="adminTargetId" class="field" placeholder="ID игрока" type="number" min="1" step="1" value="${state.playerId || ''}"><button onclick="adminOpenInventory()">Посмотреть инвентарь</button></div><div id="adminSelectedPlayer" class="admin-player-label subtext"></div><div id="adminPlayerDetails" class="admin-player-details" aria-live="polite"></div>
          <h3 class="admin-section-title">Баланс</h3><div class="toolbar"><input id="adminMoneyAmount" class="field" placeholder="Сумма ₽" type="number" min="0.01" max="1000000000" step="0.01"><button class="primary admin-mutation" onclick="adminGiveMoney()">Выдать</button><button class="danger admin-mutation" onclick="adminTakeMoney()">Забрать</button></div><p class="subtext">Списывается указанная сумма, без ухода в минус.</p>
          <h3 class="admin-section-title">Выдать скин</h3><div class="toolbar"><input id="adminSkinName" class="field" placeholder="Название скина" maxlength="180"><input id="adminSkinPrice" class="field" placeholder="Цена ₽" type="number" min="0" step="0.01"><button class="primary admin-mutation" onclick="adminGiveSkin()">Выдать скин</button></div>
          <div id="adminBanControls" class="toolbar admin-section-title"></div>
        </section>
      </div>
      <section class="panel admin-section-title"><div class="sectionhead admin-inventory-head"><div><h3>Инвентарь игрока</h3><div id="adminInventoryInfo" class="subtext">Выбери игрока, чтобы посмотреть предметы.</div></div><div class="toolbar"><button onclick="adminSelectAllSkins()">Выбрать все</button><button onclick="adminClearSkins()">Сбросить</button><button id="adminRemoveSkins" class="danger admin-mutation" onclick="adminTakeSkins()" disabled>Забрать выбранные</button></div></div><div id="adminInventory" class="admin-inventory"><div class="empty">Инвентарь ещё не выбран.</div></div></section>
      <section class="panel admin-section-title"><div class="sectionhead admin-audit-head"><div><h3>Журнал действий</h3><div id="adminAuditCount" class="subtext"></div></div><form id="adminAuditFilter" class="toolbar"><input id="adminAuditSearch" class="field" placeholder="Фильтр по действию или игроку" maxlength="80" value="${esc(state.auditSearch)}"></form></div><div id="adminAudit" class="subtext">Загрузка журнала…</div></section>`;
    $('adminSearchForm').addEventListener('submit', event => { event.preventDefault(); state.search = $('adminSearch').value.trim(); state.status = $('adminStatus').value; state.offset = 0; loadPlayers(); });
    $('adminStatus').addEventListener('change', () => { state.status = $('adminStatus').value; state.offset = 0; loadPlayers(); });
    $('adminAuditFilter').addEventListener('input', () => { state.auditSearch = $('adminAuditSearch').value.slice(0, 80); renderAudit(); });
    setBusy(state.busy);
    await Promise.all([loadPlayers(), loadAudit(), state.playerId ? loadInventory(state.playerId) : Promise.resolve()]);
  }

  async function loadPlayers() {
    const request = ++state.listRequest;
    try {
      const data = await api(`/api/admin/users?search=${encodeURIComponent(state.search)}&status=${encodeURIComponent(state.status)}&offset=${state.offset}&limit=${state.limit}`);
      if (!visible() || request !== state.listRequest) return;
      state.total = data.total;
      if (state.offset >= state.total && state.offset > 0) { state.offset = Math.max(0, Math.floor(Math.max(0, state.total - 1) / state.limit) * state.limit); return loadPlayers(); }
      $('adminPlayers').innerHTML = data.users.length ? `<div class="admin-table-scroll"><table class="admin-table"><thead><tr><th>ID / Игрок</th><th>Баланс</th><th>Скины</th><th></th></tr></thead><tbody>${data.users.map(player => `<tr class="${Number(player.id) === state.playerId ? 'admin-active-row' : ''}"><td><strong>${esc(player.username)}</strong><small>#${Number(player.id)} · ${playerStatus(player)}</small></td><td>${money(player.bal)} ₽</td><td>${Number(player.items)}</td><td><button class="small" onclick="adminFill(${Number(player.id)})">Инвентарь</button></td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">Игроки не найдены.</div>';
      $('adminPageInfo').textContent = state.total ? `${state.offset + 1}–${Math.min(state.offset + state.limit, state.total)} из ${state.total}` : '0 игроков';
      $('adminPrev').disabled = state.offset === 0;
      $('adminNext').disabled = state.offset + state.limit >= state.total;
    } catch (error) { if (visible() && request === state.listRequest) $('adminPlayers').innerHTML = `<div class="empty">${esc(error.message)}</div>`; }
  }

  function playerStatus(player) {
    if (player.banned) return '<span class="admin-status admin-status-banned">Забанен</span>';
    return player.online ? '<span class="admin-status admin-status-online">Онлайн</span>' : '<span class="admin-status">Офлайн</span>';
  }
  function formatDate(value) {
    if (!value) return '—';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('ru-RU');
  }
  function renderPlayerDetails(player) {
    const stats = player.stats || {};
    const ban = player.banned ? `<div class="admin-detail-wide admin-ban-reason"><b>Причина бана:</b> ${esc(player.banReason || 'не указана')}</div>` : '';
    $('adminPlayerDetails').innerHTML = `<dl class="admin-detail-grid"><div><dt>Статус</dt><dd>${playerStatus(player)}</dd></div><div><dt>Последняя активность</dt><dd>${esc(formatDate(player.lastSeen))}</dd></div><div><dt>Регистрация</dt><dd>${esc(formatDate(player.createdAt))}</dd></div><div><dt>Открыто кейсов</dt><dd>${Number(stats.opened || 0)}</dd></div><div><dt>Лучший предмет</dt><dd>${money(stats.best)} ₽</dd></div><div><dt>Заблокировано скинов</dt><dd>${Number(stats.lockedItems || 0)}</dd></div><div><dt>Последний бонус</dt><dd>${esc(formatDate(stats.bonusAt))}</dd></div>${ban}</dl>`;
  }
  async function loadInventory(id) {
    if (!validId(id)) return toast('Укажи корректный ID игрока', 'error');
    id = Number(id);
    const request = ++state.inventoryRequest;
    state.playerId = id; state.inventory = null; state.selected.clear();
    if (!visible()) return;
    $('adminTargetId').value = id;
    $('adminSelectedPlayer').textContent = `Игрок #${id}: загрузка…`;
    $('adminPlayerDetails').innerHTML = '';
    $('adminBanControls').innerHTML = '';
    $('adminInventory').innerHTML = '<div class="empty">Загрузка инвентаря…</div>';
    updateSelection();
    try {
      const data = await api(`/api/admin/users/${id}/inventory`);
      if (!visible() || request !== state.inventoryRequest) return;
      state.inventory = data;
      const player = data.player;
      $('adminSelectedPlayer').textContent = `${player.username} · #${player.id} · Баланс: ${money(player.bal)} ₽`;
      renderPlayerDetails(player);
      $('adminBanControls').innerHTML = `<button class="admin-mutation ${player.banned ? '' : 'danger'}" onclick="adminBan(${Number(player.id)},${!player.banned})">${player.banned ? 'Разбанить' : 'Забанить'} игрока</button>`;
      const total = data.items.reduce((sum, item) => sum + Number(item.p), 0);
      $('adminInventoryInfo').textContent = `${player.username} · ${data.items.length} предметов · Общая стоимость: ${money(total)} ₽. Замок не препятствует изъятию администратором.`;
      $('adminInventory').innerHTML = data.items.length ? `<div class="skin-grid">${data.items.map(item => `<label class="admin-skin" data-index="${item.index}"><input type="checkbox" class="admin-skin-checkbox" value="${item.index}" onchange="adminToggleSkin(${item.index},this.checked)"><span class="admin-skin-choice">#${item.index + 1}${item.locked ? ' · Заблокирован' : ''}</span>${skinCard(item, -1, false)}</label>`).join('')}</div>` : '<div class="empty">Инвентарь игрока пуст.</div>';
      setBusy(state.busy);
    } catch (error) {
      if (!visible() || request !== state.inventoryRequest) return;
      $('adminSelectedPlayer').textContent = `Игрок #${id}`;
      $('adminPlayerDetails').innerHTML = '';
      $('adminInventoryInfo').textContent = 'Не удалось загрузить инвентарь.';
      $('adminInventory').innerHTML = `<div class="empty">${esc(error.message)}</div>`;
      toast(error.message, 'error');
    }
  }

  async function loadAudit() {
    const request = ++state.auditRequest;
    try {
      const data = await api('/api/admin/audit');
      if (!visible() || request !== state.auditRequest) return;
      state.auditLogs = Array.isArray(data.logs) ? data.logs : [];
      renderAudit();
    } catch (error) { if (visible() && request === state.auditRequest) $('adminAudit').innerHTML = `<div class="empty">${esc(error.message)}</div>`; }
  }
  function renderAudit() {
    if (!visible()) return;
    const needle = state.auditSearch.trim().toLocaleLowerCase('ru');
    const logs = state.auditLogs.filter(log => !needle || [log.admin, log.action, log.target, auditDetails(log.details)].join(' ').toLocaleLowerCase('ru').includes(needle));
    $('adminAuditCount').textContent = state.auditLogs.length ? `Показано ${logs.length} из последних ${state.auditLogs.length} записей` : '';
    $('adminAudit').innerHTML = logs.length ? `<div class="admin-table-scroll"><table class="admin-table"><thead><tr><th>Время</th><th>Админ</th><th>Действие / детали</th><th>Игрок</th></tr></thead><tbody>${logs.map(log => `<tr><td>${esc(formatDate(log.createdAt))}</td><td>${esc(log.admin)}</td><td>${esc(log.action)}<small>${esc(auditDetails(log.details))}</small></td><td>${esc(log.target || '—')}</td></tr>`).join('')}</tbody></table></div>` : `<div class="empty">${state.auditLogs.length ? 'По этому фильтру записей нет.' : 'Действий пока нет.'}</div>`;
  }

  function auditDetails(details) {
    if (!details) return '';
    if (details.amount != null) return `${money(details.amount)} ₽`;
    if (details.removed) return details.removed.map(item => item.n).join(', ');
    if (details.items) return details.items.map(item => item.n).join(', ');
    if (details.n) return `${details.n} · ${money(details.p)} ₽`;
    return details.reason || '';
  }
  function updateSelection() {
    if (!visible()) return;
    const button = $('adminRemoveSkins');
    button.textContent = state.selected.size ? `Забрать выбранные (${state.selected.size})` : 'Забрать выбранные';
    button.disabled = state.busy || !state.inventory || !state.selected.size;
  }
  function setBusy(value) {
    state.busy = value;
    if (!visible()) return;
    document.querySelectorAll('.admin-mutation,.admin-skin-checkbox').forEach(element => { element.disabled = value; });
    updateSelection();
  }
  function targetId() {
    const value = $('adminTargetId')?.value;
    if (!validId(value)) { toast('Укажи корректный ID игрока', 'error'); return null; }
    return Number(value);
  }
  async function mutate(id, path, body, message) {
    if (state.busy || !visible()) return;
    setBusy(true);
    try {
      await api(`/api/admin/users/${id}/${path}`, { method: 'POST', body: JSON.stringify(body) });
      toast(message, 'good');
      if (visible()) await Promise.all([loadPlayers(), loadInventory(id), loadAudit()]);
    } catch (error) {
      toast(error.message, 'error');
      // После конфликта нельзя повторять изъятие со старыми индексами.
      if (visible() && path === 'skins/remove') await loadInventory(id);
    } finally { setBusy(false); }
  }
  async function changeMoney(mode) {
    const id = targetId(); if (!id || state.busy) return;
    const amount = Number($('adminMoneyAmount').value);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1e9) return toast('Введи положительную сумму до 1 000 000 000 ₽', 'error');
    const question = mode === 'remove' ? `Забрать ${money(amount)} ₽ у игрока #${id}?` : `Выдать ${money(amount)} ₽ игроку #${id}?`;
    if (!confirm(question)) return;
    await mutate(id, 'money', { amount, mode }, mode === 'remove' ? 'Деньги списаны' : 'Баланс выдан');
  }
  function adminToggleSkin(index, checked) {
    if (state.busy || !state.inventory) return;
    if (checked) state.selected.add(index); else state.selected.delete(index);
    document.querySelector(`.admin-skin[data-index="${index}"]`)?.classList.toggle('admin-skin-selected', checked);
    updateSelection();
  }
  function selectSkins(all) {
    if (state.busy || !state.inventory || !visible()) return;
    state.selected.clear();
    if (all) state.inventory.items.forEach(item => state.selected.add(item.index));
    document.querySelectorAll('.admin-skin-checkbox').forEach(input => { input.checked = all; input.closest('.admin-skin').classList.toggle('admin-skin-selected', all); });
    updateSelection();
  }
  async function adminTakeSkins() {
    if (state.busy || !state.inventory || !state.selected.size) return;
    const id = Number(state.inventory.player.id);
    const indices = [...state.selected];
    const total = state.inventory.items.filter(item => state.selected.has(item.index)).reduce((sum, item) => sum + Number(item.p), 0);
    if (!confirm(`Забрать ${indices.length} скин(ов) у ${state.inventory.player.username} (#${id}) общей стоимостью ${money(total)} ₽?\nПредметы будут удалены без начисления денег игроку.`)) return;
    await mutate(id, 'skins/remove', { indices, inventoryVersion: state.inventory.inventoryVersion }, 'Выбранные скины изъяты');
  }
  async function adminGiveSkin() {
    const id = targetId(); if (!id || state.busy) return;
    const name = $('adminSkinName').value.trim(), rawPrice = $('adminSkinPrice').value, price = Number(rawPrice);
    if (!name || rawPrice === '' || !Number.isFinite(price) || price < 0 || price > 1e12) return toast('Укажи название и корректную стоимость скина', 'error');
    if (!confirm(`Выдать скин «${name}» стоимостью ${money(price)} ₽ игроку #${id}?`)) return;
    await mutate(id, 'skin', { name, price }, 'Скин выдан');
  }
  async function adminBan(id, banned) {
    if (state.busy) return;
    const reason = banned ? prompt('Причина бана (необязательно):') : '';
    if (reason === null) return;
    if (banned && !confirm(`Забанить игрока #${id}?${reason ? `\nПричина: ${reason.trim()}` : '\nПричина не указана.'}`)) return;
    if (!banned && !confirm(`Разбанить игрока #${id}?`)) return;
    await mutate(Number(id), 'ban', { banned, reason }, banned ? 'Игрок заблокирован' : 'Игрок разблокирован');
  }
  Object.assign(window, {
    renderAdmin, adminGiveSkin, adminBan, adminTakeSkins, adminToggleSkin,
    adminGiveMoney: () => changeMoney('add'), adminTakeMoney: () => changeMoney('remove'),
    adminFill: id => { if (!state.busy) loadInventory(id); },
    adminOpenInventory: () => { const id = targetId(); if (id && !state.busy) loadInventory(id); },
    adminSelectAllSkins: () => selectSkins(true), adminClearSkins: () => selectSkins(false),
    adminChangePage: direction => { state.offset = Math.max(0, state.offset + direction * state.limit); loadPlayers(); },
    adminRefresh: () => { if (!state.busy && visible()) return Promise.all([loadPlayers(), loadAudit(), state.playerId ? loadInventory(state.playerId) : Promise.resolve()]); }
  });
  const originalSetUser = setUser;
  setUser = function (nextUser) {
    const previousId = user?.id;
    originalSetUser(nextUser);
    if (previousId !== nextUser?.id || nextUser?.role !== 'admin') {
      state.playerId = null; state.inventory = null; state.selected.clear(); state.search = ''; state.status = 'all'; state.offset = 0; state.auditSearch = ''; state.auditLogs = [];
      state.listRequest++; state.inventoryRequest++; state.auditRequest++;
    }
  };
})();
