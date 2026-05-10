'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { _buildIcs, _fmtIcs, _escIcs } = require('../src/api/routes/appointments');
const { _sanitizeCsv } = require('../src/api/routes/calls');

// ── iCal helpers ─────────────────────────────────────────────────────────────

test('fmtIcs — formats a date as compact UTC string', () => {
  const d = new Date('2026-05-10T14:30:00.000Z');
  const out = _fmtIcs(d);
  assert.equal(out, '20260510T143000Z');
});

test('fmtIcs — zero-pads single-digit values', () => {
  const d = new Date('2026-01-02T03:04:05.000Z');
  assert.equal(_fmtIcs(d), '20260102T030405Z');
});

test('escIcs — escapes backslash', () => {
  assert.equal(_escIcs('back\\slash'), 'back\\\\slash');
});

test('escIcs — escapes comma', () => {
  assert.equal(_escIcs('a,b'), 'a\\,b');
});

test('escIcs — escapes semicolon', () => {
  assert.equal(_escIcs('a;b'), 'a\\;b');
});

test('escIcs — replaces newline with \\n', () => {
  assert.equal(_escIcs('line1\nline2'), 'line1\\nline2');
});

test('escIcs — converts non-string to string', () => {
  assert.equal(_escIcs(42), '42');
});

test('buildIcs — wraps in VCALENDAR', () => {
  const out = _buildIcs([]);
  assert.ok(out.startsWith('BEGIN:VCALENDAR'), 'starts with BEGIN:VCALENDAR');
  assert.ok(out.includes('END:VCALENDAR'), 'ends with END:VCALENDAR');
});

test('buildIcs — empty appointments produces no VEVENT', () => {
  const out = _buildIcs([]);
  assert.ok(!out.includes('BEGIN:VEVENT'), 'no VEVENT for empty list');
});

test('buildIcs — single appointment produces VEVENT', () => {
  const appt = {
    id: 'test-uuid-1',
    appointment_at: '2026-06-01T10:00:00.000Z',
    duration_minutes: 30,
    service_type: 'Consultation',
    client_name: 'Acme Corp',
    caller_name: 'Jane Doe',
    caller_email: 'jane@example.com',
    notes: 'First visit',
    status: 'confirmed',
  };
  const out = _buildIcs([appt]);
  assert.ok(out.includes('BEGIN:VEVENT'), 'VEVENT present');
  assert.ok(out.includes('END:VEVENT'), 'VEVENT closed');
  assert.ok(out.includes('UID:test-uuid-1@answering-service'), 'correct UID');
  assert.ok(out.includes('SUMMARY:Consultation — Acme Corp'), 'SUMMARY correct');
  assert.ok(out.includes('STATUS:CONFIRMED'), 'confirmed status');
  assert.ok(out.includes('ATTENDEE:mailto:jane@example.com'), 'attendee present');
  assert.ok(out.includes('DESCRIPTION:First visit'), 'notes as description');
});

test('buildIcs — status cancelled maps to CANCELLED', () => {
  const appt = { id: 'x', appointment_at: null, status: 'cancelled', service_type: null, client_name: null };
  const out = _buildIcs([appt]);
  assert.ok(out.includes('STATUS:CANCELLED'), 'cancelled status');
});

test('buildIcs — status pending maps to TENTATIVE', () => {
  const appt = { id: 'x', appointment_at: null, status: 'pending', service_type: null, client_name: null };
  const out = _buildIcs([appt]);
  assert.ok(out.includes('STATUS:TENTATIVE'), 'pending → tentative');
});

test('buildIcs — duration_minutes defaults to 30 when absent', () => {
  const start = new Date('2026-06-01T10:00:00.000Z');
  const expectedEnd = new Date(start.getTime() + 30 * 60000);
  const appt = { id: 'y', appointment_at: start.toISOString(), status: 'confirmed', service_type: 'Demo', client_name: null };
  const out = _buildIcs([appt]);
  assert.ok(out.includes(`DTEND:${_fmtIcs(expectedEnd)}`), 'default 30 min duration');
});

test('buildIcs — no caller_email omits ATTENDEE line', () => {
  const appt = { id: 'z', appointment_at: null, status: 'pending', service_type: null, client_name: null, caller_email: null };
  const out = _buildIcs([appt]);
  assert.ok(!out.includes('ATTENDEE'), 'no ATTENDEE without email');
});

test('buildIcs — no notes omits DESCRIPTION line', () => {
  const appt = { id: 'z', appointment_at: null, status: 'pending', service_type: null, client_name: null, notes: null };
  const out = _buildIcs([appt]);
  assert.ok(!out.includes('DESCRIPTION'), 'no DESCRIPTION without notes');
});

test('buildIcs — multiple appointments produce multiple VEVENTs', () => {
  const mk = (id) => ({ id, appointment_at: null, status: 'pending', service_type: null, client_name: null });
  const out = _buildIcs([mk('a'), mk('b'), mk('c')]);
  const count = (out.match(/BEGIN:VEVENT/g) || []).length;
  assert.equal(count, 3, '3 VEVENTs');
});

// ── CSV sanitizer ─────────────────────────────────────────────────────────────

test('sanitizeCsv — wraps value in double quotes', () => {
  assert.equal(_sanitizeCsv('hello'), '"hello"');
});

test('sanitizeCsv — escapes internal double quotes', () => {
  assert.equal(_sanitizeCsv('say "hi"'), '"say ""hi"""');
});

test('sanitizeCsv — prefixes = to prevent formula injection', () => {
  const out = _sanitizeCsv('=SUM(A1)');
  assert.ok(out.startsWith('"\''), 'prefixed with single quote');
  assert.ok(out.includes('=SUM(A1)'), 'original value preserved');
});

test('sanitizeCsv — prefixes + for injection prevention', () => {
  assert.ok(_sanitizeCsv('+cmd').startsWith('"\''), '+ prefix blocked');
});

test('sanitizeCsv — prefixes - for injection prevention', () => {
  assert.ok(_sanitizeCsv('-1+1').startsWith('"\''), '- prefix blocked');
});

test('sanitizeCsv — prefixes @ for injection prevention', () => {
  assert.ok(_sanitizeCsv('@SUM').startsWith('"\''), '@ prefix blocked');
});

test('sanitizeCsv — handles null gracefully', () => {
  assert.equal(_sanitizeCsv(null), '""');
});

test('sanitizeCsv — handles undefined gracefully', () => {
  assert.equal(_sanitizeCsv(undefined), '""');
});

test('sanitizeCsv — handles numeric values', () => {
  assert.equal(_sanitizeCsv(42), '"42"');
});

test('sanitizeCsv — safe string with no special chars is quoted normally', () => {
  assert.equal(_sanitizeCsv('John Smith'), '"John Smith"');
});
