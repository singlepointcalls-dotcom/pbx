'use strict';

const router = require('express').Router();
const pool = require('../../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const { broadcast } = require('../../services/realtime');
const audit = require('../../services/audit');

router.use(requireAuth);

// ── Campaigns ──────────────────────────────────────────────────────────────

// GET /api/callbacks — list campaigns
router.get('/', async (req, res, next) => {
  try {
    const { client_id, status } = req.query;
    const params = [];
    let where = 'WHERE 1=1';
    if (client_id) { params.push(client_id); where += ` AND cc.client_id = $${params.length}`; }
    if (status)    { params.push(status);    where += ` AND cc.status = $${params.length}`; }

    const result = await pool.query(
      `SELECT cc.*, c.name AS client_name,
              COUNT(cr.id)                                            AS total_records,
              COUNT(cr.id) FILTER (WHERE cr.status = 'pending')      AS pending_count,
              COUNT(cr.id) FILTER (WHERE cr.status = 'completed')    AS completed_count,
              COUNT(cr.id) FILTER (WHERE cr.status = 'failed')       AS failed_count
       FROM callback_campaigns cc
       JOIN clients c ON cc.client_id = c.id
       LEFT JOIN callback_records cr ON cr.campaign_id = cc.id
       ${where}
       GROUP BY cc.id, c.name
       ORDER BY cc.created_at DESC`,
      params
    );
    res.json({ campaigns: result.rows });
  } catch (err) { next(err); }
});

// GET /api/callbacks/:id
router.get('/:id', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT cc.*, c.name AS client_name
       FROM callback_campaigns cc
       JOIN clients c ON cc.client_id = c.id
       WHERE cc.id = $1`,
      [req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Campaign not found' });
    res.json({ campaign: result.rows[0] });
  } catch (err) { next(err); }
});

// POST /api/callbacks — create campaign
router.post('/', requireRole('admin', 'supervisor'), async (req, res, next) => {
  try {
    const { client_id, name, description, script, from_number, max_attempts = 3, retry_interval_minutes = 60 } = req.body;
    if (!client_id || !name) return res.status(400).json({ error: 'client_id and name are required' });

    const result = await pool.query(
      `INSERT INTO callback_campaigns
         (client_id, name, description, script, from_number, max_attempts, retry_interval_minutes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [client_id, name, description || null, script || null, from_number || null,
       parseInt(max_attempts), parseInt(retry_interval_minutes), req.operator.id]
    );
    await audit.log(req, 'callback_campaign.create', { resourceId: result.rows[0].id });
    res.status(201).json({ campaign: result.rows[0] });
  } catch (err) { next(err); }
});

// PUT /api/callbacks/:id
router.put('/:id', requireRole('admin', 'supervisor'), async (req, res, next) => {
  try {
    const { name, description, script, from_number, max_attempts, retry_interval_minutes, status } = req.body;
    const VALID = ['draft', 'active', 'paused', 'completed', 'cancelled'];
    if (status && !VALID.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${VALID.join(', ')}` });
    }

    const result = await pool.query(
      `UPDATE callback_campaigns SET
         name                   = COALESCE($1, name),
         description            = COALESCE($2, description),
         script                 = COALESCE($3, script),
         from_number            = COALESCE($4, from_number),
         max_attempts           = COALESCE($5, max_attempts),
         retry_interval_minutes = COALESCE($6, retry_interval_minutes),
         status                 = COALESCE($7, status)
       WHERE id = $8
       RETURNING *`,
      [name||null, description||null, script||null, from_number||null,
       max_attempts ? parseInt(max_attempts) : null,
       retry_interval_minutes ? parseInt(retry_interval_minutes) : null,
       status||null, req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Campaign not found' });
    await audit.log(req, 'callback_campaign.update', { resourceId: req.params.id });
    res.json({ campaign: result.rows[0] });
  } catch (err) { next(err); }
});

// DELETE /api/callbacks/:id
router.delete('/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query(
      'DELETE FROM callback_campaigns WHERE id = $1 RETURNING id',
      [req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Campaign not found' });
    await audit.log(req, 'callback_campaign.delete', { resourceId: req.params.id });
    res.json({ message: 'Campaign deleted' });
  } catch (err) { next(err); }
});

// ── Campaign records ────────────────────────────────────────────────────────

// GET /api/callbacks/:id/records
router.get('/:id/records', async (req, res, next) => {
  try {
    const { status } = req.query;
    const params = [req.params.id];
    let filter = '';
    if (status) { params.push(status); filter = ` AND cr.status = $${params.length}`; }

    const result = await pool.query(
      `SELECT cr.*, o.full_name AS operator_name
       FROM callback_records cr
       LEFT JOIN operators o ON cr.operator_id = o.id
       WHERE cr.campaign_id = $1 ${filter}
       ORDER BY cr.created_at ASC`,
      params
    );
    res.json({ records: result.rows });
  } catch (err) { next(err); }
});

// POST /api/callbacks/:id/records — add one or more numbers
router.post('/:id/records', requireRole('admin', 'supervisor'), async (req, res, next) => {
  try {
    // Accept a single record or array
    const entries = Array.isArray(req.body) ? req.body : [req.body];
    if (entries.length === 0) return res.status(400).json({ error: 'No records provided' });
    if (entries.length > 1000) return res.status(400).json({ error: 'Max 1000 records per request' });

    // Verify campaign exists
    const camp = await pool.query('SELECT id FROM callback_campaigns WHERE id = $1', [req.params.id]);
    if (!camp.rows[0]) return res.status(404).json({ error: 'Campaign not found' });

    const inserted = [];
    for (const entry of entries) {
      if (!entry.phone_number) continue;
      const r = await pool.query(
        `INSERT INTO callback_records (campaign_id, phone_number, caller_name, notes)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [req.params.id, entry.phone_number, entry.caller_name || null, entry.notes || null]
      );
      inserted.push(r.rows[0]);
    }
    res.status(201).json({ records: inserted, count: inserted.length });
  } catch (err) { next(err); }
});

// PUT /api/callbacks/records/:recordId — update a record (log attempt, set outcome)
router.put('/records/:recordId', async (req, res, next) => {
  try {
    const { status, outcome_notes, next_attempt_at } = req.body;
    const VALID = ['pending', 'in_progress', 'completed', 'failed', 'opted_out'];
    if (status && !VALID.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${VALID.join(', ')}` });
    }

    const result = await pool.query(
      `UPDATE callback_records SET
         status          = COALESCE($1, status),
         outcome_notes   = COALESCE($2, outcome_notes),
         next_attempt_at = COALESCE($3::timestamptz, next_attempt_at),
         attempts        = CASE WHEN $1 IN ('completed','failed') THEN attempts + 1 ELSE attempts END,
         last_attempt_at = CASE WHEN $1 IN ('completed','failed') THEN NOW() ELSE last_attempt_at END,
         completed_at    = CASE WHEN $1 = 'completed' THEN NOW() ELSE completed_at END,
         operator_id     = COALESCE($4, operator_id)
       WHERE id = $5
       RETURNING *`,
      [status || null, outcome_notes || null, next_attempt_at || null, req.operator.id, req.params.recordId]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Record not found' });

    broadcast('callback:record_updated', { record: result.rows[0] });
    res.json({ record: result.rows[0] });
  } catch (err) { next(err); }
});

// GET /api/callbacks/next — get next pending record for operator to call
router.get('/queue/next', async (req, res, next) => {
  try {
    const { campaign_id } = req.query;
    if (!campaign_id) return res.status(400).json({ error: 'campaign_id is required' });

    const result = await pool.query(
      `UPDATE callback_records SET status = 'in_progress', operator_id = $1, last_attempt_at = NOW()
       WHERE id = (
         SELECT id FROM callback_records
         WHERE campaign_id = $2
           AND status = 'pending'
           AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())
         ORDER BY created_at ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING *`,
      [req.operator.id, campaign_id]
    );
    if (!result.rows[0]) return res.json({ record: null, message: 'No records available' });
    res.json({ record: result.rows[0] });
  } catch (err) { next(err); }
});

// POST /api/callbacks/direct — schedule a one-off callback from an existing message
// Creates a callback_record directly (source='direct') without requiring a campaign.
router.post('/direct', async (req, res, next) => {
  try {
    const { phone_number, caller_name, client_id, notes, message_id, scheduled_for } = req.body;
    if (!phone_number) return res.status(400).json({ error: 'phone_number is required' });

    const result = await pool.query(
      `INSERT INTO callback_records
         (phone_number, caller_name, client_id, notes, source, status, scheduled_for)
       VALUES ($1, $2, $3, $4, 'direct', 'pending', $5)
       RETURNING *`,
      [phone_number, caller_name || null, client_id || null, notes || null, scheduled_for || null]
    );
    const record = result.rows[0];

    // Link message to callback record if provided
    if (message_id) {
      await pool.query(
        'UPDATE messages SET disposition_notes = COALESCE(disposition_notes, \'\') || $1 WHERE id = $2',
        [`\n[Callback scheduled: ${phone_number}]`, message_id]
      ).catch(() => { /* non-fatal */ });
    }

    await audit.log(req, 'callback.direct', { resourceId: record.id, phone_number });
    broadcast('callback:scheduled', { record });
    res.status(201).json({ record });
  } catch (err) { next(err); }
});

module.exports = router;
