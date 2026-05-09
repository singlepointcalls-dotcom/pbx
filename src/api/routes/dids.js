'use strict';

const router = require('express').Router();
const pool = require('../../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const audit = require('../../services/audit');

router.use(requireAuth);

// GET /api/dids
router.get('/', async (req, res, next) => {
  try {
    const { client_id, active, unassigned } = req.query;
    const params = [];
    let where = 'WHERE 1=1';
    if (client_id)            { params.push(client_id); where += ` AND d.client_id = $${params.length}`; }
    if (active === 'true')      where += ' AND d.is_active = true';
    if (active === 'false')     where += ' AND d.is_active = false';
    if (unassigned === 'true')  where += ' AND d.client_id IS NULL';

    const result = await pool.query(
      `SELECT d.*, c.name AS client_name
       FROM did_numbers d
       LEFT JOIN clients c ON d.client_id = c.id
       ${where}
       ORDER BY d.number ASC`,
      params
    );
    res.json({ dids: result.rows });
  } catch (err) { next(err); }
});

// GET /api/dids/lookup/:number — look up by phone number
router.get('/lookup/:number', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT d.*, c.name AS client_name, c.greeting AS client_greeting
       FROM did_numbers d
       LEFT JOIN clients c ON d.client_id = c.id
       WHERE d.number = $1`,
      [req.params.number]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'DID not found' });
    res.json({ did: result.rows[0] });
  } catch (err) { next(err); }
});

// POST /api/dids
router.post('/', requireRole('admin', 'supervisor'), async (req, res, next) => {
  try {
    const {
      number, label, client_id, greeting_override, routing_profile,
      provider, provider_sid, monthly_cost, notes,
    } = req.body;
    if (!number) return res.status(400).json({ error: 'number is required' });

    const result = await pool.query(
      `INSERT INTO did_numbers
         (number, label, client_id, greeting_override, routing_profile,
          provider, provider_sid, monthly_cost, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [number, label || null, client_id || null, greeting_override || null,
       routing_profile || null, provider || null, provider_sid || null,
       monthly_cost || null, notes || null]
    );

    // Also append to clients.dids array if client_id given
    if (client_id) {
      await pool.query(
        `UPDATE clients SET dids = ARRAY(SELECT DISTINCT UNNEST(dids || $1::text[]))
         WHERE id = $2`,
        [[number], client_id]
      );
    }

    await audit.log(req, 'did.create', { resourceId: result.rows[0].id, number });
    res.status(201).json({ did: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'DID already exists' });
    next(err);
  }
});

// PUT /api/dids/:id
router.put('/:id', requireRole('admin', 'supervisor'), async (req, res, next) => {
  try {
    const {
      label, client_id, greeting_override, routing_profile,
      provider, provider_sid, monthly_cost, is_active, notes,
    } = req.body;

    // Capture old client_id to update clients.dids array on change
    const oldRow = await pool.query('SELECT number, client_id FROM did_numbers WHERE id = $1', [req.params.id]);
    if (!oldRow.rows[0]) return res.status(404).json({ error: 'DID not found' });

    const result = await pool.query(
      `UPDATE did_numbers SET
         label             = COALESCE($1, label),
         client_id         = COALESCE($2, client_id),
         greeting_override = COALESCE($3, greeting_override),
         routing_profile   = COALESCE($4, routing_profile),
         provider          = COALESCE($5, provider),
         provider_sid      = COALESCE($6, provider_sid),
         monthly_cost      = COALESCE($7, monthly_cost),
         is_active         = COALESCE($8, is_active),
         notes             = COALESCE($9, notes),
         updated_at        = NOW()
       WHERE id = $10 RETURNING *`,
      [label||null, client_id||null, greeting_override||null, routing_profile||null,
       provider||null, provider_sid||null, monthly_cost||null,
       is_active !== undefined ? is_active : null,
       notes||null, req.params.id]
    );

    // Sync clients.dids array on client change
    if (client_id && client_id !== oldRow.rows[0].client_id) {
      const number = oldRow.rows[0].number;
      // Remove from old client
      if (oldRow.rows[0].client_id) {
        await pool.query(
          `UPDATE clients SET dids = ARRAY(SELECT UNNEST(dids) EXCEPT SELECT $1) WHERE id = $2`,
          [number, oldRow.rows[0].client_id]
        );
      }
      // Add to new client
      await pool.query(
        `UPDATE clients SET dids = ARRAY(SELECT DISTINCT UNNEST(dids || $1::text[])) WHERE id = $2`,
        [[number], client_id]
      );
    }

    await audit.log(req, 'did.update', { resourceId: req.params.id });
    res.json({ did: result.rows[0] });
  } catch (err) { next(err); }
});

// DELETE /api/dids/:id
router.delete('/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const old = await pool.query('SELECT number, client_id FROM did_numbers WHERE id = $1', [req.params.id]);
    if (!old.rows[0]) return res.status(404).json({ error: 'DID not found' });

    await pool.query('DELETE FROM did_numbers WHERE id = $1', [req.params.id]);

    // Remove from clients.dids array
    if (old.rows[0].client_id) {
      await pool.query(
        `UPDATE clients SET dids = ARRAY(SELECT UNNEST(dids) EXCEPT SELECT $1) WHERE id = $2`,
        [old.rows[0].number, old.rows[0].client_id]
      );
    }

    await audit.log(req, 'did.delete', { resourceId: req.params.id });
    res.json({ message: 'DID deleted' });
  } catch (err) { next(err); }
});

module.exports = router;
