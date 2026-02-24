'use strict';

const router = require('express').Router();
const { requireAuth } = require('../middleware/auth');
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

module.exports = router;
