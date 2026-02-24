'use strict';

const router = require('express').Router();
const pool = require('../../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');

router.use(requireAuth);

// GET /api/clients/:clientId/departments
router.get('/:clientId/departments', async (req, res, next) => {
  try {
    const result = await pool.query(
      'SELECT * FROM departments WHERE client_id = $1 ORDER BY name ASC',
      [req.params.clientId]
    );
    res.json({ departments: result.rows });
  } catch (err) { next(err); }
});

// POST /api/clients/:clientId/departments
router.post('/:clientId/departments', requireRole('admin', 'supervisor'), async (req, res, next) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    const result = await pool.query(
      'INSERT INTO departments (client_id, name) VALUES ($1, $2) RETURNING *',
      [req.params.clientId, name]
    );
    res.status(201).json({ department: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Department name already exists for this client' });
    next(err);
  }
});

// PUT /api/clients/:clientId/departments/:deptId
router.put('/:clientId/departments/:deptId', requireRole('admin', 'supervisor'), async (req, res, next) => {
  try {
    const { name } = req.body;
    const result = await pool.query(
      'UPDATE departments SET name = COALESCE($1, name) WHERE id = $2 AND client_id = $3 RETURNING *',
      [name, req.params.deptId, req.params.clientId]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Department not found' });
    res.json({ department: result.rows[0] });
  } catch (err) { next(err); }
});

// DELETE /api/clients/:clientId/departments/:deptId
router.delete('/:clientId/departments/:deptId', requireRole('admin', 'supervisor'), async (req, res, next) => {
  try {
    await pool.query(
      'DELETE FROM departments WHERE id = $1 AND client_id = $2',
      [req.params.deptId, req.params.clientId]
    );
    res.json({ message: 'Department deleted' });
  } catch (err) { next(err); }
});

module.exports = router;
