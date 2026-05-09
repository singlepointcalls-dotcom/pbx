'use strict';

const router = require('express').Router();
const pool = require('../../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');

router.use(requireAuth);

// GET /api/knowledge?client_id=&category=&q=
router.get('/', async (req, res, next) => {
  try {
    const { client_id, category, q } = req.query;
    const params = [];
    let where = 'WHERE a.is_published = true';

    // Operators see global articles + their client's articles
    if (client_id) {
      params.push(client_id);
      where += ` AND (a.client_id = $${params.length} OR a.client_id IS NULL)`;
    } else {
      where += ' AND a.client_id IS NULL';
    }
    if (category) { params.push(category); where += ` AND a.category = $${params.length}`; }

    let orderBy = 'ORDER BY a.updated_at DESC';
    if (q) {
      params.push(q);
      where += ` AND to_tsvector('english', a.title || ' ' || a.body) @@ plainto_tsquery('english', $${params.length})`;
      orderBy = `ORDER BY ts_rank(to_tsvector('english', a.title || ' ' || a.body), plainto_tsquery('english', $${params.length})) DESC`;
    }

    const result = await pool.query(
      `SELECT a.*, c.name AS client_name, o.full_name AS author_name
       FROM knowledge_articles a
       LEFT JOIN clients c ON a.client_id = c.id
       LEFT JOIN operators o ON a.created_by = o.id
       ${where} ${orderBy}`,
      params
    );
    res.json({ articles: result.rows });
  } catch (err) { next(err); }
});

// GET /api/knowledge/categories
router.get('/categories', async (req, res, next) => {
  try {
    const { client_id } = req.query;
    const params = [];
    let filter = '';
    if (client_id) { params.push(client_id); filter = `AND (client_id = $${params.length} OR client_id IS NULL)`; }
    const result = await pool.query(
      `SELECT DISTINCT category FROM knowledge_articles
       WHERE category IS NOT NULL AND is_published = true ${filter}
       ORDER BY category ASC`, params
    );
    res.json({ categories: result.rows.map((r) => r.category) });
  } catch (err) { next(err); }
});

// GET /api/knowledge/:id
router.get('/:id', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT a.*, c.name AS client_name, o.full_name AS author_name
       FROM knowledge_articles a
       LEFT JOIN clients c ON a.client_id = c.id
       LEFT JOIN operators o ON a.created_by = o.id
       WHERE a.id = $1`, [req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Article not found' });
    res.json({ article: result.rows[0] });
  } catch (err) { next(err); }
});

// POST /api/knowledge
router.post('/', requireRole('admin', 'supervisor'), async (req, res, next) => {
  try {
    const { client_id, title, body, category, tags = [], is_published = true } = req.body;
    if (!title || !body) return res.status(400).json({ error: 'title and body are required' });
    const result = await pool.query(
      `INSERT INTO knowledge_articles (client_id, title, body, category, tags, is_published, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$7) RETURNING *`,
      [client_id || null, title, body, category || null, tags, is_published, req.operator.id]
    );
    res.status(201).json({ article: result.rows[0] });
  } catch (err) { next(err); }
});

// PUT /api/knowledge/:id
router.put('/:id', requireRole('admin', 'supervisor'), async (req, res, next) => {
  try {
    const { title, body, category, tags, is_published } = req.body;
    const result = await pool.query(
      `UPDATE knowledge_articles SET
         title        = COALESCE($1, title),
         body         = COALESCE($2, body),
         category     = COALESCE($3, category),
         tags         = COALESCE($4, tags),
         is_published = COALESCE($5, is_published),
         updated_by   = $6,
         updated_at   = NOW()
       WHERE id = $7 RETURNING *`,
      [title||null, body||null, category||null,
       tags !== undefined ? tags : null,
       is_published !== undefined ? is_published : null,
       req.operator.id, req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Article not found' });
    res.json({ article: result.rows[0] });
  } catch (err) { next(err); }
});

// DELETE /api/knowledge/:id
router.delete('/:id', requireRole('admin', 'supervisor'), async (req, res, next) => {
  try {
    const result = await pool.query('DELETE FROM knowledge_articles WHERE id = $1 RETURNING id', [req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ error: 'Article not found' });
    res.json({ message: 'Article deleted' });
  } catch (err) { next(err); }
});

module.exports = router;
