'use strict';

// Only case opening and the navigation lock during its/upgrade's animation.
let interactionLocked = false;
const caseMotionReduced = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

function setCaseOpeningControls(disabled) {
  document.querySelectorAll('#caseQty button, #caseFastMode, #openCaseBtn').forEach(el => {
    el.disabled = disabled;
  });
}

function reelItem(s, winner = false) {
  const rarity = RARITY[s.r] || RARITY.c;
  return `<article class="opening-item${winner ? ' opening-winner' : ''}" style="--rarity:${rarity.color};--rarityGlow:${rarity.color}22"><div class="opening-image">${imgMarkup(s.n).replace('loading="lazy"', 'loading="eager"')}</div><div class="opening-name">${escapeHtml(s.n)}</div><b class="price">${money(s.p)} ₽</b></article>`;
}

function prepareCaseReels(container, c, wins) {
  // A compact shared visual pool avoids hundreds of different image downloads.
  const visualPool = c.pool.slice().sort(() => Math.random() - .5).slice(0, 16);
  const stopIndex = 38;
  container.innerHTML = `<div class="resultbox case-opening-box"><div class="eyebrow">ОТКРЫТИЕ КЕЙСА</div><div class="opening-lanes ${wins.length > 1 ? 'opening-multi' : ''}">${wins.map((win, row) => {
    const items = Array.from({ length: 44 }, (_, i) => i === stopIndex ? win : visualPool[Math.floor(Math.random() * visualPool.length)]);
    return `<div class="opening-lane"><div class="opening-lane-label">${wins.length > 1 ? `Кейс ${row + 1}` : 'Рулетка'}</div><div class="opening-window" aria-label="Рулетка кейса ${row + 1}"><div class="opening-marker" aria-hidden="true"></div><div class="opening-track">${items.map((s, i) => reelItem(s, i === stopIndex)).join('')}</div></div><div class="opening-lane-status subtext">Крутится…</div></div>`;
  }).join('')}</div><p class="subtext opening-status" role="status">Результат уже определён сервером. Ожидаем остановку рулетки…</p></div>`;
  return Array.from(container.querySelectorAll('.opening-window'), (viewport, i) => ({
    viewport,
    track: viewport.querySelector('.opening-track'),
    winner: viewport.querySelector('.opening-winner'),
    status: viewport.parentElement.querySelector('.opening-lane-status'),
    stopIndex,
    jitter: (Math.random() - .5) * .34,
    tick: -1,
    duration: 4250 + i * 95,
    win: wins[i]
  }));
}

function animateCaseReels(reels) {
  return new Promise((resolve, reject) => {
    const start = performance.now();
    const tickRow = reels[0];
    function frame(now) {
      try {
      let finished = true;
      for (const row of reels) {
        const progress = Math.min(1, Math.max(0, (now - start) / row.duration));
        // Quartic ease-out: fast start, long smooth and suspenseful slowdown.
        const eased = 1 - Math.pow(1 - progress, 4);
        const card = row.track.firstElementChild;
        const width = card.getBoundingClientRect().width;
        const gap = parseFloat(getComputedStyle(row.track).gap) || 8;
        const step = width + gap;
        const origin = row.viewport.clientWidth / 2 - width / 2 - 2 * step;
        const destination = row.viewport.clientWidth / 2 - width / 2 - row.stopIndex * step + row.jitter * width;
        const offset = origin + (destination - origin) * eased;
        row.track.style.transform = `translate3d(${offset}px,0,0)`;
        const passed = Math.floor((row.viewport.clientWidth / 2 - offset) / step);
        if (row === tickRow && row.tick !== passed && progress < .995) {
          row.tick = passed;
          if (!document.hidden) sound('tick');
        }
        if (progress < 1) finished = false;
      }
      if (!finished) requestAnimationFrame(frame);
      else resolve();
      } catch (error) {
        reject(error);
      }
    }
    requestAnimationFrame(frame);
  });
}

function showCaseOpeningResult(container, d, fast) {
  if (!container.isConnected) return;
  const total = d.wins.reduce((a, s) => a + Number(s.p), 0);
  if (fast) {
    container.innerHTML = `<div class="resultbox case-opening-box"><h3>Результат открытия: ${d.wins.length} предмет(а)</h3><div class="case-reel case-reel-fast">${d.wins.map(s => skinCard(s, -1, false)).join('')}</div><p class="price">Общая стоимость: ${money(total)} ₽</p><p class="subtext">Все предметы сохранены в инвентаре.</p><button onclick="go('inventory')">Перейти в инвентарь</button></div>`;
    return;
  }
  const lanes = container.querySelectorAll('.opening-lane');
  lanes.forEach((lane, i) => {
    lane.classList.add('opening-landed');
    const status = lane.querySelector('.opening-lane-status');
    status.textContent = `${d.wins[i].n} · ${money(d.wins[i].p)} ₽`;
  });
  const status = container.querySelector('.opening-status');
  if (status) status.remove();
  container.querySelector('.case-opening-box').insertAdjacentHTML('beforeend', `<div class="opening-summary" role="status"><h3>Выпало: ${d.wins.length} предмет(а)</h3><p class="price">Общая стоимость: ${money(total)} ₽</p><p class="subtext">Все предметы сохранены в инвентаре.</p><button onclick="go('inventory')">Перейти в инвентарь</button></div>`);
}

async function openSelectedCase() {
  if (busy || interactionLocked || !requireUser() || !activeCase) return;
  const c = activeCase;
  const count = caseCount;
  const result = $('caseResult');
  if (!result) return;
  if (Number(user.bal) < c.price * count) return toast('Не хватает денег', 'error');
  const fast = !!$('caseFastMode')?.checked || caseMotionReduced();
  busy = true;
  interactionLocked = true;
  setCaseOpeningControls(true);
  const button = $('openCaseBtn');
  button.textContent = 'Открываем…';
  result.innerHTML = '<div class="resultbox case-opening-box"><div class="opening-pending" role="status"><span class="opening-loader" aria-hidden="true"></span>Получаем результат с сервера…</div></div>';
  sound('open');
  let response = null;
  try {
    response = await api('/api/open-case', {
      method: 'POST', body: JSON.stringify({ caseId: c.id, count })
    });
    // Save the authoritative state immediately, never defer it to the visual effect.
    setUser(response.user);
    selectedUpgrade.clear();
    if (!fast && result.isConnected) {
      button.textContent = 'Крутится рулетка…';
      const reels = prepareCaseReels(result, c, response.wins);
      await animateCaseReels(reels);
    }
    showCaseOpeningResult(result, response, fast);
    const rare = response.wins.some(s => s.r === 'y' || s.r === 'g');
    sound(rare ? 'rare' : 'drop');
    toast('Кейс открыт!', 'good');
  } catch (e) {
    // An animation error must not imply that a completed server opening failed.
    if (response) {
      setUser(response.user);
      showCaseOpeningResult(result, response, true);
      toast('Кейс открыт. Предметы сохранены в инвентаре.', 'good');
    } else {
      result.innerHTML = `<div class="resultbox" role="alert"><p class="subtext">${escapeHtml(e.message)}</p></div>`;
      toast(e.message, 'error');
      sound('fail');
    }
  } finally {
    busy = false;
    interactionLocked = false;
    setCaseOpeningControls(false);
    if ($('openCaseBtn')) $('openCaseBtn').textContent = `Открыть за ${money(activeCase.price * caseCount)} ₽`;
  }
}

// Prevent re-rendering/removing an in-flight roulette or upgrade animation.
const caseOriginalGo = go;
go = function (p) {
  if (interactionLocked) return toast('Дождись окончания анимации');
  return caseOriginalGo(p);
};
const caseOriginalOpenPage = openCasePage;
openCasePage = function (id) {
  if (interactionLocked) return;
  return caseOriginalOpenPage(id);
};
const caseOriginalSetCount = setCaseCount;
setCaseCount = function (n) {
  if (interactionLocked) return;
  return caseOriginalSetCount(n);
};
// Logging out during a paid-in-simulation operation would hide its result.
const caseOriginalLogout = logout;
logout = async function () {
  if (interactionLocked) return toast('Дождись окончания анимации');
  return caseOriginalLogout();
};
const caseOriginalClaimBonus = claimBonus;
claimBonus = async function () {
  if (interactionLocked) return toast('Дождись окончания анимации');
  return caseOriginalClaimBonus();
};
