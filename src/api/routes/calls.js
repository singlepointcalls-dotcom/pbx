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

    params.push(parseInt(limit), parseInt(offset));
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

module.exports = router;
