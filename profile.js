'use strict';

function profileTotal() { return (user?.inv || []).reduce((sum, item) => sum + Number(item.p || 0), 0); }
function profileRarityRows() {
  const counts = {};
  (user?.inv || []).forEach(item => { counts[item.r] = (counts[item.r] || 0) + 1; });
  return Object.entries(RARITY).map(([key, rarity]) => `<div class="profile-rarity-row"><span><i style="background:${rarity.color}"></i>${rarity.name}</span><b>${counts[key] || 0}</b></div>`).join('');
}
function profileBadge() {
  const opened = Number(user?.opened || 0);
  if (opened >= 100) return ['Охотник за удачей', '100+ открытий'];
  if (opened >= 25) return ['Опытный игрок', '25+ открытий'];
  if ((user?.inv || []).length >= 10) return ['Коллекционер', '10+ предметов'];
  return ['Новичок арены', 'Собери свою первую коллекцию'];
}
function renderProfile() {
  if (!requireUser()) return;
  const badge = profileBadge();
  const inv = (user.inv || []).slice().sort((a, b) => Number(b.p) - Number(a.p));
  const avatar = escapeHtml(String(user.name || 'И').slice(0, 2).toUpperCase());
  sound('profile');
  $('app').innerHTML = `<section class="profile-hero"><div class="profile-avatar">${avatar}<span></span></div><div class="profile-identity"><div class="eyebrow">PLAYER PROFILE</div><h1>${escapeHtml(user.name)}</h1><p class="muted">ID игрока #${Number(user.id || 0)} · ${user.role === 'admin' ? 'Администратор' : 'Игрок'}</p><div class="profile-badges"><span class="profile-badge">✦ ${badge[0]}</span><span class="pill">${badge[1]}</span></div></div><button class="primary profile-bonus" onclick="claimBonus()">Забрать бонус</button></section><div class="profile-stats"><div class="profile-stat"><span>Баланс</span><strong>${money(user.bal)} ₽</strong></div><div class="profile-stat"><span>Открыто кейсов</span><strong>${money(user.opened || 0)}</strong></div><div class="profile-stat"><span>Предметов</span><strong>${money(inv.length)}</strong></div><div class="profile-stat"><span>Стоимость инвентаря</span><strong>${money(profileTotal())} ₽</strong></div><div class="profile-stat"><span>Лучший дроп</span><strong>${money(user.best || 0)} ₽</strong></div></div><div class="profile-columns"><section class="panel profile-panel"><div class="sectionhead profile-sectionhead"><div><h2>Редкости коллекции</h2><div class="subtext">Твоя текущая статистика по инвентарю</div></div></div><div class="profile-rarity-list">${profileRarityRows()}</div><div class="profile-progress"><div><span>Заполненность коллекции</span><b>${Math.min(100, Math.round(inv.length / 50 * 100))}%</b></div><i style="width:${Math.min(100, inv.length / 50 * 100)}%"></i></div></section><section class="panel profile-panel"><div class="sectionhead profile-sectionhead"><div><h2>Лучшие предметы</h2><div class="subtext">Самые дорогие скины в инвентаре</div></div><button class="small" onclick="go('inventory')">В инвентарь</button></div><div class="profile-top-items">${inv.slice(0, 3).map((item, index) => `<div class="profile-top-item"><span class="profile-rank">${index + 1}</span><div class="profile-top-image">${imgMarkup(item.n)}</div><div><strong>${escapeHtml(item.n)}</strong><b>${money(item.p)} ₽</b></div></div>`).join('') || '<div class="empty">Инвентарь пока пуст.</div>'}</div></section></div><section class="sectionhead profile-inventory-head"><div><h2>Коллекция игрока</h2><div class="subtext">${inv.length ? 'Все предметы, которые сейчас принадлежат аккаунту' : 'Открой кейс, чтобы начать коллекцию'}</div></div></section>${inv.length ? `<div class="skin-grid profile-inventory-grid">${inv.slice(0, 24).map(item => skinCard(item, -1, false)).join('')}</div>${inv.length > 24 ? `<button class="profile-more" onclick="go('inventory')">Показать весь инвентарь · ещё ${inv.length - 24}</button>` : ''}` : '<div class="empty">Коллекция пуста.</div>'}`;
}

const profileOriginalGo = go;
go = function (nextPage) {
  if (nextPage === 'profile') {
    page = 'profile';
    navActive();
    renderProfile();
    window.scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }
  return profileOriginalGo(nextPage);
};
