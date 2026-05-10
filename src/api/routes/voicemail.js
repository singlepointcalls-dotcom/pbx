'use strict';

/**
 * Voicemail box management per client.
 * Actual voicemail recording handled by Asterisk (VoiceMail app).
 * This route manages the box definitions and stored message metadata.
 */

const router = require('express').Router();
const pool = require('../../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');

router.use(requireAuth);

// GET /api/voicemail — list voicemail boxes (admin/supervisor) or own client's box (operator)
router.get('/', async (req, res, next) => {
  try {
    const { client_id } = req.query;
    const isManager = ['admin', 'supervisor'].includes(req.operator.role);
    const params = [];
    let filter = 'WHERE 1=1';
    if (client_id && isManager) { params.push(client_id); filter += ` AND vb.client_id = $${params.length}`; }

    const result = await pool.query(
      `SELECT vb.*, c.name AS client_name
       FROM voicemail_boxes vb
       JOIN clients c ON vb.client_id = c.id
       ${filter}
       ORDER BY c.name, vb.mailbox_number`,
      params
    );
    res.json({ boxes: result.rows });
  } catch (err) { next(err); }
});

// GET /api/voicemail/:id — get a single voicemail box
router.get('/:id', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT vb.*, c.name AS client_name
       FROM voicemail_boxes vb
       JOIN clients c ON vb.client_id = c.id
       WHERE vb.id = $1`,
      [req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Voicemail box not found' });
    const box = { ...result.rows[0], pin: undefined }; // never expose PIN
    res.json({ box });
  } catch (err) { next(err); }
});

// POST /api/voicemail — create a voicemail box
router.post('/', requireRole('admin', 'supervisor'), async (req, res, next) => {
  try {
    const { client_id, mailbox_number, pin, greeting_url,
            max_message_seconds = 120, retention_days = 30, notify_email } = req.body;
    if (!client_id || !mailbox_number || !pin) {
      return res.status(400).json({ error: 'client_id, mailbox_number, and pin are required' });
    }
    if (!/^\d{3,10}$/.test(mailbox_number)) {
      return res.status(400).json({ error: 'mailbox_number must be 3–10 digits' });
    }
    if (!/^\d{4,8}$/.test(pin)) {
      return res.status(400).json({ error: 'pin must be 4–8 digits' });
    }
    const result = await pool.query(
      `INSERT INTO voicemail_boxes
         (client_id, mailbox_number, pin, greeting_url, max_message_seconds, retention_days, notify_email)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id, client_id, mailbox_number, greeting_url, max_message_seconds, retention_days, notify_email, created_at`,
      [client_id, mailbox_number, pin, greeting_url || null,
       max_message_seconds, retention_days, notify_email || null]
    );
    res.status(201).json({ box: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Mailbox number already exists' });
    next(err);
  }
});

// PUT /api/voicemail/:id — update voicemail box settings
router.put('/:id', requireRole('admin', 'supervisor'), async (req, res, next) => {
  try {
    const { pin, greeting_url, max_message_seconds, retention_days, notify_email } = req.body;
    if (pin && !/^\d{4,8}$/.test(pin)) {
      return res.status(400).json({ error: 'pin must be 4–8 digits' });
    }
    const result = await pool.query(
      `UPDATE voicemail_boxes SET
         pin                 = COALESCE($1, pin),
         greeting_url        = COALESCE($2, greeting_url),
         max_message_seconds = COALESCE($3, max_message_seconds),
         retention_days      = COALESCE($4, retention_days),
         notify_email        = COALESCE($5, notify_email)
       WHERE id = $6
       RETURNING id, client_id, mailbox_number, greeting_url, max_message_seconds, retention_days, notify_email`,
      [pin || null, greeting_url, max_message_seconds, retention_days, notify_email, req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Voicemail box not found' });
    res.json({ box: result.rows[0] });
  } catch (err) { next(err); }
});

// DELETE /api/voicemail/:id
router.delete('/:id', requireRole('admin'), async (req, res, next) => {
  try {
    await pool.query('DELETE FROM voicemail_boxes WHERE id = $1', [req.params.id]);
    res.json({ message: 'Voicemail box deleted' });
  } catch (err) { next(err); }
});

// GET /api/voicemail/:id/messages — list stored voicemail messages for a box
// (Messages are stored in call_logs where disposition='voicemail' and recording_url set)
router.get('/:id/messages', async (req, res, next) => {
  try {
    const boxResult = await pool.query('SELECT client_id FROM voicemail_boxes WHERE id = $1', [req.params.id]);
    if (!boxResult.rows[0]) return res.status(404).json({ error: 'Voicemail box not found' });

    const result = await pool.query(
      `SELECT cl.id, cl.caller_id_num, cl.caller_id_name, cl.call_start AS started_at,
              cl.duration_seconds, cl.recording_url, cl.recording_transcript,
              cl.transcript_summary, cl.read_at
       FROM call_logs cl
       WHERE cl.client_id = $1 AND cl.disposition = 'voicemail' AND cl.recording_url IS NOT NULL
       ORDER BY cl.call_start DESC
       LIMIT 100`,
      [boxResult.rows[0].client_id]
    );
    res.json({ messages: result.rows });
  } catch (err) { next(err); }
});

// PATCH /api/voicemail/:id/messages/:msgId/read — mark a voicemail message as read
router.patch('/:id/messages/:msgId/read', async (req, res, next) => {
  try {
    await pool.query(
      `UPDATE call_logs SET read_at = COALESCE(read_at, NOW()) WHERE id = $1`,
      [req.params.msgId]
    );
    res.json({ message: 'Marked as read' });
  } catch (err) { next(err); }
});

// DELETE /api/voicemail/:id/messages/:msgId — delete voicemail message + recording file (GDPR)
router.delete('/:id/messages/:msgId', requireRole('admin', 'supervisor'), async (req, res, next) => {
  try {
    const result = await pool.query(
      'SELECT recording_url FROM call_logs WHERE id = $1', [req.params.msgId]
    );
    const row = result.rows[0];
    if (!row) return res.status(404).json({ error: 'Message not found' });

    if (row.recording_url) {
      const fs = require('fs');
      const path = require('path');
      try { fs.unlinkSync(path.resolve(row.recording_url)); } catch { /* file may be gone */ }
    }
    await pool.query(
      'UPDATE call_logs SET recording_url = NULL, disposition = $1 WHERE id = $2',
      ['voicemail_deleted', req.params.msgId]
    );
    res.json({ message: 'Voicemail message deleted' });
  } catch (err) { next(err); }
});

module.exports = router;
