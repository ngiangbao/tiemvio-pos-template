// Managed Web Clips and Home Screen PWAs do not always expose the same display-mode.
// Run before first paint; retain the existing standalone layout for both entry points.
(() => {
  const modes = ['standalone', 'fullscreen'].map(mode => matchMedia(`(display-mode: ${mode})`));
  const update = () => document.documentElement.classList.toggle('app-display',
    navigator.standalone === true || modes.some(query => query.matches));
  update();
  modes.forEach(query => {
    if (query.addEventListener) query.addEventListener('change', update);
    else if (query.addListener) query.addListener(update);
  });
  addEventListener('pageshow', update);
})();
