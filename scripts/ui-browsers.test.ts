import assert from 'node:assert/strict';
import test from 'node:test';
import { selectUiBrowsers } from './ui-browsers.js';

const browsers = { chromium: 'chromium', firefox: 'firefox', webkit: 'webkit' };

test('UI browser selection defaults to all engines in stable order', () => {
  assert.deepEqual(selectUiBrowsers(browsers, undefined), [
    ['chromium', 'chromium'],
    ['firefox', 'firefox'],
    ['webkit', 'webkit'],
  ]);
});

test('UI browser selection runs only the requested supported engine', () => {
  assert.deepEqual(selectUiBrowsers(browsers, 'chromium'), [['chromium', 'chromium']]);
  assert.deepEqual(selectUiBrowsers(browsers, 'firefox'), [['firefox', 'firefox']]);
  assert.deepEqual(selectUiBrowsers(browsers, 'webkit'), [['webkit', 'webkit']]);
});

test('UI browser selection rejects unsupported values rather than widening scope', () => {
  assert.throws(
    () => selectUiBrowsers(browsers, 'production'),
    /Unsupported CAREERSCOPE_UI_BROWSER/,
  );
});
