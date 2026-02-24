'use strict';

const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../../config/database');

/* ---- Shared password validator ---- */
function validatePassword(password) {
  if (!password || password.length < 12) return 'Password must be at least 12 characters';
  if (!/[A-Z]/.test(password)) return 'Password must include an uppercase letter';
  if (!/[a-z]/.test(password)) return 'Password must include a lowercase letter';
  if (!/[0-9]/.test(password)) return 'Password must include a number';
  if (!/[^A-Za-z0-9]/.test(password)) return 'Password must include a special character';
  return null;
}

/* ---- Portal auth middleware ---- */
function requirePortalAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  try {
    const payload = jwt.verify(auth.split(' ')[1], process.env.JWT_SECRET);
    if (payload.type !== 'portal') return res.status(403).json({ error: 'Forbidden' });
    req.portalUser = payload;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// POST /api/portal/login
router.post('/login', async (req, res, next) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }

    const result = await pool.query(
      `SELECT cpu.*, c.name AS client_name, c.account_number
       FROM client_portal_users cpu
       JOIN clients c ON cpu.client_id = c.id
       WHERE cpu.username = $1 AND cpu.is_active = true`,
      [username]
    );
    const user = result.rows[0];

    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign(
      { id: user.id, client_id: user.client_id, username: user.username, type: 'portal' },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.json({
      token,
      user: { id: user.id, username: user.username, email: user.email,
              client_id: user.client_id, client_name: user.client_name,
              account_number: user.account_number },
    });
  } catch (err) { next(err); }
});

// GET /api/portal/me
router.get('/me', requirePortalAuth, async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT cpu.id, cpu.username, cpu.email, cpu.client_id, cpu.created_at,
              c.name AS client_name, c.account_number, c.address, c.opening_times, c.timezone
       FROM client_portal_users cpu
       JOIN clients c ON cpu.client_id = c.id
       WHERE cpu.id = $1`,
      [req.portalUser.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'User not found' });
    res.json({ user: result.rows[0] });
  } catch (err) { next(err); }
});

// GET /api/portal/messages
router.get('/messages', requirePortalAuth, async (req, res, next) => {
  try {
    const { status, limit = 50, offset = 0 } = req.query;
    let query = `
      SELECT m.*, op.full_name AS operator_name
      FROM messages m
      LEFT JOIN operators op ON m.operator_id = op.id
      WHERE m.client_id = $1
    `;
    const params = [req.portalUser.client_id];
    if (status) { params.push(status); query += ` AND m.status = $${params.length}`; }
    params.push(parseInt(limit)); query += ` ORDER BY m.created_at DESC LIMIT $${params.length}`;
    params.push(parseInt(offset)); query += ` OFFSET $${params.length}`;

    const result = await pool.query(query, params);
    res.json({ messages: result.rows });
  } catch (err) { next(err); }
});

// GET /api/portal/calls
router.get('/calls', requirePortalAuth, async (req, res, next) => {
  try {
    const { days = 30 } = req.query;
    const [summaryResult, recentResult] = await Promise.all([
      pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE disposition = 'answered') AS answered,
           COUNT(*) FILTER (WHERE disposition = 'no_answer') AS missed,
           COUNT(*) AS total,
           ROUND(COALESCE(SUM(duration_seconds) FILTER (WHERE disposition = 'answered') / 60.0, 0), 1) AS total_minutes
         FROM call_logs
         WHERE client_id = $1 AND call_start >= NOW() - ($2 || ' days')::INTERVAL`,
        [req.portalUser.client_id, days]
      ),
      pool.query(
        `SELECT cl.*, op.full_name AS operator_name
         FROM call_logs cl
         LEFT JOIN operators op ON cl.operator_id = op.id
         WHERE cl.client_id = $1 ORDER BY cl.call_start DESC LIMIT 20`,
        [req.portalUser.client_id]
      ),
    ]);
    res.json({ summary: summaryResult.rows[0], recent: recentResult.rows });
  } catch (err) { next(err); }
});

// GET /api/portal/availability
router.get('/availability', requirePortalAuth, async (req, res, next) => {
  try {
    const result = await pool.query(
      'SELECT * FROM client_availability WHERE client_id = $1',
      [req.portalUser.client_id]
    );
    res.json({ availability: result.rows[0] || { status: 'available', note: null } });
  } catch (err) { next(err); }
});

// PUT /api/portal/availability
router.put('/availability', requirePortalAuth, async (req, res, next) => {
  try {
    const { status, note } = req.body;
    const VALID = ['available', 'out_of_office', 'annual_leave', 'meeting'];
    if (status && !VALID.includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }
    const result = await pool.query(
      `INSERT INTO client_availability (client_id, status, note, updated_at)
       VALUES ($1, COALESCE($2,'available'), $3, NOW())
       ON CONFLICT (client_id) DO UPDATE
         SET status = COALESCE($2, client_availability.status),
             note = $3, updated_at = NOW()
       RETURNING *`,
      [req.portalUser.client_id, status || null, note || null]
    );
    res.json({ availability: result.rows[0] });
  } catch (err) { next(err); }
});

// ---- Portal user management (requires operator JWT, not portal JWT) ----
const { requireAuth, requireRole } = require('../middleware/auth');

// GET /api/portal/clients/:clientId/users
router.get('/clients/:clientId/users', requireAuth, requireRole('admin', 'supervisor'), async (req, res, next) => {
  try {
    const result = await pool.query(
      'SELECT id, username, email, is_active, created_at FROM client_portal_users WHERE client_id = $1 ORDER BY username',
      [req.params.clientId]
    );
    res.json({ users: result.rows });
  } catch (err) { next(err); }
});

// POST /api/portal/clients/:clientId/users
router.post('/clients/:clientId/users', requireAuth, requireRole('admin', 'supervisor'), async (req, res, next) => {
  try {
    const { username, password, email } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'username and password required' });
    const pwErr = validatePassword(password);
    if (pwErr) return res.status(400).json({ error: pwErr });
    const hash = await bcrypt.hash(password, 12);
    const result = await pool.query(
      `INSERT INTO client_portal_users (client_id, username, password_hash, email)
       VALUES ($1,$2,$3,$4) RETURNING id, username, email, is_active, created_at`,
      [req.params.clientId, username, hash, email || null]
    );
    res.status(201).json({ user: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Username already exists' });
    next(err);
  }
});

// PUT /api/portal/clients/:clientId/users/:userId
router.put('/clients/:clientId/users/:userId', requireAuth, requireRole('admin', 'supervisor'), async (req, res, next) => {
  try {
    const { email, is_active, password } = req.body;
    let hash;
    if (password) {
      const pwErr = validatePassword(password);
      if (pwErr) return res.status(400).json({ error: pwErr });
      hash = await bcrypt.hash(password, 12);
    }
    const result = await pool.query(
      `UPDATE client_portal_users SET
         email = COALESCE($1, email),
         is_active = COALESCE($2, is_active),
         password_hash = COALESCE($3, password_hash)
       WHERE id = $4 AND client_id = $5
       RETURNING id, username, email, is_active`,
      [email, is_active, hash, req.params.userId, req.params.clientId]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'User not found' });
    res.json({ user: result.rows[0] });
  } catch (err) { next(err); }
});

// DELETE /api/portal/clients/:clientId/users/:userId
router.delete('/clients/:clientId/users/:userId', requireAuth, requireRole('admin'), async (req, res, next) => {
  try {
    await pool.query('DELETE FROM client_portal_users WHERE id = $1 AND client_id = $2',
      [req.params.userId, req.params.clientId]);
    res.json({ message: 'User deleted' });
  } catch (err) { next(err); }
});

module.exports = router;
