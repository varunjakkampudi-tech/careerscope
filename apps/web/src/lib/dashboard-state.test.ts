import assert from 'node:assert/strict';
import test from 'node:test';
import { panelState, shouldSyncSelection, statDisplay } from './dashboard-state';

test('statDisplay shows the count when the query succeeded', () => {
  assert.deepEqual(statDisplay({ isPending: false, isError: false }, '12'), {
    value: '12',
    hint: null,
  });
});

test('statDisplay shows a dash and no hint while pending', () => {
  assert.deepEqual(statDisplay({ isPending: true, isError: false }, null), {
    value: '—',
    hint: null,
  });
});

test('statDisplay replaces a bare question mark with a dash and a hint on error', () => {
  const result = statDisplay({ isPending: false, isError: true }, null);
  assert.equal(result.value, '—');
  assert.equal(result.hint, 'Could not load');
});

test('statDisplay error wins over a stale label', () => {
  assert.equal(statDisplay({ isPending: false, isError: true }, '3').value, '—');
});

test('statDisplay falls back to a dash when there is no label', () => {
  assert.equal(statDisplay({ isPending: false, isError: false }, null).value, '—');
});

test('panelState reports error when any query failed, even if others are pending', () => {
  assert.equal(
    panelState([
      { isSuccess: true, isError: false },
      { isSuccess: false, isError: true },
      { isSuccess: false, isError: false },
    ]),
    'error',
  );
});

test('panelState reports loading until every query succeeded', () => {
  assert.equal(
    panelState([
      { isSuccess: true, isError: false },
      { isSuccess: false, isError: false },
    ]),
    'loading',
  );
});

test('panelState reports ready when every query succeeded', () => {
  assert.equal(panelState([{ isSuccess: true, isError: false }]), 'ready');
});

test('panelState on an empty list is ready', () => {
  assert.equal(panelState([]), 'ready');
});

test('shouldSyncSelection is true when the lead param changed to a different lead', () => {
  assert.equal(shouldSyncSelection('a', 'b', 'a'), true);
});

test('shouldSyncSelection is true when the param is cleared', () => {
  assert.equal(shouldSyncSelection('a', null, 'a'), true);
});

test('shouldSyncSelection is false when the param did not change', () => {
  assert.equal(shouldSyncSelection('a', 'a', 'x'), false);
});

test('shouldSyncSelection is false when the screen already shows the new lead', () => {
  assert.equal(shouldSyncSelection('a', 'b', 'b'), false);
});

test('statDisplay keeps the last good value when a background refetch fails', () => {
  assert.deepEqual(statDisplay({ isPending: false, isError: true, data: { total: 3 } }, '3'), {
    value: '3',
    hint: null,
  });
});

test('panelState stays ready when a refetch fails but earlier data is cached', () => {
  assert.equal(panelState([{ isSuccess: false, isError: true, data: { items: [] } }]), 'ready');
});

test('panelState still reports error when a failed query has no cached data', () => {
  assert.equal(panelState([{ isSuccess: false, isError: true }]), 'error');
});
