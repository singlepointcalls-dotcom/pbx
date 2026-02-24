'use strict';

const router = require('express').Router();
const pool = require('../../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');

// All client routes require authentication
router.use(requireAuth);

// GET /api/clients
router.get('/', async (req, res, next) => {
  try {
    const { search, active } = req.query;
    let query = 'SELECT * FROM clients WHERE 1=1';
    const params = [];

    if (active !== undefined) {
      params.push(active === 'true');
      query += ` AND is_active = $${params.length}`;
    }
    if (search) {
      params.push(`%${search}%`);
      query += ` AND (name ILIKE $${params.length} OR account_number ILIKE $${params.length})`;
    }
    query += ' ORDER BY name ASC';

    const result = await pool.query(query, params);
    res.json({ clients: result.rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/clients/:id
router.get('/:id', async (req, res, next) => {
  try {
    const result = await pool.query('SELECT * FROM clients WHERE id = $1', [req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ error: 'Client not found' });
    res.json({ client: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// POST /api/clients
router.post('/', requireRole('admin', 'supervisor'), async (req, res, next) => {
  try {
    const { name, account_number, dids = [], script, greeting, timezone = 'America/New_York', notes } = req.body;
    if (!name || !account_number) {
      return res.status(400).json({ error: 'name and account_number are required' });
    }

    const result = await pool.query(
      `INSERT INTO clients (name, account_number, dids, script, greeting, timezone, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [name, account_number, dids, script, greeting, timezone, notes]
    );
    res.status(201).json({ client: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Account number already exists' });
    next(err);
  }
});

// PUT /api/clients/:id
router.put('/:id', requireRole('admin', 'supervisor'), async (req, res, next) => {
  try {
    const { name, dids, script, greeting, timezone, is_active, notes } = req.body;
    const result = await pool.query(
      `UPDATE clients SET
         name = COALESCE($1, name),
         dids = COALESCE($2, dids),
         script = COALESCE($3, script),
         greeting = COALESCE($4, greeting),
         timezone = COALESCE($5, timezone),
         is_active = COALESCE($6, is_active),
         notes = COALESCE($7, notes)
       WHERE id = $8
       RETURNING *`,
      [name, dids, script, greeting, timezone, is_active, notes, req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Client not found' });
    res.json({ client: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/clients/:id (deactivate)
router.delete('/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query(
      'UPDATE clients SET is_active = false WHERE id = $1 RETURNING id',
      [req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Client not found' });
    res.json({ message: 'Client deactivated' });
  } catch (err) {
    next(err);
  }
});

// GET /api/clients/by-did/:did — used by ARI to look up client from inbound DID
router.get('/by-did/:did', async (req, res, next) => {
  try {
    const result = await pool.query(
      'SELECT * FROM clients WHERE $1 = ANY(dids) AND is_active = true',
      [req.params.did]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'No client for this DID' });
    res.json({ client: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
