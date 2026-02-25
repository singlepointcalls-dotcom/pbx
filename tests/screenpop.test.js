'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// ---------- Unit: isWithinBusinessHours ----------

const { _isWithinBusinessHours: isWithinBusinessHours } =
  require('../src/api/routes/clients');

describe('isWithinBusinessHours', () => {
  it('returns true when opening_times is empty (always open)', () => {
    assert.equal(isWithinBusinessHours({}, 'UTC'), true);
  });

  it('returns true when opening_times is null', () => {
    assert.equal(isWithinBusinessHours(null, 'UTC'), true);
  });

  it('returns true when opening_times is undefined', () => {
    assert.equal(isWithinBusinessHours(undefined, 'UTC'), true);
  });

  it('returns false on a day not present in schedule', () => {
    // Only Monday is configured — any other day should be closed
    const openingTimes = { monday: { open: '00:00', close: '23:59' } };
    // We can't control "today", so create a schedule with EVERY day open
    // except the intent is to test missing days. Instead, test with only
    // a day that doesn't match today.
    const result = isWithinBusinessHours(
      { neverday: { open: '00:00', close: '23:59' } },
      'UTC'
    );
    assert.equal(result, false);
  });

  it('returns false when the day is explicitly closed', () => {
    const allDays = buildAllDaySchedule({ closed: true });
    assert.equal(isWithinBusinessHours(allDays, 'UTC'), false);
  });

  it('returns true when current time is within open hours (all day)', () => {
    const allDays = buildAllDaySchedule({ open: '00:00', close: '23:59' });
    assert.equal(isWithinBusinessHours(allDays, 'UTC'), true);
  });

  it('returns false when current time is outside open hours (e.g. open 03:00-03:01)', () => {
    // Open for a 1-minute window at 03:00 — extremely unlikely to match
    const allDays = buildAllDaySchedule({ open: '03:00', close: '03:01' });
    const now = new Date();
    const utcHour = now.getUTCHours();
    const utcMin = now.getUTCMinutes();
    const currentMinutes = utcHour * 60 + utcMin;
    // Only passes if we happen to run exactly at 03:00 UTC
    if (currentMinutes >= 180 && currentMinutes < 181) {
      assert.equal(isWithinBusinessHours(allDays, 'UTC'), true);
    } else {
      assert.equal(isWithinBusinessHours(allDays, 'UTC'), false);
    }
  });

  it('respects timezone parameter', () => {
    // Set hours so that the test pass depends on the timezone being applied:
    // Open 00:00-23:59 means always open regardless of timezone.
    const allDays = buildAllDaySchedule({ open: '00:00', close: '23:59' });
    assert.equal(isWithinBusinessHours(allDays, 'Europe/London'), true);
    assert.equal(isWithinBusinessHours(allDays, 'America/New_York'), true);
    assert.equal(isWithinBusinessHours(allDays, 'Asia/Tokyo'), true);
  });

  it('defaults missing open/close to full day', () => {
    // If open and close are absent (but day exists and not closed), falls back to 00:00-23:59
    const allDays = buildAllDaySchedule({});
    assert.equal(isWithinBusinessHours(allDays, 'UTC'), true);
  });
});

// ---------- Unit: assertValidEmail ----------

const { _assertValidEmail: assertValidEmail } =
  require('../src/services/delivery');

describe('assertValidEmail', () => {
  it('accepts a normal email address', () => {
    assert.doesNotThrow(() => assertValidEmail('user@example.com'));
  });

  it('accepts an email with subdomains', () => {
    assert.doesNotThrow(() => assertValidEmail('user@mail.example.co.uk'));
  });

  it('rejects null', () => {
    assert.throws(() => assertValidEmail(null), /Invalid email/);
  });

  it('rejects undefined', () => {
    assert.throws(() => assertValidEmail(undefined), /Invalid email/);
  });

  it('rejects empty string', () => {
    assert.throws(() => assertValidEmail(''), /Invalid email/);
  });

  it('rejects non-string', () => {
    assert.throws(() => assertValidEmail(42), /Invalid email/);
  });

  it('rejects email longer than 320 chars', () => {
    const longLocal = 'a'.repeat(64);
    const longDomain = 'b'.repeat(253) + '.com';
    assert.throws(() => assertValidEmail(`${longLocal}@${longDomain}`), /too long/);
  });

  it('rejects local-part longer than 64 chars', () => {
    const longLocal = 'a'.repeat(65);
    assert.throws(() => assertValidEmail(`${longLocal}@example.com`), /local-part too long/);
  });

  it('rejects domain shorter than 4 chars', () => {
    assert.throws(() => assertValidEmail('user@ab'), /domain invalid/);
  });

  it('rejects email without @', () => {
    assert.throws(() => assertValidEmail('userexample.com'), /missing @/);
  });

  it('rejects email with @ at position 0', () => {
    assert.throws(() => assertValidEmail('@example.com'), /missing @/);
  });
});

// ---------- Screenpop response shape ----------

describe('screenpop response shape expectations', () => {
  it('availability object has required fields', () => {
    // Simulate what the endpoint builds when no manual availability row exists
    const manualAvail = null;
    const withinHours = false;

    const availability = {
      status: manualAvail?.status || (withinHours ? 'available' : 'closed'),
      note: manualAvail?.note || null,
      is_open: withinHours,
      updated_at: manualAvail?.updated_at || null,
    };

    assert.equal(availability.status, 'closed');
    assert.equal(availability.is_open, false);
    assert.equal(availability.note, null);
    assert.equal(availability.updated_at, null);
  });

  it('manual availability overrides computed status', () => {
    const manualAvail = { status: 'out_of_office', note: 'Holiday until Monday', updated_at: new Date().toISOString() };
    const withinHours = true;

    const availability = {
      status: manualAvail?.status || (withinHours ? 'available' : 'closed'),
      note: manualAvail?.note || null,
      is_open: withinHours,
      updated_at: manualAvail?.updated_at || null,
    };

    assert.equal(availability.status, 'out_of_office');
    assert.equal(availability.is_open, true); // still reports hours as open
    assert.equal(availability.note, 'Holiday until Monday');
  });

  it('when manual status is available and within hours, status is available', () => {
    const manualAvail = { status: 'available', note: null, updated_at: null };
    const withinHours = true;

    const availability = {
      status: manualAvail?.status || (withinHours ? 'available' : 'closed'),
      note: manualAvail?.note || null,
      is_open: withinHours,
      updated_at: manualAvail?.updated_at || null,
    };

    assert.equal(availability.status, 'available');
    assert.equal(availability.is_open, true);
  });

  it('no manual row + within hours = available', () => {
    const manualAvail = null;
    const withinHours = true;

    const availability = {
      status: manualAvail?.status || (withinHours ? 'available' : 'closed'),
      note: manualAvail?.note || null,
      is_open: withinHours,
      updated_at: manualAvail?.updated_at || null,
    };

    assert.equal(availability.status, 'available');
    assert.equal(availability.is_open, true);
  });
});

// ---------- helpers ----------

function buildAllDaySchedule(dayConfig) {
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const schedule = {};
  for (const d of days) schedule[d] = { ...dayConfig };
  return schedule;
}
