'use strict';

const router = require('express').Router();
const pool = require('../../config/database');
const { requireAuth } = require('../middleware/auth');

router.use(requireAuth);

// GET /api/calls
router.get('/', async (req, res, next) => {
  try {
    const { client_id, disposition, date_from, date_to, limit = 50, offset = 0 } = req.query;

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
    if (date_from) {
      params.push(date_from);
      query += ` AND cl.call_start >= $${params.length}`;
    }
    if (date_to) {
      params.push(date_to);
      query += ` AND cl.call_start <= $${params.length}`;
    }

    // CSV export (admin/supervisor only, capped at 50k rows)
    if (req.query.format === 'csv') {
      if (!['admin', 'supervisor'].includes(req.operator?.role)) {
        return res.status(403).json({ error: 'CSV export requires admin or supervisor role' });
      }
      const csvResult = await pool.query(query + ' ORDER BY cl.call_start DESC LIMIT 50000', params);
      const cols = ['id','client_name','caller_id_num','caller_id_name','did','call_start','call_answered','call_end','duration_seconds','disposition','operator_name'];
      const header = cols.join(',');
      // Prefix cells that start with formula chars to prevent CSV injection
      const sanitizeCsv = (v) => {
        const s = String(v ?? '').replace(/"/g, '""');
        return /^[=+\-@\t\r]/.test(s) ? `"'${s}"` : `"${s}"`;
      };
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

// GET /api/calls/history/:callerNumber — call history for a specific caller
router.get('/history/:callerNumber', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT cl.*, c.name AS client_name, o.full_name AS operator_name
       FROM call_logs cl
       LEFT JOIN clients c ON cl.client_id = c.id
       LEFT JOIN operators o ON cl.operator_id = o.id
       WHERE cl.caller_id_num = $1
       ORDER BY cl.call_start DESC
       LIMIT 50`,
      [req.params.callerNumber]
    );
    const messages = await pool.query(
      `SELECT m.*, c.name AS client_name
       FROM messages m
       LEFT JOIN clients c ON m.client_id = c.id
       WHERE m.caller_phone = $1
       ORDER BY m.created_at DESC
       LIMIT 50`,
      [req.params.callerNumber]
    );
    res.json({ calls: result.rows, messages: messages.rows });
  } catch (err) { next(err); }
});

module.exports = router;
