'use strict';

const router = require('express').Router();
const pool = require('../../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');

router.use(requireAuth);

// GET /api/noticeboard
router.get('/', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT n.*, o.full_name AS author_name
       FROM noticeboard n
       LEFT JOIN operators o ON n.created_by = o.id
       WHERE n.expires_at IS NULL OR n.expires_at > NOW()
       ORDER BY n.is_pinned DESC, n.created_at DESC`
    );
    res.json({ notices: result.rows });
  } catch (err) { next(err); }
});

// POST /api/noticeboard
router.post('/', requireRole('admin', 'supervisor'), async (req, res, next) => {
  try {
    const { title, content, priority = 'normal', expires_at, is_pinned = false } = req.body;
    if (!title || !content) return res.status(400).json({ error: 'title and content are required' });

    const result = await pool.query(
      `INSERT INTO noticeboard (title, content, priority, created_by, expires_at, is_pinned)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [title, content, priority, req.operator.id, expires_at || null, is_pinned]
    );
    res.status(201).json({ notice: result.rows[0] });
  } catch (err) { next(err); }
});

// PUT /api/noticeboard/:id
router.put('/:id', requireRole('admin', 'supervisor'), async (req, res, next) => {
  try {
    const { title, content, priority, expires_at, is_pinned } = req.body;
    const result = await pool.query(
      `UPDATE noticeboard SET
         title      = COALESCE($1, title),
         content    = COALESCE($2, content),
         priority   = COALESCE($3, priority),
         expires_at = COALESCE($4, expires_at),
         is_pinned  = COALESCE($5, is_pinned),
         updated_at = NOW()
       WHERE id = $6
       RETURNING *`,
      [title, content, priority, expires_at, is_pinned, req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Notice not found' });
    res.json({ notice: result.rows[0] });
  } catch (err) { next(err); }
});

// DELETE /api/noticeboard/:id
router.delete('/:id', requireRole('admin', 'supervisor'), async (req, res, next) => {
  try {
    await pool.query('DELETE FROM noticeboard WHERE id = $1', [req.params.id]);
    res.json({ message: 'Notice deleted' });
  } catch (err) { next(err); }
});

module.exports = router;
