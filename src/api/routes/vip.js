'use strict';

const router = require('express').Router();
const pool = require('../../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');

router.use(requireAuth);

// ---- VIP Numbers ----

// GET /api/clients/:clientId/vip
router.get('/:clientId/vip', async (req, res, next) => {
  try {
    const result = await pool.query(
      'SELECT * FROM client_vip_numbers WHERE client_id = $1 ORDER BY created_at DESC',
      [req.params.clientId]
    );
    res.json({ vip: result.rows });
  } catch (err) { next(err); }
});

// POST /api/clients/:clientId/vip
router.post('/:clientId/vip', requireRole('admin', 'supervisor'), async (req, res, next) => {
  try {
    const { phone, label } = req.body;
    if (!phone) return res.status(400).json({ error: 'phone is required' });
    const result = await pool.query(
      'INSERT INTO client_vip_numbers (client_id, phone, label) VALUES ($1, $2, $3) RETURNING *',
      [req.params.clientId, phone, label || null]
    );
    res.status(201).json({ entry: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Number already in VIP list' });
    next(err);
  }
});

// DELETE /api/clients/:clientId/vip/:entryId
router.delete('/:clientId/vip/:entryId', requireRole('admin', 'supervisor'), async (req, res, next) => {
  try {
    await pool.query(
      'DELETE FROM client_vip_numbers WHERE id = $1 AND client_id = $2',
      [req.params.entryId, req.params.clientId]
    );
    res.json({ message: 'Removed from VIP list' });
  } catch (err) { next(err); }
});

// Lookup by phone: GET /api/clients/:clientId/vip/check/:phone
router.get('/:clientId/vip/check/:phone', async (req, res, next) => {
  try {
    const result = await pool.query(
      'SELECT * FROM client_vip_numbers WHERE client_id = $1 AND phone = $2',
      [req.params.clientId, req.params.phone]
    );
    res.json({ isVip: result.rows.length > 0, entry: result.rows[0] || null });
  } catch (err) { next(err); }
});

// ---- Ignore Numbers ----

// GET /api/clients/:clientId/ignore
router.get('/:clientId/ignore', async (req, res, next) => {
  try {
    const result = await pool.query(
      'SELECT * FROM client_ignore_numbers WHERE client_id = $1 ORDER BY created_at DESC',
      [req.params.clientId]
    );
    res.json({ ignore: result.rows });
  } catch (err) { next(err); }
});

// POST /api/clients/:clientId/ignore
router.post('/:clientId/ignore', requireRole('admin', 'supervisor'), async (req, res, next) => {
  try {
    const { phone, label } = req.body;
    if (!phone) return res.status(400).json({ error: 'phone is required' });
    const result = await pool.query(
      'INSERT INTO client_ignore_numbers (client_id, phone, label) VALUES ($1, $2, $3) RETURNING *',
      [req.params.clientId, phone, label || null]
    );
    res.status(201).json({ entry: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Number already in ignore list' });
    next(err);
  }
});

// DELETE /api/clients/:clientId/ignore/:entryId
router.delete('/:clientId/ignore/:entryId', requireRole('admin', 'supervisor'), async (req, res, next) => {
  try {
    await pool.query(
      'DELETE FROM client_ignore_numbers WHERE id = $1 AND client_id = $2',
      [req.params.entryId, req.params.clientId]
    );
    res.json({ message: 'Removed from ignore list' });
  } catch (err) { next(err); }
});

// Lookup by phone: GET /api/clients/:clientId/ignore/check/:phone
router.get('/:clientId/ignore/check/:phone', async (req, res, next) => {
  try {
    const result = await pool.query(
      'SELECT * FROM client_ignore_numbers WHERE client_id = $1 AND phone = $2',
      [req.params.clientId, req.params.phone]
    );
    res.json({ isIgnored: result.rows.length > 0, entry: result.rows[0] || null });
  } catch (err) { next(err); }
});

module.exports = router;
