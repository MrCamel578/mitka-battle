/*
 * Case categories are intentionally kept separate from the catalogue and renderCases().
 * Connect this file after the main inline script, then call initCaseCategories().
 */
(function () {
  'use strict';

  // The catalogue does not expose a real series field. "Серия I" is therefore an
  // explicit, stable ID set rather than a guessed property based on a case name.
  // All other categories are price ranks; the limits are chosen at the gaps in the
  // current price ladder: 59–139, 219–899 and 1499+ ₽.
  const SERIES_I_IDS = new Set([0, 1, 2, 3, 4]);
  const CATEGORY_ORDER = ['all', 'series-i', 'starter', 'premium', 'elite'];
  const CATEGORY_META = {
    all: { label: 'Все' },
    'series-i': { label: 'Серия I' },
    starter: { label: 'Стартовые' },
    premium: { label: 'Премиум' },
    elite: { label: 'Элитные' }
  };

  let initialized = false;
  let activeCategory = 'all';
  let sourceFilterCases = null;
  let observer = null;
  let syncQueued = false;

  function getCatalogCases() {
    // CATALOG is declared by the existing inline application script. The guard
    // lets the hook be called before its async catalogue request has completed.
    return typeof CATALOG !== 'undefined' && Array.isArray(CATALOG.CASES)
      ? CATALOG.CASES
      : [];
  }

  function getCategorySelect() {
    return document.getElementById('caseCategory');
  }

  function normalizeCategory(value) {
    return CATEGORY_ORDER.includes(value) ? value : 'all';
  }

  function categoryForCase(caseItem) {
    if (SERIES_I_IDS.has(Number(caseItem.id))) return 'series-i';

    const price = Number(caseItem.price);
    if (price >= 1000) return 'elite';
    if (price >= 150) return 'premium';
    return 'starter';
  }

  function matchesActiveCategory(caseItem) {
    return activeCategory === 'all' || categoryForCase(caseItem) === activeCategory;
  }

  function getSearchMatches() {
    const search = document.getElementById('caseSearch');
    const query = search ? search.value.toLowerCase() : '';

    // This mirrors the existing filterCases() name match so the counters are
    // useful while someone types, without changing the source filter or sort.
    return getCatalogCases().filter((caseItem) =>
      String(caseItem.name || '').toLowerCase().includes(query)
    );
  }

  function ensureCategorySelect() {
    const select = getCategorySelect();
    if (!select) return null;

    const alreadyEnhanced = select.dataset.caseCategoriesReady === 'true';
    const desiredCategory = normalizeCategory(
      alreadyEnhanced && CATEGORY_ORDER.includes(select.value)
        ? select.value
        : activeCategory
    );

    if (!alreadyEnhanced) {
      select.innerHTML = CATEGORY_ORDER.map((id) =>
        `<option value="${id}">${CATEGORY_META[id].label}</option>`
      ).join('');
      select.dataset.caseCategoriesReady = 'true';
    }
    if (select.value !== desiredCategory) select.value = desiredCategory;
    select.setAttribute('aria-label', 'Категория кейсов');
    activeCategory = desiredCategory;

    return select;
  }

  function getCaseIdFromCard(card) {
    const handler = card.getAttribute('onclick') || '';
    const match = handler.match(/openCasePage\((['"]?)([^,)'"\s]+)\1\)/);
    return match ? String(match[2]) : null;
  }

  function filterRenderedCards() {
    const grid = document.getElementById('caseGrid');
    if (!grid) return;

    const casesById = new Map(
      getCatalogCases().map((caseItem) => [String(caseItem.id), caseItem])
    );
    const cards = Array.from(grid.querySelectorAll('.case'));
    let visibleCards = 0;

    grid.querySelector('[data-case-category-empty]')?.remove();

    cards.forEach((card) => {
      const caseItem = casesById.get(getCaseIdFromCard(card));
      const visible = Boolean(caseItem && matchesActiveCategory(caseItem));
      card.hidden = !visible;
      card.classList.toggle('case-category-hidden', !visible);
      if (visible) visibleCards += 1;
    });

    // The original filter has already rendered its own empty state if the search
    // has no results. This message only covers an empty selected category.
    if (cards.length > 0 && visibleCards === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty case-category-empty';
      empty.dataset.caseCategoryEmpty = 'true';
      empty.textContent = 'В этой категории кейсы не найдены.';
      grid.append(empty);
    }
  }

  function updateChips() {
    const root = document.querySelector('[data-case-categories]');
    if (!root) return;

    const searchMatches = getSearchMatches();
    root.querySelectorAll('[data-case-category]').forEach((chip) => {
      const id = normalizeCategory(chip.dataset.caseCategory);
      const count = id === 'all'
        ? searchMatches.length
        : searchMatches.filter((caseItem) => categoryForCase(caseItem) === id).length;
      const selected = id === activeCategory;

      chip.classList.toggle('is-active', selected);
      chip.setAttribute('aria-pressed', String(selected));
      const countNode = chip.querySelector('[data-case-category-count]');
      if (countNode && countNode.textContent !== String(count)) countNode.textContent = String(count);
    });

    const total = root.querySelector('[data-case-category-total]');
    const label = `${searchMatches.length} кейсов`;
    if (total && total.textContent !== label) total.textContent = label;
  }

  function selectCategory(id) {
    activeCategory = normalizeCategory(id);
    const select = getCategorySelect();
    if (select) select.value = activeCategory;

    // Let the original function keep ownership of text search, price ordering,
    // card rendering and its no-results state. Its former price values are no
    // longer used by the rewritten select, so it returns the searched/sorted set
    // before this module applies the selected category to its rendered cards.
    if (typeof window.filterCases === 'function') window.filterCases();
    else syncCategoryUi();
  }

  function mountChips() {
    const grid = document.getElementById('caseGrid');
    if (!grid) return null;

    let root = document.querySelector('[data-case-categories]');
    if (!root) {
      root = document.createElement('section');
      root.className = 'case-categories';
      root.dataset.caseCategories = 'true';
      root.setAttribute('aria-label', 'Категории кейсов');
      root.innerHTML = `
        <div class="case-categories__head">
          <span class="case-categories__label">Категории</span>
          <span class="case-categories__total" data-case-category-total></span>
        </div>
        <div class="case-category-chips" role="group" aria-label="Фильтр категорий кейсов">
          ${CATEGORY_ORDER.map((id) => `
            <button class="case-category-chip" type="button" data-case-category="${id}" aria-pressed="false">
              <span class="case-category-chip__label">${CATEGORY_META[id].label}</span>
              <span class="case-category-chip__count" data-case-category-count>0</span>
            </button>
          `).join('')}
        </div>
      `;
      grid.before(root);

      root.querySelectorAll('[data-case-category]').forEach((chip) => {
        chip.addEventListener('click', () => selectCategory(chip.dataset.caseCategory));
      });
    }

    return root;
  }

  function syncCategoryUi() {
    // Also retry here so an early init call is safe when this file is connected
    // before the inline application script has declared filterCases().
    installFilterHook();
    if (!document.getElementById('caseGrid')) return;
    ensureCategorySelect();
    mountChips();
    filterRenderedCards();
    updateChips();
  }

  function scheduleSync() {
    if (syncQueued) return;
    syncQueued = true;
    queueMicrotask(() => {
      syncQueued = false;
      syncCategoryUi();
    });
  }

  function installFilterHook() {
    if (sourceFilterCases || typeof window.filterCases !== 'function') return;

    sourceFilterCases = window.filterCases;
    window.filterCases = function caseCategoriesFilterHook() {
      const select = getCategorySelect();
      if (select) activeCategory = normalizeCategory(select.value);

      const result = sourceFilterCases.apply(this, arguments);
      filterRenderedCards();
      updateChips();
      return result;
    };
  }

  function initCaseCategories() {
    installFilterHook();

    if (!initialized) {
      initialized = true;
      const app = document.getElementById('app');
      if (app) {
        // renderCases() replaces #app markup on navigation. Watching that one
        // container remounts the chips without editing renderCases() itself.
        observer = new MutationObserver(scheduleSync);
        observer.observe(app, { childList: true, subtree: true });
      }
    }

    scheduleSync();
  }

  window.initCaseCategories = initCaseCategories;
}());
