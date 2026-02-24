'use strict';

const router = require('express').Router();
const bcrypt = require('bcryptjs');
const pool = require('../../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const { validatePassword } = require('./auth');

router.use(requireAuth);

// GET /api/operators
router.get('/', requireRole('admin', 'supervisor'), async (req, res, next) => {
  try {
    const result = await pool.query(
      'SELECT id, username, full_name, email, role, is_active, created_at FROM operators ORDER BY full_name'
    );
    res.json({ operators: result.rows });
  } catch (err) {
    next(err);
  }
});

// POST /api/operators
router.post('/', requireRole('admin'), async (req, res, next) => {
  try {
    const { username, password, full_name, email, role = 'operator' } = req.body;
    if (!username || !password || !full_name || !email) {
      return res.status(400).json({ error: 'username, password, full_name, and email are required' });
    }
    const pwErr = validatePassword(password);
    if (pwErr) return res.status(400).json({ error: pwErr });

    const hash = await bcrypt.hash(password, 12);
    const result = await pool.query(
      `INSERT INTO operators (username, password_hash, full_name, email, role)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, username, full_name, email, role, is_active, created_at`,
      [username, hash, full_name, email, role]
    );
    res.status(201).json({ operator: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Username or email already exists' });
    next(err);
  }
});

// PUT /api/operators/:id
router.put('/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const { full_name, email, role, is_active, password } = req.body;
    let hash;
    if (password) {
      hash = await bcrypt.hash(password, 12);
    }

    const result = await pool.query(
      `UPDATE operators SET
         full_name = COALESCE($1, full_name),
         email = COALESCE($2, email),
         role = COALESCE($3, role),
         is_active = COALESCE($4, is_active),
         password_hash = COALESCE($5, password_hash)
       WHERE id = $6
       RETURNING id, username, full_name, email, role, is_active`,
      [full_name, email, role, is_active, hash, req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Operator not found' });
    res.json({ operator: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// PUT /api/operators/me/password — change own password
router.put('/me/password', async (req, res, next) => {
  try {
    const { current_password, new_password } = req.body;
    if (!current_password || !new_password) {
      return res.status(400).json({ error: 'current_password and new_password required' });
    }
    const pwErr = validatePassword(new_password);
    if (pwErr) return res.status(400).json({ error: pwErr });

    const result = await pool.query('SELECT * FROM operators WHERE id = $1', [req.operator.id]);
    const op = result.rows[0];
    if (!op || !(await bcrypt.compare(current_password, op.password_hash))) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    const hash = await bcrypt.hash(new_password, 12);
    await pool.query('UPDATE operators SET password_hash = $1 WHERE id = $2', [hash, req.operator.id]);
    res.json({ message: 'Password updated' });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/operators/:id/2fa — admin reset 2FA for any operator
router.delete('/:id/2fa', requireRole('admin'), async (req, res, next) => {
  try {
    await pool.query(
      'UPDATE operators SET totp_secret = NULL, totp_enabled = false WHERE id = $1',
      [req.params.id]
    );
    res.json({ message: '2FA reset for operator' });
  } catch (err) { next(err); }
});

module.exports = router;
