'use strict';

(function () {
  let generation = 0;
  let pending = false;
  const originalSetUser = setUser;
  setUser = function (nextUser) { generation++; originalSetUser(nextUser); };

  async function syncAccount() {
    if (!user || pending || busy || interactionLocked || document.hidden) return;
    const id = user.id, startedAt = generation;
    pending = true;
    try {
      const data = await api('/api/me');
      // Не заменяем результат операции снимком, который был запрошен раньше неё.
      if (generation !== startedAt || busy || interactionLocked || user?.id !== id) return;
      if (!data.user) { setUser(null); go('cases'); toast('Сессия завершена. Войди снова.', 'error'); return; }
      const inventoryChanged = JSON.stringify(user.inv) !== JSON.stringify(data.user.inv);
      const balanceChanged = Number(user.bal) !== Number(data.user.bal);
      const roleChanged = user.role !== data.user.role;
      if (!inventoryChanged && !balanceChanged && !roleChanged && user.banned === data.user.banned) return;
      setUser(data.user);
      if (inventoryChanged) { selectedUpgrade.clear(); selectedContract.clear(); upgradeTarget = null; }
      if (page === 'inventory') renderInventory();
      else if (page === 'profile') renderProfile();
      else if (inventoryChanged && page === 'upgrade') renderUpgrade();
      else if (inventoryChanged && page === 'contracts') renderContracts();
      else if (roleChanged) go(page);
      if (data.user.banned) toast(`Аккаунт заблокирован${data.user.banReason ? ': ' + data.user.banReason : ''}`, 'error');
      else if (inventoryChanged || balanceChanged) toast('Баланс и инвентарь обновлены с сервера');
    } catch (_) {
      // Временная потеря сети не мешает игре; обычные операции показывают свои ошибки.
    } finally { pending = false; }
  }
  setInterval(syncAccount, 12000);
  window.addEventListener('focus', syncAccount);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) syncAccount(); });
})();
