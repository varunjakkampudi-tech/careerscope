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
    if (meta) meta.content = resolved === 'dark' ? '#151b1d' : '#f4f7f7';
    const select = document.querySelector('#theme');
    if (select) select.value = choice;
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
    document.querySelector('#theme')?.addEventListener('change', (event) => {
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
