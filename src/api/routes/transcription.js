'use strict';

const router = require('express').Router();
const pool = require('../../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const transcription = require('../../services/transcription');

router.use(requireAuth);

// POST /api/transcription/call/:callLogId — transcribe a single call recording
router.post('/call/:callLogId', requireRole('admin', 'supervisor', 'operator'), async (req, res, next) => {
  try {
    const r = await pool.query('SELECT id, recording_url, recording_transcript FROM call_logs WHERE id = $1',
      [req.params.callLogId]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Call log not found' });
    if (!r.rows[0].recording_url) return res.status(400).json({ error: 'No recording URL on this call' });
    if (r.rows[0].recording_transcript) {
      return res.json({ status: 'already_transcribed', transcript: r.rows[0].recording_transcript });
    }

    const result = await transcription.transcribeCall(req.params.callLogId, r.rows[0].recording_url);
    res.json({ status: 'ok', ...result });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// POST /api/transcription/batch — transcribe all pending recordings (admin only)
router.post('/batch', requireRole('admin'), async (req, res, next) => {
  try {
    const limit = parseInt(req.body.limit || '5');
    const count = await transcription.transcribePending(limit);
    res.json({ transcribed: count });
  } catch (err) { next(err); }
});

// GET /api/transcription/call/:callLogId — fetch transcript
router.get('/call/:callLogId', async (req, res, next) => {
  try {
    const r = await pool.query(
      `SELECT id, recording_url, recording_transcript, transcript_summary, transcribed_at
       FROM call_logs WHERE id = $1`,
      [req.params.callLogId]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Call log not found' });
    res.json(r.rows[0]);
  } catch (err) { next(err); }
});

module.exports = router;
