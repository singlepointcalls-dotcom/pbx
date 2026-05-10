'use strict';

const router = require('express').Router();
const { requireAuth, requireRole } = require('../middleware/auth');
const { answerCall, holdCall, unholdCall, transferCall, hangupCall, getActiveCalls, originateOutbound } = require('../../asterisk/ari');
const audit = require('../../services/audit');
const pool  = require('../../config/database');

router.use(requireAuth);

// GET /api/callcontrol/active
router.get('/active', (_req, res) => {
  res.json({ calls: getActiveCalls() });
});

// POST /api/callcontrol/:channelId/answer
router.post('/:channelId/answer', async (req, res) => {
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
router.post('/:channelId/transfer', async (req, res) => {
  try {
    const { extension } = req.body;
    if (!extension) return res.status(400).json({ error: 'extension is required' });
    await transferCall(req.params.channelId, extension);
    audit.log(req, 'call.transfer', { channelId: req.params.channelId, details: { extension } });
    res.json({ message: 'Transfer initiated' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/callcontrol/:channelId/hold
router.post('/:channelId/hold', async (req, res) => {
  try {
    await holdCall(req.params.channelId);
    res.json({ message: 'Call placed on hold' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/callcontrol/:channelId/unhold
router.post('/:channelId/unhold', async (req, res) => {
  try {
    await unholdCall(req.params.channelId);
    res.json({ message: 'Call taken off hold' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/callcontrol/:channelId/hangup
router.post('/:channelId/hangup', async (req, res) => {
  try {
    await hangupCall(req.params.channelId);
    res.json({ message: 'Call hung up' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/callcontrol/originate — outbound call
router.post('/originate', async (req, res) => {
  try {
    const { extension, destination, client_id } = req.body;
    if (!extension || !destination) return res.status(400).json({ error: 'extension and destination are required' });
    const result = await originateOutbound(extension, destination, client_id || null);
    audit.log(req, 'call.originate', { details: { extension, destination } });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Live call monitoring (supervisor features) ────────────────────────────
const ari = require('../../asterisk/ari');

function ariRequired(res) {
  res.status(503).json({ error: 'Asterisk ARI not connected — live monitoring unavailable' });
}

// POST /api/callcontrol/:channelId/monitor — supervisor silently listens
router.post('/:channelId/monitor', requireRole('admin', 'supervisor'), async (req, res) => {
  try {
    const { extension } = req.body;
    if (!extension) return res.status(400).json({ error: 'extension is required' });
    if (!ari.isConnected()) return ariRequired(res);
    const result = await ari.originateOutbound(extension, `ChanSpy/${req.params.channelId}`, null);
    audit.log(req, 'call.monitor', { channelId: req.params.channelId, details: { extension, mode: 'listen' } });
    res.json({ message: 'Monitoring started', result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/callcontrol/:channelId/whisper — supervisor speaks to operator only
router.post('/:channelId/whisper', requireRole('admin', 'supervisor'), async (req, res) => {
  try {
    const { extension } = req.body;
    if (!extension) return res.status(400).json({ error: 'extension is required' });
    if (!ari.isConnected()) return ariRequired(res);
    const result = await ari.originateOutbound(extension, `ChanSpy/${req.params.channelId},w`, null);
    audit.log(req, 'call.whisper', { channelId: req.params.channelId, details: { extension } });
    res.json({ message: 'Whisper mode started', result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/callcontrol/:channelId/barge — supervisor joins call (three-way)
router.post('/:channelId/barge', requireRole('admin', 'supervisor'), async (req, res) => {
  try {
    const { extension } = req.body;
    if (!extension) return res.status(400).json({ error: 'extension is required' });
    if (!ari.isConnected()) return ariRequired(res);
    const result = await ari.originateOutbound(extension, `ChanSpy/${req.params.channelId},B`, null);
    audit.log(req, 'call.barge', { channelId: req.params.channelId, details: { extension } });
    res.json({ message: 'Barge started', result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Conference bridge ────────────────────────────────────────────────────
// POST /api/callcontrol/:channelId/conference — add a third party to an active call
router.post('/:channelId/conference', async (req, res) => {
  try {
    const { extension } = req.body;
    if (!extension) return res.status(400).json({ error: 'extension is required' });
    if (!ari.isConnected()) return ariRequired(res);

    const result = await ari.conferenceAdd(req.params.channelId, extension);
    audit.log(req, 'call.conference_add', { channelId: req.params.channelId, details: { extension } });
    res.json({ message: 'Conference party added', result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// GET /api/callcontrol/conferences — list active conference sessions
router.get('/conferences', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT cs.*, o.username AS initiator_username
         FROM conference_sessions cs
         LEFT JOIN operators o ON o.id = cs.initiator_id
        WHERE cs.ended_at IS NULL
        ORDER BY cs.started_at DESC`
    );
    res.json({ conferences: result.rows });
  } catch (err) { next(err); }
});

module.exports = router;
