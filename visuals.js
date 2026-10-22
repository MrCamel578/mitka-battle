'use strict';

(function () {
  const failedImages = new Set();
  const weaponToken = name => String(name || 'CS2').split(/[|–-]/)[0].trim().slice(0, 16) || 'CS2';
  const imageSources = id => {
    if (!id) return [];
    const value = String(id);
    // Catalogued thumbnails are shipped locally, so item images work without
    // Steam-CDN availability, cross-origin rules, or external image blocking.
    if (value.startsWith('/') || value.startsWith('data:image/')) return [value];
    const encoded = encodeURIComponent(String(id));
    return [
      `https://community.akamaihd.net/economy/image/${encoded}/256fx256f`,
      `https://steamcommunity-a.akamaihd.net/economy/image/${encoded}/256fx256f`,
      `https://community.akamai.steamstatic.com/economy/image/${encoded}/256fx256f`,
      `https://steamcdn-a.akamaihd.net/economy/image/${encoded}/256fx256f`
    ];
  };
  const fallbackMarkup = name => `<span class="skin-art-fallback" aria-label="${escapeHtml(name)}"><span class="skin-art-glow"></span><span class="skin-art-gun" aria-hidden="true"><i></i><b></b></span><strong>${escapeHtml(weaponToken(name))}</strong><small>STEAM ITEM</small></span>`;
  function nextImageSource(image) {
    const sources = image.dataset.sources ? JSON.parse(image.dataset.sources) : [];
    const next = Number(image.dataset.sourceIndex || 0) + 1;
    if (next < sources.length) {
      image.dataset.sourceIndex = String(next);
      image.src = sources[next];
      return;
    }
    image.replaceWith(Object.assign(document.createElement('span'), { className: 'skinplaceholder skinplaceholder-fallback', textContent: 'CS2 SKIN' }));
  }
  window.imgMarkup = function (name, cls = '') {
    const catalog = typeof CATALOG !== 'undefined' ? CATALOG : (window.CATALOG || { SK: [] });
    const item = (catalog.SK || []).find(s => s[0] === name);
    const id = item && item[3];
    const sources = imageSources(id);
    if (!sources.length) return fallbackMarkup(name);
    const key = `${id}:${name}`;
    if (failedImages.has(key)) return fallbackMarkup(name);
    return `<img class="${cls}" src="${sources[0]}" alt="${escapeHtml(name)}" loading="lazy" decoding="async" data-source-index="0" data-sources="${escapeHtml(JSON.stringify(sources))}" onerror="nextImageSource(this)">`;
  };
  window.nextImageSource = nextImageSource;
})();
