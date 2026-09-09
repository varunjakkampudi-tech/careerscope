(() => {
  const key = 'careerscope.theme';
  const choices = ['system', 'light', 'dark'];
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  let choice = 'system';
  try {
    const saved = localStorage.getItem(key);
    if (choices.includes(saved)) choice = saved;
  } catch {
    choice = 'system';
  }

  function apply() {
    const resolved = choice === 'system' ? (media.matches ? 'dark' : 'light') : choice;
    document.documentElement.dataset.theme = resolved;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = resolved === 'dark' ? '#0a0d14' : '#f6f7f9';
    for (const select of document.querySelectorAll('#theme, [data-theme-select]'))
      select.value = choice;
  }

  apply();
  media.addEventListener('change', apply);
  window.addEventListener('storage', (event) => {
    if (event.key !== key && event.key !== null) return;
    choice = choices.includes(event.newValue) ? event.newValue : 'system';
    apply();
  });
  document.addEventListener('DOMContentLoaded', () => {
    apply();
    for (const select of document.querySelectorAll('#theme, [data-theme-select]'))
      select.addEventListener('change', (event) => {
        choice = choices.includes(event.target.value) ? event.target.value : 'system';
        try {
          localStorage.setItem(key, choice);
        } catch {
          return apply();
        }
        apply();
      });
  });
})();
