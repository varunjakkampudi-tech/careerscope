import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { URL } from 'node:url';

test('theme follows system, persists selection and tolerates blocked storage', async () => {
  const source = await readFile(new URL('../mobile-site/theme.js', import.meta.url), 'utf8');
  for (const blocked of [false, true]) {
    const events = {};
    const media = {
      matches: true,
      addEventListener: (name, handler) => {
        events[name] = handler;
      },
    };
    const root = { dataset: {} };
    const meta = {};
    const select = {
      value: '',
      addEventListener: (_name, handler) => {
        events.select = handler;
      },
    };
    let saved = 'system';
    runInNewContext(source, {
      window: {
        matchMedia: () => media,
        addEventListener: (name, handler) => {
          events[name] = handler;
        },
      },
      document: {
        documentElement: root,
        querySelector: (selector) => (selector === '#theme' ? select : meta),
        addEventListener: (_name, handler) => {
          events.ready = handler;
        },
      },
      localStorage: {
        getItem: () => {
          if (blocked) throw new Error();
          return saved;
        },
        setItem: (_key, value) => {
          if (blocked) throw new Error();
          saved = value;
        },
      },
    });
    assert.equal(root.dataset.theme, 'dark');
    events.ready();
    events.select({ target: { value: 'light' } });
    assert.equal(root.dataset.theme, 'light');
    assert.equal(meta.content, '#f4f7f7');
    if (!blocked) assert.equal(saved, 'light');
    events.storage({ key: 'careerscope.theme', newValue: 'system' });
    assert.equal(root.dataset.theme, 'dark');
    media.matches = false;
    events.change();
    assert.equal(root.dataset.theme, 'light');
  }
});
