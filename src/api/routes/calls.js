'use strict';

const router = require('express').Router();
const pool = require('../../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');

router.use(requireAuth);

// GET /api/calls
router.get('/', async (req, res, next) => {
  try {
    const { client_id, disposition, date_from, date_to, from, to, limit = 50, offset = 0, has_recording } = req.query;
    const rangeFrom = from || date_from;
    const rangeTo   = to   || date_to;

    let query = `
      SELECT cl.*, c.name AS client_name, o.full_name AS operator_name
      FROM call_logs cl
      LEFT JOIN clients c ON cl.client_id = c.id
      LEFT JOIN operators o ON cl.operator_id = o.id
      WHERE 1=1
    `;
    const params = [];

    if (client_id) {
      params.push(client_id);
      query += ` AND cl.client_id = $${params.length}`;
    }
    if (disposition) {
      params.push(disposition);
      query += ` AND cl.disposition = $${params.length}`;
    }
    if (rangeFrom) {
      params.push(rangeFrom);
      query += ` AND cl.call_start >= $${params.length}`;
    }
    if (rangeTo) {
      params.push(rangeTo);
      query += ` AND cl.call_start < ($${params.length}::date + INTERVAL '1 day')`;
    }
    if (has_recording === 'true') {
      query += ` AND cl.recording_url IS NOT NULL`;
    }

    // CSV export (admin/supervisor only)
    if (req.query.format === 'csv') {
      if (!['admin', 'supervisor'].includes(req.operator?.role)) {
        return res.status(403).json({ error: 'CSV export requires admin or supervisor role' });
      }
      const csvResult = await pool.query(query + ' ORDER BY cl.call_start DESC LIMIT 50000', params);
      const cols = ['id','client_name','caller_id_num','caller_id_name','did','call_start','call_answered','call_end','duration_seconds','disposition','operator_name'];
      const header = cols.join(',');
      const rows = csvResult.rows.map((r) => cols.map((c) => sanitizeCsv(r[c])).join(','));
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="calls.csv"');
      return res.send([header, ...rows].join('\r\n'));
    }

    const safeLimit  = Math.min(Math.max(1, parseInt(limit)  || 50), 500);
    const safeOffset = Math.max(0, parseInt(offset) || 0);
    params.push(safeLimit, safeOffset);
    query += ` ORDER BY cl.call_start DESC LIMIT $${params.length - 1} OFFSET $${params.length}`;

    const result = await pool.query(query, params);
    res.json({ calls: result.rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/calls/:id
router.get('/:id', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT cl.*, c.name AS client_name, o.full_name AS operator_name
       FROM call_logs cl
       LEFT JOIN clients c ON cl.client_id = c.id
       LEFT JOIN operators o ON cl.operator_id = o.id
       WHERE cl.id = $1`,
      [req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Call not found' });

    const messages = await pool.query(
      'SELECT * FROM messages WHERE call_log_id = $1',
      [req.params.id]
    );

    res.json({ call: result.rows[0], messages: messages.rows });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/calls/:id/disposition — update call disposition, notes, follow-up
router.patch('/:id/disposition', async (req, res, next) => {
  try {
    const { disposition, disposition_notes, follow_up_required, follow_up_at, is_billable } = req.body;
    const result = await pool.query(
      `UPDATE call_logs SET
         disposition       = COALESCE($1, disposition),
         disposition_notes = COALESCE($2, disposition_notes),
         follow_up_required = COALESCE($3, follow_up_required),
         follow_up_at      = COALESCE($4, follow_up_at),
         is_billable       = COALESCE($5, is_billable)
       WHERE id = $6
       RETURNING *`,
      [disposition, disposition_notes, follow_up_required, follow_up_at, is_billable, req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Call not found' });
    res.json({ call: result.rows[0] });
  } catch (err) { next(err); }
});

// GET /api/calls/follow-ups — calls requiring follow-up
router.get('/follow-ups/pending', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT cl.*, c.name AS client_name, o.full_name AS operator_name
       FROM call_logs cl
       LEFT JOIN clients c ON cl.client_id = c.id
       LEFT JOIN operators o ON cl.operator_id = o.id
       WHERE cl.follow_up_required = true
         AND cl.disposition != 'follow_up_completed'
       ORDER BY cl.follow_up_at ASC NULLS LAST`
    );
    res.json({ calls: result.rows });
  } catch (err) { next(err); }
});

// GET /api/calls/:id/recording — stream recording file
router.get('/:id/recording', async (req, res, next) => {
  try {
    const result = await pool.query('SELECT recording_url FROM call_logs WHERE id = $1', [req.params.id]);
    const row = result.rows[0];
    if (!row) return res.status(404).json({ error: 'Call not found' });
    if (!row.recording_url) return res.status(404).json({ error: 'No recording for this call' });

    const fs = require('fs');
    const path = require('path');
    const filePath = path.resolve(row.recording_url);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Recording file not found on disk' });

    const stat = fs.statSync(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const mimeType = ext === '.mp3' ? 'audio/mpeg' : 'audio/wav';

    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Content-Disposition', `attachment; filename="recording-${req.params.id}${ext}"`);
    fs.createReadStream(filePath).pipe(res);
  } catch (err) { next(err); }
});

// DELETE /api/calls/:id/recording — delete recording file (GDPR)
router.delete('/:id/recording', requireAuth, async (req, res, next) => {
  try {
    if (!['admin', 'supervisor'].includes(req.operator?.role)) {
      return res.status(403).json({ error: 'Admin or supervisor required' });
    }
    const result = await pool.query('SELECT recording_url FROM call_logs WHERE id = $1', [req.params.id]);
    const row = result.rows[0];
    if (!row) return res.status(404).json({ error: 'Call not found' });
    if (!row.recording_url) return res.status(404).json({ error: 'No recording to delete' });

    const fs = require('fs');
    const path = require('path');
    const filePath = path.resolve(row.recording_url);
    try { fs.unlinkSync(filePath); } catch { /* file may already be gone */ }

    await pool.query('UPDATE call_logs SET recording_url = NULL WHERE id = $1', [req.params.id]);
    res.json({ message: 'Recording deleted' });
  } catch (err) { next(err); }
});

// GET /api/calls/history/:callerNumber?client_id=... — call history for a specific caller
// client_id is required: history is scoped to one client to prevent cross-client data exposure
router.get('/history/:callerNumber', async (req, res, next) => {
  try {
    const { client_id } = req.query;
    if (!client_id) {
      return res.status(400).json({ error: 'client_id is required for caller history lookup' });
    }

    const result = await pool.query(
      `SELECT cl.*, c.name AS client_name, o.full_name AS operator_name
       FROM call_logs cl
       LEFT JOIN clients c ON cl.client_id = c.id
       LEFT JOIN operators o ON cl.operator_id = o.id
       WHERE cl.caller_id_num = $1 AND cl.client_id = $2
       ORDER BY cl.call_start DESC
       LIMIT 50`,
      [req.params.callerNumber, client_id]
    );
    const messages = await pool.query(
      `SELECT m.*, c.name AS client_name
       FROM messages m
       LEFT JOIN clients c ON m.client_id = c.id
       WHERE m.caller_phone = $1 AND m.client_id = $2
       ORDER BY m.created_at DESC
       LIMIT 50`,
      [req.params.callerNumber, client_id]
    );
    res.json({ calls: result.rows, messages: messages.rows });
  } catch (err) { next(err); }
});

// GET /api/calls/profile/:phone — unified cross-client caller profile
// Returns all calls, messages, and appointments for a given phone number (admin/supervisor only)
router.get('/profile/:phone', requireRole('admin', 'supervisor'), async (req, res, next) => {
  try {
    const phone = decodeURIComponent(req.params.phone);
    const [calls, messages, appointments, contacts] = await Promise.all([
      pool.query(
        `SELECT cl.*, c.name AS client_name, o.full_name AS operator_name
         FROM call_logs cl
         LEFT JOIN clients c ON cl.client_id = c.id
         LEFT JOIN operators o ON cl.operator_id = o.id
         WHERE cl.caller_id_num = $1
         ORDER BY cl.call_start DESC LIMIT 100`,
        [phone]
      ),
      pool.query(
        `SELECT m.id, m.subject, m.body, m.urgency, m.status, m.created_at,
                c.name AS client_name, o.full_name AS operator_name
         FROM messages m
         LEFT JOIN clients c ON m.client_id = c.id
         LEFT JOIN operators o ON m.operator_id = o.id
         WHERE m.caller_phone = $1
         ORDER BY m.created_at DESC LIMIT 100`,
        [phone]
      ),
      pool.query(
        `SELECT a.*, c.name AS client_name
         FROM appointments a
         LEFT JOIN clients c ON a.client_id = c.id
         WHERE a.caller_phone = $1
         ORDER BY a.starts_at DESC LIMIT 50`,
        [phone]
      ),
      pool.query(
        `SELECT ct.name, ct.email, ct.title, c.name AS client_name
         FROM contacts ct
         JOIN clients c ON ct.client_id = c.id
         WHERE ct.phone = $1 OR ct.sms_number = $1`,
        [phone]
      ),
    ]);
    res.json({
      phone,
      contacts:     contacts.rows,
      calls:        calls.rows,
      messages:     messages.rows,
      appointments: appointments.rows,
      summary: {
        total_calls:        calls.rowCount,
        total_messages:     messages.rowCount,
        total_appointments: appointments.rowCount,
      },
    });
  } catch (err) { next(err); }
});

function sanitizeCsv(v) {
  const s = String(v ?? '').replace(/"/g, '""');
  return /^[=+\-@\t\r]/.test(s) ? `"'${s}"` : `"${s}"`;
}

module.exports = router;
module.exports._sanitizeCsv = sanitizeCsv;
