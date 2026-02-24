'use strict';

const router = require('express').Router();
const pool = require('../../config/database');
const { requireAuth } = require('../middleware/auth');
const { broadcast } = require('../../services/realtime');

router.use(requireAuth);

const VALID_STATUSES = ['available', 'out_of_office', 'annual_leave', 'meeting'];

// GET /api/clients/:clientId/availability
router.get('/:clientId/availability', async (req, res, next) => {
  try {
    const result = await pool.query(
      'SELECT * FROM client_availability WHERE client_id = $1',
      [req.params.clientId]
    );
    const avail = result.rows[0] || {
      client_id: req.params.clientId,
      status: 'available',
      note: null,
      updated_at: null,
    };
    res.json({ availability: avail });
  } catch (err) { next(err); }
});

// GET /api/availability — all clients availability (for dashboard)
router.get('/', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT ca.*, c.name AS client_name, c.account_number
       FROM client_availability ca
       JOIN clients c ON ca.client_id = c.id
       ORDER BY c.name ASC`
    );
    res.json({ availability: result.rows });
  } catch (err) { next(err); }
});

// PUT /api/clients/:clientId/availability
router.put('/:clientId/availability', async (req, res, next) => {
  try {
    const { status, note } = req.body;
    if (status && !VALID_STATUSES.includes(status)) {
      return res.status(400).json({ error: `Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}` });
    }
    const result = await pool.query(
      `INSERT INTO client_availability (client_id, status, note, updated_at)
       VALUES ($1, COALESCE($2, 'available'), $3, NOW())
       ON CONFLICT (client_id) DO UPDATE
         SET status     = COALESCE($2, client_availability.status),
             note       = $3,
             updated_at = NOW()
       RETURNING *`,
      [req.params.clientId, status || null, note || null]
    );
    const avail = result.rows[0];
    broadcast('client:availability', { client_id: req.params.clientId, availability: avail });
    res.json({ availability: avail });
  } catch (err) { next(err); }
});

module.exports = router;
