'use strict';

/**
 * Tests for features added in batches 51-56.
 * Tests only pure/exported functions — no DB or HTTP calls.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

// ── isWithinBusinessHours ─────────────────────────────────────────────────

describe('isWithinBusinessHours', () => {
  const { _isWithinBusinessHours: isBH } = require('../src/api/routes/clients');

  test('empty opening_times → always open', () => {
    assert.equal(isBH({}, 'UTC'), true);
    assert.equal(isBH(null, 'UTC'), true);
  });

  test('closed day → false', () => {
    const schedule = {
      monday: { closed: true },
      tuesday: { open: '09:00', close: '17:00' },
      wednesday: { open: '09:00', close: '17:00' },
      thursday: { open: '09:00', close: '17:00' },
      friday: { open: '09:00', close: '17:00' },
      saturday: { closed: true },
      sunday: { closed: true },
    };
    const now = new Date();
    const dayName = now.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' }).toLowerCase();
    const result = isBH(schedule, 'UTC');
    // If today is closed in schedule, result should be false; otherwise depends on time
    if (schedule[dayName]?.closed) {
      assert.equal(result, false);
    } else {
      // Not a closed day — result depends on current time; just verify it's boolean
      assert.equal(typeof result, 'boolean');
    }
  });

  test('always-open schedule (00:00-23:59) → true', () => {
    const days = ['monday','tuesday','wednesday','thursday','friday','saturday','sunday'];
    const schedule = Object.fromEntries(days.map((d) => [d, { open: '00:00', close: '23:59' }]));
    assert.equal(isBH(schedule, 'UTC'), true);
  });

  test('always-closed schedule (close before open) → false', () => {
    const days = ['monday','tuesday','wednesday','thursday','friday','saturday','sunday'];
    // open=23:59, close=00:00 — window never matches current time in practice
    const schedule = Object.fromEntries(days.map((d) => [d, { open: '23:59', close: '00:00' }]));
    assert.equal(isBH(schedule, 'UTC'), false);
  });

  test('missing day entry → closed for that day', () => {
    // Only Saturday defined; all other days not in schedule → closed
    const schedule = { saturday: { open: '10:00', close: '14:00' } };
    const now = new Date();
    const dayName = now.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' }).toLowerCase();
    if (dayName !== 'saturday') {
      assert.equal(isBH(schedule, 'UTC'), false);
    } else {
      assert.equal(typeof isBH(schedule, 'UTC'), 'boolean');
    }
  });
});

// ── CSV sanitizer ────────────────────────────────────────────────────────────

describe('sanitizeCsv (_sanitizeCsv)', () => {
  const { _sanitizeCsv: sanitize } = require('../src/api/routes/calls');

  test('regular string is double-quoted', () => {
    assert.equal(sanitize('hello'), '"hello"');
  });

  test('null/undefined renders as empty quoted string', () => {
    assert.equal(sanitize(null), '""');
    assert.equal(sanitize(undefined), '""');
  });

  test('double quotes are escaped', () => {
    assert.equal(sanitize('say "hello"'), '"say ""hello"""');
  });

  test('formula injection prefix = is neutralised', () => {
    const result = sanitize('=HYPERLINK("evil")');
    assert.ok(result.startsWith('"\''), `should start with "'": ${result}`);
  });

  test('formula injection prefix + is neutralised', () => {
    const result = sanitize('+cmd');
    assert.ok(result.startsWith('"\''), `should start with "'": ${result}`);
  });

  test('formula injection prefix - is neutralised', () => {
    const result = sanitize('-1+1');
    assert.ok(result.startsWith('"\''), `should start with "'": ${result}`);
  });

  test('formula injection prefix @ is neutralised', () => {
    const result = sanitize('@SUM(A1)');
    assert.ok(result.startsWith('"\''), `should start with "'": ${result}`);
  });

  test('normal number is not neutralised', () => {
    const result = sanitize('42');
    assert.equal(result, '"42"');
  });
});

// ── Password validation ───────────────────────────────────────────────────────

describe('validatePassword (auth.js)', () => {
  const { validatePassword } = require('../src/api/routes/auth');

  test('strong password passes', () => {
    assert.equal(validatePassword('StrongP@ss123'), null);
  });

  test('too short', () => {
    const msg = validatePassword('Ab1!short');
    assert.ok(msg, 'should return error');
  });

  test('no uppercase', () => {
    const msg = validatePassword('weakpassword1!');
    assert.ok(msg);
  });

  test('no number', () => {
    const msg = validatePassword('Weakpassword!');
    assert.ok(msg);
  });

  test('no special char', () => {
    const msg = validatePassword('WeakPassword1');
    assert.ok(msg);
  });
});

// ── DID management: operator-clients module structure ─────────────────────────

describe('operator-clients route', () => {
  const route = require('../src/api/routes/operator-clients');

  test('module exports an Express Router', () => {
    assert.ok(route, 'module loaded');
    assert.equal(typeof route, 'function'); // Express Router is a function
  });
});

// ── Callbacks direct route ────────────────────────────────────────────────────

describe('callbacks route', () => {
  const route = require('../src/api/routes/callbacks');

  test('module exports an Express Router', () => {
    assert.ok(route);
    assert.equal(typeof route, 'function');
  });
});

// ── Widget route ──────────────────────────────────────────────────────────────

describe('widget route', () => {
  const route = require('../src/api/routes/widget');

  test('module exports an Express Router', () => {
    assert.ok(route);
    assert.equal(typeof route, 'function');
  });
});

// ── Reports SLA compliance route ──────────────────────────────────────────────

describe('reports route', () => {
  const route = require('../src/api/routes/reports');

  test('module exports an Express Router', () => {
    assert.ok(route);
    assert.equal(typeof route, 'function');
  });
});

// ── Recordings panel (RecordingsPanel) — UI helpers are not exported; check route ───

describe('calls route exports', () => {
  const callsRoute = require('../src/api/routes/calls');

  test('module exports a Router', () => {
    assert.ok(callsRoute);
    assert.equal(typeof callsRoute, 'function');
  });

  test('_sanitizeCsv is exported', () => {
    assert.equal(typeof callsRoute._sanitizeCsv, 'function');
  });
});

// ── Auth route exports ────────────────────────────────────────────────────────

describe('auth route exports', () => {
  const authRoute = require('../src/api/routes/auth');

  test('router is exported', () => {
    assert.ok(authRoute.router);
  });

  test('validatePassword is exported', () => {
    assert.equal(typeof authRoute.validatePassword, 'function');
  });
});

// ── Delivery service ──────────────────────────────────────────────────────────

describe('delivery service exports', () => {
  const delivery = require('../src/services/delivery');

  test('deliverMessage is exported', () => {
    assert.equal(typeof delivery.deliverMessage, 'function');
  });

  test('_assertValidEmail is exported', () => {
    assert.equal(typeof delivery._assertValidEmail, 'function');
  });

  test('isPrivateUrl is exported', () => {
    assert.equal(typeof delivery.isPrivateUrl, 'function');
  });
});

// ── isPrivateUrl ─────────────────────────────────────────────────────────────

describe('isPrivateUrl', () => {
  const { isPrivateUrl } = require('../src/services/delivery');

  test('localhost is private', () => {
    assert.equal(isPrivateUrl('http://localhost/hook'), true);
  });

  test('127.0.0.1 is private', () => {
    assert.equal(isPrivateUrl('http://127.0.0.1/hook'), true);
  });

  test('10.x.x.x is private', () => {
    assert.equal(isPrivateUrl('http://10.0.0.1/hook'), true);
  });

  test('public URL is not private', () => {
    assert.equal(isPrivateUrl('https://hooks.example.com/webhook'), false);
  });

  test('empty/invalid string is treated as private (blocked)', () => {
    assert.equal(isPrivateUrl(''), true);
    assert.equal(isPrivateUrl('not-a-url'), true);
  });
});
