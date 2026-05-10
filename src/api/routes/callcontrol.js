'use strict';

const router = require('express').Router();
const { requireAuth, requireRole } = require('../middleware/auth');
const { answerCall, holdCall, unholdCall, transferCall, hangupCall, getActiveCalls, originateOutbound } = require('../../asterisk/ari');

router.use(requireAuth);

// GET /api/callcontrol/active
router.get('/active', (_req, res) => {
  res.json({ calls: getActiveCalls() });
});

// POST /api/callcontrol/:channelId/answer
router.post('/:channelId/answer', async (req, res, next) => {
  try {
    const { extension } = req.body;
    if (!extension) return res.status(400).json({ error: 'extension is required' });
    const result = await answerCall(req.params.channelId, extension);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/callcontrol/:channelId/transfer
router.post('/:channelId/transfer', async (req, res, next) => {
  try {
    const { extension } = req.body;
    if (!extension) return res.status(400).json({ error: 'extension is required' });
    await transferCall(req.params.channelId, extension);
    res.json({ message: 'Transfer initiated' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/callcontrol/:channelId/hold
router.post('/:channelId/hold', async (req, res, next) => {
  try {
    await holdCall(req.params.channelId);
    res.json({ message: 'Call placed on hold' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/callcontrol/:channelId/unhold
router.post('/:channelId/unhold', async (req, res, next) => {
  try {
    await unholdCall(req.params.channelId);
    res.json({ message: 'Call taken off hold' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/callcontrol/:channelId/hangup
router.post('/:channelId/hangup', async (req, res, next) => {
  try {
    await hangupCall(req.params.channelId);
    res.json({ message: 'Call hung up' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/callcontrol/originate — outbound call
router.post('/originate', async (req, res, next) => {
  try {
    const { extension, destination, client_id } = req.body;
    if (!extension || !destination) return res.status(400).json({ error: 'extension and destination are required' });
    const result = await originateOutbound(extension, destination, client_id || null);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Live call monitoring (supervisor features) ────────────────────────────
// These require ARI — return 503 if Asterisk is not connected.

const ari = require('../../asterisk/ari');

function ariRequired(res) {
  res.status(503).json({ error: 'Asterisk ARI not connected — live monitoring unavailable' });
}

// POST /api/callcontrol/:channelId/monitor — supervisor silently listens to a call
router.post('/:channelId/monitor', requireRole('admin', 'supervisor'), async (req, res) => {
  try {
    const { extension } = req.body;
    if (!extension) return res.status(400).json({ error: 'extension is required' });
    if (!ari.isConnected()) return ariRequired(res);
    // Originate a channel to the supervisor's extension that snoops on the target
    const result = await ari.originateOutbound(extension, `ChanSpy/${req.params.channelId}`, null);
    res.json({ message: 'Monitoring started', result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/callcontrol/:channelId/whisper — supervisor speaks only to operator (not caller)
router.post('/:channelId/whisper', requireRole('admin', 'supervisor'), async (req, res) => {
  try {
    const { extension } = req.body;
    if (!extension) return res.status(400).json({ error: 'extension is required' });
    if (!ari.isConnected()) return ariRequired(res);
    // ChanSpy with 'w' flag = whisper mode
    const result = await ari.originateOutbound(extension, `ChanSpy/${req.params.channelId},w`, null);
    res.json({ message: 'Whisper mode started', result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/callcontrol/:channelId/barge — supervisor joins the call (three-way)
router.post('/:channelId/barge', requireRole('admin', 'supervisor'), async (req, res) => {
  try {
    const { extension } = req.body;
    if (!extension) return res.status(400).json({ error: 'extension is required' });
    if (!ari.isConnected()) return ariRequired(res);
    // ChanSpy with 'B' flag = barge mode (two-way)
    const result = await ari.originateOutbound(extension, `ChanSpy/${req.params.channelId},B`, null);
    res.json({ message: 'Barge started', result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
