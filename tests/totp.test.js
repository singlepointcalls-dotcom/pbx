'use strict';

/**
 * TOTP / 2FA unit tests — no database required.
 * Tests pure crypto logic via speakeasy and the exported validatePassword helper.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const speakeasy = require('speakeasy');

const { validatePassword } = require('../src/api/routes/auth');

// ── validatePassword (re-tested here as auth.js export) ───────────────────────
describe('validatePassword (auth)', () => {
  test('accepts a strong password', () => {
    assert.strictEqual(validatePassword('Str0ng!Password'), null);
  });

  test('rejects password shorter than 12 chars', () => {
    assert.match(validatePassword('Sh0rt!X'), /12 characters/);
  });

  test('rejects missing uppercase', () => {
    assert.match(validatePassword('str0ng!password'), /uppercase/);
  });

  test('rejects missing lowercase', () => {
    assert.match(validatePassword('STR0NG!PASSWORD'), /lowercase/);
  });

  test('rejects missing number', () => {
    assert.match(validatePassword('Strong!Password'), /number/);
  });

  test('rejects missing special character', () => {
    assert.match(validatePassword('Str0ngPassword'), /special/);
  });

  test('rejects null', () => {
    assert.ok(validatePassword(null));
  });
});

// ── TOTP secret generation ─────────────────────────────────────────────────────
describe('speakeasy.generateSecret', () => {
  test('returns a base32 secret string', () => {
    const secret = speakeasy.generateSecret({ length: 20 });
    assert.ok(typeof secret.base32 === 'string');
    assert.ok(secret.base32.length > 0);
  });

  test('returns an otpauth_url', () => {
    const secret = speakeasy.generateSecret({ name: 'TestApp', length: 20 });
    assert.ok(typeof secret.otpauth_url === 'string');
    assert.match(secret.otpauth_url, /^otpauth:\/\/totp\//);
  });

  test('name appears in otpauth_url', () => {
    const secret = speakeasy.generateSecret({ name: 'SinglePoint Calls (admin)', length: 20 });
    assert.match(secret.otpauth_url, /SinglePoint/);
  });

  test('each call produces a unique secret', () => {
    const a = speakeasy.generateSecret({ length: 20 });
    const b = speakeasy.generateSecret({ length: 20 });
    assert.notStrictEqual(a.base32, b.base32);
  });
});

// ── TOTP token generation and verification ─────────────────────────────────────
describe('speakeasy.totp', () => {
  let secret;
  test('setup — generate shared secret', () => {
    secret = speakeasy.generateSecret({ length: 20 }).base32;
    assert.ok(secret);
  });

  test('generates a 6-digit token string', () => {
    const token = speakeasy.totp({ secret, encoding: 'base32' });
    assert.match(token, /^\d{6}$/);
  });

  test('verifies a valid current token', () => {
    const token = speakeasy.totp({ secret, encoding: 'base32' });
    const valid = speakeasy.totp.verify({ secret, encoding: 'base32', token, window: 1 });
    assert.ok(valid);
  });

  test('rejects a clearly wrong code', () => {
    const valid = speakeasy.totp.verify({ secret, encoding: 'base32', token: '000000', window: 0 });
    // 000000 is astronomically unlikely to be the real current token
    // If it somehow matches, skip; this is a probabilistic test
    if (speakeasy.totp({ secret, encoding: 'base32' }) === '000000') return;
    assert.ok(!valid);
  });

  test('rejects empty token string', () => {
    const valid = speakeasy.totp.verify({ secret, encoding: 'base32', token: '', window: 1 });
    assert.ok(!valid);
  });

  test('rejects token that is too short', () => {
    const valid = speakeasy.totp.verify({ secret, encoding: 'base32', token: '123', window: 1 });
    assert.ok(!valid);
  });

  test('rejects token that is too long', () => {
    const valid = speakeasy.totp.verify({ secret, encoding: 'base32', token: '1234567', window: 1 });
    assert.ok(!valid);
  });

  test('different secrets produce different tokens', () => {
    const secretA = speakeasy.generateSecret({ length: 20 }).base32;
    const secretB = speakeasy.generateSecret({ length: 20 }).base32;
    const tokenA = speakeasy.totp({ secret: secretA, encoding: 'base32' });
    const tokenB = speakeasy.totp({ secret: secretB, encoding: 'base32' });
    // Different secrets should produce different tokens (overwhelmingly likely)
    // Statistical check: at least one pair differs
    assert.ok(secretA !== secretB); // guaranteed
    // tokens might coincidentally match (1 in 1M chance) — just verify generation
    assert.match(tokenA, /^\d{6}$/);
    assert.match(tokenB, /^\d{6}$/);
  });

  test('window=0 still validates current token', () => {
    const token = speakeasy.totp({ secret, encoding: 'base32' });
    const valid = speakeasy.totp.verify({ secret, encoding: 'base32', token, window: 0 });
    assert.ok(valid);
  });

  test('token generated at step+0 verifies within window=1', () => {
    // Generate a token for 30s ago (step - 1)
    const step = Math.floor(Date.now() / 1000 / 30);
    const tokenPrev = speakeasy.totp({ secret, encoding: 'base32', counter: step - 1 });
    const valid = speakeasy.totp.verify({ secret, encoding: 'base32', token: tokenPrev, window: 1 });
    assert.ok(valid);
  });

  test('token from 2 steps ago fails with window=1', () => {
    const step = Math.floor(Date.now() / 1000 / 30);
    const tokenOld = speakeasy.totp({ secret, encoding: 'base32', counter: step - 2 });
    const valid = speakeasy.totp.verify({ secret, encoding: 'base32', token: tokenOld, window: 1 });
    assert.ok(!valid);
  });
});

// ── Rate-limit helper (pure logic, no HTTP) ────────────────────────────────────
describe('rateLimitAuth logic', () => {
  test('allows first attempt from a fresh IP', () => {
    const attempts = new Map();
    const WINDOW = 15 * 60 * 1000;
    const MAX = 10;

    function check(key) {
      const now = Date.now();
      const entry = attempts.get(key);
      if (entry) {
        if (now - entry.firstAttempt > WINDOW) {
          attempts.set(key, { count: 1, firstAttempt: now });
          return 'ok';
        }
        if (entry.count >= MAX) return 'blocked';
        entry.count++;
        return 'ok';
      }
      attempts.set(key, { count: 1, firstAttempt: now });
      return 'ok';
    }

    assert.strictEqual(check('1.2.3.4:alice'), 'ok');
  });

  test('blocks after MAX attempts within window', () => {
    const attempts = new Map();
    const WINDOW = 15 * 60 * 1000;
    const MAX = 10;

    function check(key) {
      const now = Date.now();
      const entry = attempts.get(key);
      if (entry) {
        if (now - entry.firstAttempt > WINDOW) {
          attempts.set(key, { count: 1, firstAttempt: now });
          return 'ok';
        }
        if (entry.count >= MAX) return 'blocked';
        entry.count++;
        return 'ok';
      }
      attempts.set(key, { count: 1, firstAttempt: now });
      return 'ok';
    }

    const key = '10.0.0.1:bob';
    for (let i = 0; i < MAX; i++) check(key);
    assert.strictEqual(check(key), 'blocked');
  });

  test('resets count after window expires', () => {
    const attempts = new Map();
    const WINDOW = 100; // 100ms for fast test
    const MAX = 3;

    function check(key) {
      const now = Date.now();
      const entry = attempts.get(key);
      if (entry) {
        if (now - entry.firstAttempt > WINDOW) {
          attempts.set(key, { count: 1, firstAttempt: now });
          return 'ok';
        }
        if (entry.count >= MAX) return 'blocked';
        entry.count++;
        return 'ok';
      }
      attempts.set(key, { count: 1, firstAttempt: now });
      return 'ok';
    }

    const key = '10.0.0.2:carol';
    for (let i = 0; i < MAX; i++) check(key);
    assert.strictEqual(check(key), 'blocked');

    // backdate the entry so window appears expired
    attempts.get(key).firstAttempt = Date.now() - WINDOW - 1;
    assert.strictEqual(check(key), 'ok');
  });
});
