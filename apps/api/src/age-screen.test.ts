import assert from 'node:assert/strict';
import test from 'node:test';
import { isIsoCalendarDate, passesAgeScreen } from './age-screen.js';

test('age screening accepts only real ISO calendar dates', () => {
  assert.equal(isIsoCalendarDate('2000-02-29'), true);
  assert.equal(isIsoCalendarDate('2001-02-29'), false);
  assert.equal(isIsoCalendarDate('2020-13-01'), false);
  assert.equal(isIsoCalendarDate('2020-01-00'), false);
  assert.equal(isIsoCalendarDate('2020-1-01'), false);
  assert.equal(isIsoCalendarDate('not-a-date'), false);
});

test('age screening uses the UTC calendar birthday and rejects future dates', () => {
  const beforeEighteenthBirthday = new Date('2026-10-20T23:59:59.999Z');
  const eighteenthBirthday = new Date('2026-10-21T00:00:00.000Z');
  assert.equal(passesAgeScreen('2008-10-21', beforeEighteenthBirthday), false);
  assert.equal(passesAgeScreen('2008-10-21', eighteenthBirthday), true);
  assert.equal(passesAgeScreen('2026-10-22', eighteenthBirthday), false);
  assert.equal(passesAgeScreen('2000-02-29', new Date('2018-02-28T23:59:59Z')), false);
  assert.equal(passesAgeScreen('2000-02-29', new Date('2018-03-01T00:00:00Z')), true);
  assert.equal(passesAgeScreen('invalid', eighteenthBirthday), false);
});
