import { afterEach, expect, it } from 'vitest';
import { getThemeChoice, setThemeChoice } from './theme';

afterEach(() => {
  document.querySelectorAll('meta[data-theme-test]').forEach((meta) => meta.remove());
  setThemeChoice('system');
  localStorage.removeItem('job-radar.theme');
});

it('keeps native controls, browser chrome and stored choice aligned with explicit themes', () => {
  for (const scheme of ['light', 'dark']) {
    const meta = document.createElement('meta');
    meta.name = 'theme-color';
    meta.media = `(prefers-color-scheme: ${scheme})`;
    meta.dataset.themeTest = '';
    document.head.append(meta);
  }
  for (const choice of ['dark', 'light'] as const) {
    setThemeChoice(choice);
    expect(getThemeChoice()).toBe(choice);
    expect(document.documentElement).toHaveClass(choice);
    expect(document.documentElement.style.colorScheme).toBe(choice);
    expect(localStorage.getItem('job-radar.theme')).toBe(choice);
    for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[data-theme-test]')) {
      expect(meta.content).toBe(choice === 'dark' ? '#11151f' : '#ffffff');
    }
  }
});
