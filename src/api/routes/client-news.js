'use strict';

const router = require('express').Router();
const pool = require('../../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');

router.use(requireAuth);

// GET /api/clients/:clientId/news
router.get('/:clientId/news', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT cn.*, o.full_name AS author_name
       FROM client_news cn
       LEFT JOIN operators o ON cn.created_by = o.id
       WHERE cn.client_id = $1
         AND (cn.expires_at IS NULL OR cn.expires_at > NOW())
       ORDER BY cn.created_at DESC`,
      [req.params.clientId]
    );
    res.json({ news: result.rows });
  } catch (err) { next(err); }
});

// POST /api/clients/:clientId/news
router.post('/:clientId/news', requireRole('admin', 'supervisor'), async (req, res, next) => {
  try {
    const { content, expires_at } = req.body;
    if (!content) return res.status(400).json({ error: 'content is required' });

    const result = await pool.query(
      `INSERT INTO client_news (client_id, content, created_by, expires_at)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [req.params.clientId, content, req.operator.id, expires_at || null]
    );
    res.status(201).json({ item: result.rows[0] });
  } catch (err) { next(err); }
});

// DELETE /api/clients/:clientId/news/:newsId
router.delete('/:clientId/news/:newsId', requireRole('admin', 'supervisor'), async (req, res, next) => {
  try {
    await pool.query(
      'DELETE FROM client_news WHERE id = $1 AND client_id = $2',
      [req.params.newsId, req.params.clientId]
    );
    res.json({ message: 'News item deleted' });
  } catch (err) { next(err); }
});

module.exports = router;
