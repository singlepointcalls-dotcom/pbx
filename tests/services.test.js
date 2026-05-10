'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { validatePassword }   = require('../src/api/routes/auth');
const { _assertValidEmail }  = require('../src/services/delivery');

// ── Password validation ───────────────────────────────────────────────────

test('validatePassword — accepts strong password', () => {
  assert.equal(validatePassword('Str0ng!Pass#99'), null);
});

test('validatePassword — rejects password under 12 chars', () => {
  const msg = validatePassword('Sh0rt!');
  assert.ok(msg, 'should return an error message');
  assert.ok(msg.includes('12'), 'message mentions length');
});

test('validatePassword — rejects missing uppercase', () => {
  const msg = validatePassword('weakpass1234!');
  assert.ok(msg, 'should return an error');
  assert.ok(msg.toLowerCase().includes('uppercase'), 'mentions uppercase');
});

test('validatePassword — rejects missing lowercase', () => {
  const msg = validatePassword('ALLCAPS1234!');
  assert.ok(msg, 'should return an error');
  assert.ok(msg.toLowerCase().includes('lowercase'), 'mentions lowercase');
});

test('validatePassword — rejects missing number', () => {
  const msg = validatePassword('NoNumbers!!AB');
  assert.ok(msg, 'should return an error');
  assert.ok(msg.toLowerCase().includes('number'), 'mentions number');
});

test('validatePassword — rejects missing special character', () => {
  const msg = validatePassword('NoSpecial1234A');
  assert.ok(msg, 'should return an error');
  assert.ok(msg.toLowerCase().includes('special'), 'mentions special char');
});

test('validatePassword — rejects null', () => {
  const msg = validatePassword(null);
  assert.ok(msg, 'null should fail');
});

test('validatePassword — rejects empty string', () => {
  const msg = validatePassword('');
  assert.ok(msg, 'empty should fail');
});

test('validatePassword — accepts exactly 12-char strong password', () => {
  assert.equal(validatePassword('Abcde12345!@'), null);
});

test('validatePassword — accepts long complex password', () => {
  assert.equal(validatePassword('MyS3cur3P@ssw0rd!IsVeryLong'), null);
});

// ── Email validation ──────────────────────────────────────────────────────

test('assertValidEmail — accepts standard email', () => {
  assert.doesNotThrow(() => _assertValidEmail('user@example.com'));
});

test('assertValidEmail — accepts email with subdomain', () => {
  assert.doesNotThrow(() => _assertValidEmail('user@mail.example.co.uk'));
});

test('assertValidEmail — accepts email with plus addressing', () => {
  assert.doesNotThrow(() => _assertValidEmail('user+tag@example.com'));
});

test('assertValidEmail — accepts email with dots in local', () => {
  assert.doesNotThrow(() => _assertValidEmail('first.last@example.com'));
});

test('assertValidEmail — rejects email without @', () => {
  assert.throws(() => _assertValidEmail('notanemail'));
});

test('assertValidEmail — rejects email without domain', () => {
  assert.throws(() => _assertValidEmail('user@'));
});

test('assertValidEmail — rejects empty string', () => {
  assert.throws(() => _assertValidEmail(''));
});

test('assertValidEmail — rejects null', () => {
  assert.throws(() => _assertValidEmail(null));
});

test('assertValidEmail — rejects local part over 64 chars', () => {
  const longLocal = 'a'.repeat(65) + '@example.com';
  assert.throws(() => _assertValidEmail(longLocal));
});

test('assertValidEmail — accepts local part exactly 64 chars', () => {
  const local64 = 'a'.repeat(64) + '@example.com';
  assert.doesNotThrow(() => _assertValidEmail(local64));
});

test('assertValidEmail — rejects domain over 255 chars', () => {
  // domain = 252 a's + '.com' = 256 chars → over limit
  const longDomain = 'user@' + 'a'.repeat(252) + '.com';
  assert.throws(() => _assertValidEmail(longDomain));
});

test('assertValidEmail — rejects total length over 320 chars', () => {
  // 64 + 1 + 200 + 1 + 56 = 322 chars total
  const long = 'a'.repeat(64) + '@' + 'b'.repeat(200) + '.' + 'c'.repeat(56);
  assert.throws(() => _assertValidEmail(long));
});
