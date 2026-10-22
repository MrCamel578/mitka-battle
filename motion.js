'use strict';

(function () {
  const reduced = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const app = document.getElementById('app');
  let rippleTimer;
  function animatePage() {
    if (!app || reduced()) return;
    app.classList.remove('page-enter');
    void app.offsetWidth;
    app.classList.add('page-enter');
    app.querySelectorAll('.hero,.panel,.case,.skin,.stat,.profile-stat').forEach((element, index) => {
      element.style.setProperty('--motion-delay', `${Math.min(index, 11) * 28}ms`);
      if (!element.closest('.upgrade-root,.contracts-root')) element.classList.add('motion-in');
    });
  }
  document.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button || button.disabled || reduced()) return;
    const rect = button.getBoundingClientRect();
    const ripple = document.createElement('span');
    ripple.className = 'click-ripple';
    ripple.style.left = `${event.clientX - rect.left}px`;
    ripple.style.top = `${event.clientY - rect.top}px`;
    button.appendChild(ripple);
    clearTimeout(rippleTimer);
    rippleTimer = setTimeout(() => ripple.remove(), 500);
  });
  const observer = new MutationObserver(animatePage);
  if (app) observer.observe(app, { childList: true });
  window.addEventListener('load', animatePage, { once: true });
  window.animatePage = animatePage;
})();
