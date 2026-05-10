'use strict';

/**
 * Operator-to-client assignment management (admin only).
 *
 * Operators with the 'admin' or 'supervisor' role always see ALL clients.
 * 'operator' role: if they have assignments, they only see assigned clients.
 *                  if no assignments, they see all clients (default open).
 *
 * GET    /api/operator-clients/:operatorId  — list assigned clients
 * PUT    /api/operator-clients/:operatorId  — replace assignment set
 * POST   /api/operator-clients/:operatorId/:clientId — add one
 * DELETE /api/operator-clients/:operatorId/:clientId — remove one
 */

const router = require('express').Router();
const pool   = require('../../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');

router.use(requireAuth, requireRole('admin'));

// GET /api/operator-clients/:operatorId
router.get('/:operatorId', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT c.id, c.name, c.account_number, c.is_active
       FROM operator_client_assignments oca
       JOIN clients c ON oca.client_id = c.id
       WHERE oca.operator_id = $1
       ORDER BY c.name`,
      [req.params.operatorId]
    );
    res.json({ clients: result.rows });
  } catch (err) { next(err); }
});

// PUT /api/operator-clients/:operatorId — replace full assignment set
router.put('/:operatorId', async (req, res, next) => {
  try {
    const { client_ids } = req.body; // array of client UUIDs
    if (!Array.isArray(client_ids)) {
      return res.status(400).json({ error: 'client_ids array is required' });
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'DELETE FROM operator_client_assignments WHERE operator_id = $1',
        [req.params.operatorId]
      );
      if (client_ids.length) {
        await client.query(
          `INSERT INTO operator_client_assignments (operator_id, client_id)
           SELECT $1, unnest($2::uuid[])
           ON CONFLICT DO NOTHING`,
          [req.params.operatorId, client_ids]
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    res.json({ ok: true, count: client_ids.length });
  } catch (err) { next(err); }
});

// POST /api/operator-clients/:operatorId/:clientId
router.post('/:operatorId/:clientId', async (req, res, next) => {
  try {
    await pool.query(
      `INSERT INTO operator_client_assignments (operator_id, client_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [req.params.operatorId, req.params.clientId]
    );
    res.status(201).json({ ok: true });
  } catch (err) { next(err); }
});

// DELETE /api/operator-clients/:operatorId/:clientId
router.delete('/:operatorId/:clientId', async (req, res, next) => {
  try {
    await pool.query(
      'DELETE FROM operator_client_assignments WHERE operator_id = $1 AND client_id = $2',
      [req.params.operatorId, req.params.clientId]
    );
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
