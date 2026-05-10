'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { _exportToDialplan } = require('../src/api/routes/ivr');

const baseFlow = { id: 'abc-123', name: 'Test Flow', client_name: 'Acme Ltd', nodes: [] };

test('exportToDialplan — empty nodes produces hangup stub', () => {
  const out = _exportToDialplan(baseFlow);
  assert.ok(out.includes('[ivr-abc-123]'), 'context header present');
  assert.ok(out.includes('exten => s,1,Hangup()'), 'fallback hangup present');
  assert.ok(out.includes('No nodes defined'), 'comment present');
});

test('exportToDialplan — play node emits Playback', () => {
  const flow = { ...baseFlow, nodes: [{ type: 'play', file: 'welcome' }] };
  const out = _exportToDialplan(flow);
  assert.ok(out.includes('Playback(welcome)'), 'Playback with file');
});

test('exportToDialplan — play node defaults to beep when no file', () => {
  const flow = { ...baseFlow, nodes: [{ type: 'play' }] };
  const out = _exportToDialplan(flow);
  assert.ok(out.includes('Playback(beep)'), 'Playback default beep');
});

test('exportToDialplan — menu node emits Background + WaitExten + digit routes', () => {
  const flow = {
    ...baseFlow,
    nodes: [{ type: 'menu', prompt: 'main-menu', timeout: 7, options: { '1': 'sales', '2': 'support' } }],
  };
  const out = _exportToDialplan(flow);
  assert.ok(out.includes('Background(main-menu)'), 'Background prompt');
  assert.ok(out.includes('WaitExten(7)'), 'WaitExten timeout');
  assert.ok(out.includes('exten => 1,1,Goto('), 'digit 1 route');
  assert.ok(out.includes('exten => 2,1,Goto('), 'digit 2 route');
});

test('exportToDialplan — queue node emits Queue()', () => {
  const flow = { ...baseFlow, nodes: [{ type: 'queue', queue: 'support' }] };
  const out = _exportToDialplan(flow);
  assert.ok(out.includes('Queue(support,'), 'Queue application');
});

test('exportToDialplan — transfer node emits Dial()', () => {
  const flow = { ...baseFlow, nodes: [{ type: 'transfer', extension: '1001' }] };
  const out = _exportToDialplan(flow);
  assert.ok(out.includes('Dial(SIP/1001,'), 'Dial SIP extension');
});

test('exportToDialplan — voicemail node emits VoiceMail()', () => {
  const flow = { ...baseFlow, nodes: [{ type: 'voicemail', mailbox: '200' }] };
  const out = _exportToDialplan(flow);
  assert.ok(out.includes('VoiceMail(200@default,u)'), 'VoiceMail application');
});

test('exportToDialplan — hangup node emits Hangup()', () => {
  const flow = { ...baseFlow, nodes: [{ type: 'hangup' }] };
  const out = _exportToDialplan(flow);
  const lines = out.split('\n');
  const hangupLines = lines.filter(l => l.includes('Hangup()'));
  assert.ok(hangupLines.length >= 1, 'Hangup() present');
});

test('exportToDialplan — unknown node type emits comment', () => {
  const flow = { ...baseFlow, nodes: [{ type: 'mystery' }] };
  const out = _exportToDialplan(flow);
  assert.ok(out.includes('Unknown node type: mystery'), 'unknown node comment');
});

test('exportToDialplan — priorities increment across multiple nodes', () => {
  const flow = {
    ...baseFlow,
    nodes: [
      { type: 'play', file: 'greeting' },
      { type: 'hangup' },
    ],
  };
  const out = _exportToDialplan(flow);
  assert.ok(out.includes(',2,Playback('), 'first node at priority 2');
  assert.ok(out.includes(',3,Hangup()'), 'second node at priority 3');
});

test('exportToDialplan — nodes is null/non-array treated as empty', () => {
  const flow = { ...baseFlow, nodes: null };
  const out = _exportToDialplan(flow);
  assert.ok(out.includes('No nodes defined'), 'handles null nodes');
});

test('exportToDialplan — header contains flow name and client name', () => {
  const out = _exportToDialplan(baseFlow);
  assert.ok(out.includes('Test Flow'), 'flow name in header');
  assert.ok(out.includes('Acme Ltd'), 'client name in header');
});
