/* Модуль апгрейдера. Подключается classic script после inline core и до init(). */
'use strict';

const UPGRADE_PAGE_SIZE = 24;
const upgradeView = {
  inventoryQuery: '',
  inventorySort: 'selected',
  inventoryPrice: 'all',
  inventoryVisible: UPGRADE_PAGE_SIZE,
  targetQuery: '',
  targetSort: 'price-asc',
  targetPrice: 'all',
  targetVisible: UPGRADE_PAGE_SIZE,
  targetInvalidated: false,
  result: null,
  operationPending: false
};

function upgradeSetInteractionLock(value) {
  /* interactionLocked добавляется основным скриптом. typeof безопасен до его объявления. */
  if (typeof interactionLocked !== 'undefined') interactionLocked = value;
}

function upgradeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function upgradePriceMatches(price, range) {
  const value = upgradeNumber(price);
  if (range === 'under-100') return value < 100;
  if (range === '100-500') return value >= 100 && value < 500;
  if (range === '500-2000') return value >= 500 && value < 2000;
  if (range === 'over-2000') return value >= 2000;
  return true;
}

function upgradeSort(items, sort, selected) {
  return items.slice().sort((a, b) => {
    if (sort === 'selected') {
      const selectedDiff = Number(selected.has(b.index)) - Number(selected.has(a.index));
      if (selectedDiff) return selectedDiff;
    }
    if (sort === 'price-desc') return upgradeNumber(b.skin.p) - upgradeNumber(a.skin.p) || a.index - b.index;
    if (sort === 'name') return String(a.skin.n).localeCompare(String(b.skin.n), 'ru') || a.index - b.index;
    return upgradeNumber(a.skin.p) - upgradeNumber(b.skin.p) || a.index - b.index;
  });
}

function upgradeSelectedIndices() {
  const inventory = user?.inv || [];
  const valid = [...selectedUpgrade].filter(index => {
    const skin = inventory[index];
    return Number.isInteger(index) && skin && !skin.locked && upgradeNumber(skin.p) > 0;
  });
  const capped = valid.slice(0, 500);
  selectedUpgrade = new Set(capped);
  return capped;
}

function upgradeStake() {
  const inventory = user?.inv || [];
  const indices = upgradeSelectedIndices();
  return indices.reduce((sum, index) => sum + upgradeNumber(inventory[index]?.p), 0);
}

function upgradeCatalogTarget(index) {
  const raw = CATALOG?.SK?.[index];
  if (!raw) return null;
  const price = upgradeNumber(raw[1]);
  if (price <= 0) return null;
  return { i: index, n: raw[0], p: price, r: raw[2] };
}

/* Та же формула, что в server.js: min(90, stake / target.price * 95). */
function upgradeChance(stake, targetPrice) {
  if (!(upgradeNumber(stake) > 0) || !(upgradeNumber(targetPrice) > 0)) return 0;
  return Math.min(90, upgradeNumber(stake) / upgradeNumber(targetPrice) * 95);
}

function sanitizeUpgradeState() {
  const stake = upgradeStake();
  const currentTarget = upgradeTarget && upgradeCatalogTarget(upgradeTarget.i);
  if (currentTarget && currentTarget.p <= stake) {
    upgradeTarget = null;
    upgradeView.targetInvalidated = true;
  } else if (currentTarget) {
    upgradeTarget = currentTarget;
  }
  return stake;
}

function upgradeInventoryItems() {
  const query = upgradeView.inventoryQuery.trim().toLocaleLowerCase('ru');
  return (user?.inv || [])
    .map((skin, index) => ({ skin, index }))
    .filter(({ skin }) => String(skin.n || '').toLocaleLowerCase('ru').includes(query))
    .filter(({ skin }) => upgradePriceMatches(skin.p, upgradeView.inventoryPrice));
}

function upgradeTargetItems(stake) {
  const query = upgradeView.targetQuery.trim().toLocaleLowerCase('ru');
  return (CATALOG?.SK || [])
    .map((raw, index) => ({ skin: { n: raw[0], p: upgradeNumber(raw[1]), r: raw[2] }, index }))
    .filter(({ skin }) => skin.p > stake)
    .filter(({ skin }) => String(skin.n || '').toLocaleLowerCase('ru').includes(query))
    .filter(({ skin }) => upgradePriceMatches(skin.p, upgradeView.targetPrice));
}

function upgradeInventoryCard(skin, index, selected) {
  const rarity = RARITY[skin.r] || RARITY.c;
  const locked = !!skin.locked;
  const selectable = !locked && upgradeNumber(skin.p) > 0;
  const stateLabel = locked ? 'Защищён' : selected ? 'Убрать' : selectable ? 'В ставку' : 'Недоступен';
  const controlsDisabled = upgradeView.operationPending;
  return `<article class="upgrade-own-card ${selected ? 'selected' : ''} ${locked ? 'locked' : ''} ${selectable ? '' : 'is-disabled'}" style="--rarity:${rarity.color};--rarityGlow:${rarity.color}22" ${selectable ? `onclick="selectUpgradeSkin(${index})"` : ''}>
    <div class="upgrade-card-image">${imgMarkup(skin.n)}</div>
    <button class="upgrade-lock-control ${locked ? 'islocked' : ''}" type="button" title="${locked ? 'Разблокировать скин' : 'Заблокировать скин'}" onclick="event.stopPropagation();toggleLock(${index})" ${controlsDisabled ? 'disabled' : ''}>${locked ? '🔒' : '♙'}</button>
    <div class="upgrade-card-body">
      <div class="skinname">${escapeHtml(skin.n)}</div>
      <div class="skinbottom"><span class="raritylabel">${rarity.name}</span><b class="price">${money(skin.p)} ₽</b></div>
      <button class="upgrade-pick-control ${selected ? 'is-selected' : ''}" type="button" onclick="event.stopPropagation();selectUpgradeSkin(${index})" ${!selectable || controlsDisabled ? 'disabled' : ''}>${stateLabel}</button>
    </div>
  </article>`;
}

function targetCard(target) {
  const rarity = RARITY[target.r] || RARITY.c;
  const selected = upgradeTarget && upgradeTarget.i === target.i;
  return `<article class="upgrade-target-card ${selected ? 'selected' : ''}" style="--rarity:${rarity.color};--rarityGlow:${rarity.color}22" onclick="chooseTarget(${target.i})">
    <div class="upgrade-card-image">${imgMarkup(target.n)}</div>
    <div class="upgrade-card-body">
      <div class="skinname">${escapeHtml(target.n)}</div>
      <div class="skinbottom"><span class="raritylabel">${rarity.name}</span><b class="price">${money(target.p)} ₽</b></div>
    </div>
  </article>`;
}

function upgradeMiniSkin(skin, extraClass = '') {
  return `<div class="upgrade-mini-skin ${extraClass}" title="${escapeHtml(skin.n)}">${imgMarkup(skin.n)}</div>`;
}

function upgradeStakePreview(indices) {
  const skins = indices.map(index => user.inv[index]).filter(Boolean);
  if (!skins.length) return '<div class="upgrade-preview-empty">Добавь от 1 до 500 незаблокированных скинов</div>';
  const shown = skins.slice(0, 5).map(skin => upgradeMiniSkin(skin)).join('');
  const rest = skins.length - 5;
  return `<div class="upgrade-mini-list">${shown}${rest > 0 ? `<span class="upgrade-mini-more">+${rest}</span>` : ''}</div>`;
}

function upgradeTargetPreview(target) {
  return target
    ? `<div class="upgrade-target-preview">${upgradeMiniSkin(target, 'target')}<span>${escapeHtml(target.n)}</span></div>`
    : '<div class="upgrade-preview-empty">Выбери предмет из каталога</div>';
}

function upgradeResultMarkup(result) {
  if (!result) return '<div id="upgradeResult" class="upgrade-result-slot" aria-live="polite"></div>';
  const target = result.target || {};
  if (result.win) {
    const item = result.item || target;
    return `<div id="upgradeResult" class="upgrade-result success" aria-live="polite">
      <strong>Апгрейд успешен</strong>
      <div class="upgrade-result-item">${imgMarkup(item.n)}<span><b>${escapeHtml(item.n)}</b><em>${money(item.p)} ₽</em></span></div>
      <button type="button" class="small" onclick="startNewUpgradeAttempt()">Новая попытка</button>
    </div>`;
  }
  return `<div id="upgradeResult" class="upgrade-result failure" aria-live="polite">
    <strong>Не повезло</strong>
    <span>Ставка сгорела. Цель: <b>${escapeHtml(target.n || '—')}</b> · ${money(target.p)} ₽</span>
    <small>Шанс был ${upgradeNumber(result.chance).toFixed(2)}%</small>
    <button type="button" class="small" onclick="startNewUpgradeAttempt()">Новая попытка</button>
  </div>`;
}

function renderUpgradeInventoryList() {
  const grid = $('upgradeInventory');
  if (!grid) return;
  const filtered = upgradeSort(upgradeInventoryItems(), upgradeView.inventorySort, selectedUpgrade);
  const visible = filtered.slice(0, upgradeView.inventoryVisible);
  grid.innerHTML = visible.map(({ skin, index }) => upgradeInventoryCard(skin, index, selectedUpgrade.has(index))).join('') || '<div class="empty upgrade-empty">Нет скинов по этому фильтру.</div>';
  const count = $('upgradeInventoryCount');
  if (count) count.textContent = `Показано ${visible.length} из ${filtered.length}`;
  const more = $('upgradeInventoryMore');
  if (more) {
    const remaining = Math.max(0, filtered.length - visible.length);
    more.hidden = !remaining;
    more.textContent = `Показать ещё (${remaining})`;
  }
}

function renderUpgradeTargetList() {
  const grid = $('targetGrid');
  if (!grid) return;
  const stake = upgradeStake();
  const filtered = upgradeSort(upgradeTargetItems(stake), upgradeView.targetSort, new Set());
  const visible = filtered.slice(0, upgradeView.targetVisible);
  grid.innerHTML = visible.map(({ skin, index }) => targetCard({ ...skin, i: index })).join('') || '<div class="empty upgrade-empty">Нет более дорогих целей по этому фильтру.</div>';
  const count = $('upgradeTargetCount');
  if (count) count.textContent = `${filtered.length} ${upgradeRussianTargets(filtered.length)}`;
  const more = $('upgradeTargetMore');
  if (more) {
    const remaining = Math.max(0, filtered.length - visible.length);
    more.hidden = !remaining;
    more.textContent = `Показать ещё (${remaining})`;
  }
}

function upgradeRussianTargets(number) {
  const lastTwo = number % 100;
  const last = number % 10;
  if (lastTwo >= 11 && lastTwo <= 19) return 'целей';
  if (last === 1) return 'цель';
  if (last >= 2 && last <= 4) return 'цели';
  return 'целей';
}

function renderUpgrade() {
  if (!requireUser()) return;
  const stake = sanitizeUpgradeState();
  const indices = upgradeSelectedIndices();
  const target = upgradeTarget && upgradeCatalogTarget(upgradeTarget.i);
  const settled = upgradeView.result && !indices.length && !target;
  const chance = settled ? upgradeNumber(upgradeView.result.chance) : target ? upgradeChance(stake, target.p) : 0;
  const pointerAngle = settled ? upgradeNumber(upgradeView.result.angle) % 360 : 0;
  const outcomeClass = settled ? (upgradeView.result.win ? ' win' : ' lose') : '';
  const disabled = upgradeView.operationPending ? 'disabled' : '';
  $('app').innerHTML = `<section id="upgradeRoot" class="upgrade-root" aria-busy="${busy ? 'true' : 'false'}">
    <div class="sectionhead upgrade-heading">
      <div><h2>Апгрейд</h2><div class="subtext">Собери ставку, выбери более дорогую цель и испытай удачу. Результат определяет сервер.</div></div>
      <div class="upgrade-heading-stats"><span class="pill">${indices.length} / 500 в ставке</span><span class="pill">Ставка: ${money(stake)} ₽</span></div>
    </div>
    <div class="upgrade-layout upgrade-layout-v2">
      <section class="panel upgrade-side upgrade-side-inventory">
        <div class="upgrade-panel-title"><div><h3>Твои скины</h3><div id="upgradeInventoryCount" class="subtext"></div></div><span class="pill">${indices.length}/500</span></div>
        <div class="upgrade-filters">
          <input id="upgradeInvSearch" class="field" value="${escapeHtml(upgradeView.inventoryQuery)}" placeholder="Поиск в инвентаре…" oninput="filterUpgradeInventory()" ${disabled}>
          <select id="upgradeInvSort" class="field upgrade-select" onchange="filterUpgradeInventory()" ${disabled}>
            <option value="selected" ${upgradeView.inventorySort === 'selected' ? 'selected' : ''}>Сначала выбранные</option><option value="price-asc" ${upgradeView.inventorySort === 'price-asc' ? 'selected' : ''}>Цена: по возрастанию</option><option value="price-desc" ${upgradeView.inventorySort === 'price-desc' ? 'selected' : ''}>Цена: по убыванию</option><option value="name" ${upgradeView.inventorySort === 'name' ? 'selected' : ''}>По названию</option>
          </select>
          <select id="upgradeInvPrice" class="field upgrade-select" onchange="filterUpgradeInventory()" ${disabled}>${upgradePriceOptions(upgradeView.inventoryPrice)}</select>
        </div>
        <div class="upgrade-selection-actions"><button type="button" class="small" onclick="selectAllUpgrade()" ${disabled}>Выбрать все доступные</button><button type="button" class="small quiet" onclick="clearUpgradeSelection()" ${disabled}>Очистить</button></div>
        <div id="upgradeInventory" class="upgrade-card-grid"></div>
        <button id="upgradeInventoryMore" type="button" class="upgrade-more" onclick="showMoreUpgradeInventory()" ${disabled}></button>
      </section>
      <section class="upgrade-center upgrade-center-v2">
        <div class="eyebrow">SERVER VERIFIED UPGRADE</div>
        <div class="upgrade-slots upgrade-slots-v2">
          <div class="upgrade-slot"><small>Ставка</small><div class="upgrade-slot-preview">${upgradeStakePreview(indices)}</div><strong>${indices.length ? `${indices.length} ${upgradeRussianSkins(indices.length)}` : 'Не выбрана'}</strong><b>${money(stake)} ₽</b></div>
          <div class="upgrade-arrow" aria-hidden="true">➜</div>
          <div class="upgrade-slot"><small>Цель</small><div class="upgrade-slot-preview">${upgradeTargetPreview(target)}</div><strong>${target ? escapeHtml(target.n) : 'Не выбрана'}</strong><b>${target ? `${money(target.p)} ₽` : '—'}</b></div>
        </div>
        <div class="upgrade-quick" aria-label="Быстрый выбор цели"><span>Быстрая цель:</span>${[1.5, 2, 5, 10].map(multiplier => `<button type="button" class="small" onclick="quickUpgradeTarget(${multiplier})" ${!stake || upgradeView.operationPending ? 'disabled' : ''}>×${multiplier}</button>`).join('')}</div>
        <div class="upgrade-wheel${outcomeClass}" id="upgradeWheel" style="--chance-deg:${(chance * 3.6).toFixed(6)}deg;--pointer-angle:${pointerAngle}deg" aria-label="Шанс успеха ${chance.toFixed(2)} процентов">
          <div class="upgrade-wheel-sector"></div>
          <div class="upgrade-wheel-pointer"><i></i></div>
          <div class="wheel-inner"><div class="chance">${chance.toFixed(2)}%</div><small>шанс успеха</small></div>
        </div>
        <div class="upgrade-wheel-key"><i></i> Успешный сектор · ${chance.toFixed(2)}%</div>
        ${upgradeView.targetInvalidated ? '<div class="upgrade-inline-warning">Цель стала не дороже ставки и была снята.</div>' : ''}
        <button class="primary upgrade-action" id="upgradeBtn" ${!target || !indices.length || upgradeView.operationPending ? 'disabled' : ''} onclick="doUpgrade()">Испытать удачу</button>
        ${upgradeResultMarkup(upgradeView.result)}
        <p class="subtext upgrade-risk-note">При неудаче выбранные предметы сгорают. Заблокированные скины в ставку не попадают.</p>
      </section>
      <section class="panel upgrade-side upgrade-side-targets">
        <div class="upgrade-panel-title"><div><h3>Цель апгрейда</h3><div id="upgradeTargetCount" class="subtext"></div></div><span class="pill">только дороже ставки</span></div>
        <div class="upgrade-filters">
          <input id="upgradeTargetSearch" class="field" value="${escapeHtml(upgradeView.targetQuery)}" placeholder="Поиск оружия…" oninput="filterTargets()" ${disabled}>
          <select id="upgradeTargetSort" class="field upgrade-select" onchange="filterTargets()" ${disabled}>
            <option value="price-asc" ${upgradeView.targetSort === 'price-asc' ? 'selected' : ''}>Цена: по возрастанию</option><option value="price-desc" ${upgradeView.targetSort === 'price-desc' ? 'selected' : ''}>Цена: по убыванию</option><option value="name" ${upgradeView.targetSort === 'name' ? 'selected' : ''}>По названию</option>
          </select>
          <select id="upgradeTargetPrice" class="field upgrade-select" onchange="filterTargets()" ${disabled}>${upgradePriceOptions(upgradeView.targetPrice)}</select>
        </div>
        <div id="targetGrid" class="upgrade-card-grid"></div>
        <button id="upgradeTargetMore" type="button" class="upgrade-more" onclick="showMoreUpgradeTargets()" ${disabled}></button>
      </section>
    </div>
  </section>`;
  renderUpgradeInventoryList();
  renderUpgradeTargetList();
}

function upgradePriceOptions(current) {
  const options = [['all', 'Любая цена'], ['under-100', 'До 100 ₽'], ['100-500', '100–500 ₽'], ['500-2000', '500–2 000 ₽'], ['over-2000', 'От 2 000 ₽']];
  return options.map(([value, label]) => `<option value="${value}" ${current === value ? 'selected' : ''}>${label}</option>`).join('');
}

function upgradeRussianSkins(number) {
  const lastTwo = number % 100;
  const last = number % 10;
  if (lastTwo >= 11 && lastTwo <= 19) return 'скинов';
  if (last === 1) return 'скин';
  if (last >= 2 && last <= 4) return 'скина';
  return 'скинов';
}

/* Новый отдельный обработчик: не вызывает selectFor и поэтому не даёт bubbling сделать двойной выбор. */
function selectUpgradeSkin(index) {
  if (busy) return;
  if (!requireUser()) return;
  const skin = user?.inv?.[index];
  if (!Number.isInteger(index) || !skin) return;
  if (skin.locked) return toast('Заблокированный скин защищён и не попадёт в ставку', 'error');
  if (upgradeNumber(skin.p) <= 0) return toast('В ставку можно выбрать только скин с положительной стоимостью', 'error');
  if (selectedUpgrade.has(index)) {
    selectedUpgrade.delete(index);
  } else {
    if (selectedUpgrade.size >= 500) return toast('В одной ставке может быть не более 500 скинов', 'error');
    selectedUpgrade.add(index);
  }
  const targetBefore = upgradeTarget && upgradeCatalogTarget(upgradeTarget.i);
  const stake = sanitizeUpgradeState();
  if (targetBefore && !upgradeTarget && targetBefore.p <= stake) upgradeView.targetInvalidated = true;
  sound('select');
  renderUpgrade();
}

function selectAllUpgrade() {
  if (busy || !requireUser()) return;
  selectedUpgrade.clear();
  for (let index = 0; index < (user?.inv || []).length && selectedUpgrade.size < 500; index += 1) {
    const skin = user.inv[index];
    if (!skin.locked && upgradeNumber(skin.p) > 0) selectedUpgrade.add(index);
  }
  const targetBefore = upgradeTarget && upgradeCatalogTarget(upgradeTarget.i);
  const stake = sanitizeUpgradeState();
  if (targetBefore && !upgradeTarget && targetBefore.p <= stake) upgradeView.targetInvalidated = true;
  sound('select');
  renderUpgrade();
}

function clearUpgradeSelection() {
  if (busy) return;
  selectedUpgrade.clear();
  upgradeView.targetInvalidated = false;
  sound('select');
  renderUpgrade();
}

function filterUpgradeInventory() {
  if (busy) return;
  const search = $('upgradeInvSearch');
  const sort = $('upgradeInvSort');
  const price = $('upgradeInvPrice');
  if (search) upgradeView.inventoryQuery = search.value;
  if (sort) upgradeView.inventorySort = sort.value;
  if (price) upgradeView.inventoryPrice = price.value;
  upgradeView.inventoryVisible = UPGRADE_PAGE_SIZE;
  renderUpgradeInventoryList();
}

function filterTargets() {
  if (busy) return;
  const search = $('upgradeTargetSearch');
  const sort = $('upgradeTargetSort');
  const price = $('upgradeTargetPrice');
  if (search) upgradeView.targetQuery = search.value;
  if (sort) upgradeView.targetSort = sort.value;
  if (price) upgradeView.targetPrice = price.value;
  upgradeView.targetVisible = UPGRADE_PAGE_SIZE;
  renderUpgradeTargetList();
}

function showMoreUpgradeInventory() {
  if (busy) return;
  upgradeView.inventoryVisible += UPGRADE_PAGE_SIZE;
  renderUpgradeInventoryList();
}

function showMoreUpgradeTargets() {
  if (busy) return;
  upgradeView.targetVisible += UPGRADE_PAGE_SIZE;
  renderUpgradeTargetList();
}

function chooseTarget(index) {
  if (busy) return;
  const stake = sanitizeUpgradeState();
  const target = upgradeCatalogTarget(index);
  if (!target || target.p <= stake) return toast('Цель должна быть дороже текущей ставки', 'error');
  upgradeTarget = target;
  upgradeView.targetInvalidated = false;
  sound('select');
  renderUpgrade();
}

function quickUpgradeTarget(multiplier) {
  if (busy) return;
  const stake = sanitizeUpgradeState();
  if (!stake) return toast('Сначала выбери скины для ставки', 'error');
  const factor = upgradeNumber(multiplier);
  if (!(factor > 1)) return;
  const candidates = (CATALOG?.SK || [])
    .map((_, index) => upgradeCatalogTarget(index))
    .filter(target => target && target.p > stake);
  if (!candidates.length) return toast('В каталоге нет более дорогой цели', 'error');
  const desired = stake * factor;
  candidates.sort((a, b) => Math.abs(a.p - desired) - Math.abs(b.p - desired) || a.p - b.p || a.i - b.i);
  upgradeTarget = candidates[0];
  upgradeView.targetInvalidated = false;
  sound('select');
  renderUpgrade();
}

function startNewUpgradeAttempt() {
  if (busy) return;
  upgradeView.result = null;
  upgradeView.targetInvalidated = false;
  renderUpgrade();
}

function upgradeDisableControls(disabled) {
  const root = $('upgradeRoot');
  if (!root) return;
  root.setAttribute('aria-busy', disabled ? 'true' : 'false');
  root.querySelectorAll('button,input,select').forEach(control => { control.disabled = disabled; });
}

function upgradeDelay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function upgradeEndAngle(chance, won) {
  const sector = Math.max(0, Math.min(90, upgradeNumber(chance))) * 3.6;
  if (won) {
    const inset = Math.min(5, sector * 0.18);
    const start = sector > inset * 2 ? inset : sector * 0.25;
    const width = sector > inset * 2 ? sector - inset * 2 : sector * 0.5;
    return start + Math.random() * Math.max(width, 0.001);
  }
  const outside = 360 - sector;
  const inset = Math.min(5, outside * 0.08);
  return sector + inset + Math.random() * Math.max(outside - inset * 2, 0.001);
}

async function animateUpgradeWheel(serverChance, won) {
  const wheel = $('upgradeWheel');
  if (!wheel) throw new Error('Рулетка недоступна');
  const reduced = typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const duration = reduced ? 180 : 3800;
  const chance = Math.max(0, Math.min(90, upgradeNumber(serverChance)));
  const finalAngle = upgradeEndAngle(chance, won);
  const fullTurns = reduced ? 0 : 5 * 360;
  const destination = fullTurns + finalAngle;
  const pointer = wheel.querySelector('.upgrade-wheel-pointer');
  if (!pointer) throw new Error('Указатель рулетки недоступен');
  wheel.style.setProperty('--chance-deg', `${(chance * 3.6).toFixed(6)}deg`);
  wheel.style.setProperty('--pointer-angle', '0deg');
  wheel.classList.remove('win', 'lose', 'is-spinning');
  pointer.style.transition = 'none';
  wheel.classList.add('is-spinning');
  try {
    await new Promise((resolve, reject) => {
      const start = performance.now();
      let previousTick = -1;
      function frame(now) {
        try {
        const progress = Math.min(1, Math.max(0, (now - start) / duration));
        const angle = destination * (1 - Math.pow(1 - progress, 4));
        wheel.style.setProperty('--pointer-angle', `${angle}deg`);
        const tick = Math.floor(angle / 15);
        if (!reduced && tick !== previousTick && progress < .995) {
          previousTick = tick;
          if (!document.hidden) sound('tick');
        }
        if (progress < 1) requestAnimationFrame(frame);
        else resolve();
        } catch (error) {
          reject(error);
        }
      }
      requestAnimationFrame(frame);
    });
    return finalAngle;
  } finally {
    wheel.classList.remove('is-spinning');
    wheel.classList.add(won ? 'win' : 'lose');
  }
}

async function doUpgrade() {
  if (busy || !requireUser()) return;
  const stake = sanitizeUpgradeState();
  const indices = upgradeSelectedIndices();
  const target = upgradeTarget && upgradeCatalogTarget(upgradeTarget.i);
  if (!indices.length) return toast('Выбери от 1 до 500 скинов для ставки', 'error');
  if (indices.length > 500) return toast('В одной ставке может быть не более 500 скинов', 'error');
  if (!target || target.p <= stake) return toast('Выбери цель дороже суммы ставки', 'error');

  busy = true;
  upgradeView.operationPending = true;
  upgradeSetInteractionLock(true);
  upgradeDisableControls(true);
  const button = $('upgradeBtn');
  if (button) button.textContent = 'Проверяем ставку…';
  sound('upgrade');

  try {
    const response = await api('/api/upgrade', { method: 'POST', body: JSON.stringify({ indices, targetIndex: target.i }) });
    /* Профиль обновляется до анимации: даже сбой визуального эффекта не скроет реальный итог сервера. */
    if (response.user) setUser(response.user);
    /* Индексы контракта становятся потенциально другими после удаления ставки. */
    if (typeof selectedContract !== 'undefined' && selectedContract) selectedContract.clear();
    const chance = upgradeNumber(response.chance);
    if (button) button.textContent = 'Крутим рулетку…';
    let angle = upgradeEndAngle(chance, !!response.win);
    try {
      angle = await animateUpgradeWheel(chance, !!response.win);
    } catch (animationError) {
      /* Серверный результат уже получен и будет показан после размонтирования старого экрана. */
      console.warn('Upgrade wheel animation failed:', animationError);
    }
    upgradeView.result = { win: !!response.win, item: response.item || null, chance, angle, target: { n: target.n, p: target.p } };
    selectedUpgrade.clear();
    upgradeTarget = null;
    upgradeView.targetInvalidated = false;
    sound(response.win ? 'victory' : 'fail');
    toast(response.win ? 'Апгрейд успешен!' : 'Апгрейд не удался — ставка сгорела.', response.win ? 'good' : 'error');
  } catch (error) {
    toast(error.message || 'Не удалось выполнить апгрейд', 'error');
    sound('fail');
  } finally {
    busy = false;
    upgradeView.operationPending = false;
    upgradeSetInteractionLock(false);
    /* На ошибке это возвращает все контролы; на успехе — только после завершения анимации. */
    if (page === 'upgrade') renderUpgrade();
  }
}
