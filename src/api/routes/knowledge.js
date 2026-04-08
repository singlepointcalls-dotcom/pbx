'use strict';

/**
 * Knowledge Base routes
 *
 * Mounted at /api/clients — all paths are scoped to a client.
 *
 * GET    /api/clients/:clientId/knowledge              — list articles
 * GET    /api/clients/:clientId/knowledge/:articleId   — get single article
 * POST   /api/clients/:clientId/knowledge              — create article (admin/supervisor)
 * PUT    /api/clients/:clientId/knowledge/:articleId   — update article (admin/supervisor)
 * DELETE /api/clients/:clientId/knowledge/:articleId   — delete article  (admin/supervisor)
 * POST   /api/clients/:clientId/knowledge/ask          — AI Q&A
 *
 * Also supports global articles (client_id IS NULL) via:
 * GET    /api/knowledge                                — list global articles
 * POST   /api/knowledge                                — create global article (admin/supervisor)
 * PUT    /api/knowledge/:articleId                     — update
 * DELETE /api/knowledge/:articleId                     — delete
 */

const router = require('express').Router();
const pool = require('../../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const { askKnowledgeBase } = require('../../services/ai');

router.use(requireAuth);

/* ------------------------------------------------------------------ */
/*  Client-scoped articles                                             */
/* ------------------------------------------------------------------ */

// GET /api/clients/:clientId/knowledge
router.get('/:clientId/knowledge', async (req, res, next) => {
  try {
    const { category, search, include_global } = req.query;
    let query = `
      SELECT ka.*, o.full_name AS author_name
      FROM knowledge_base_articles ka
      LEFT JOIN operators o ON ka.created_by = o.id
      WHERE ka.is_active = true
    `;
    const params = [];

    if (include_global === 'true') {
      params.push(req.params.clientId);
      query += ` AND (ka.client_id = $${params.length} OR ka.client_id IS NULL)`;
    } else {
      params.push(req.params.clientId);
      query += ` AND ka.client_id = $${params.length}`;
    }

    if (category) {
      params.push(category);
      query += ` AND ka.category = $${params.length}`;
    }

    if (search) {
      params.push(search);
      query += ` AND to_tsvector('english', coalesce(ka.title,'') || ' ' || coalesce(ka.content,'')) @@ plainto_tsquery('english', $${params.length})`;
    }

    query += ' ORDER BY ka.client_id NULLS LAST, ka.category NULLS LAST, ka.title ASC';

    const result = await pool.query(query, params);
    res.json({ articles: result.rows });
  } catch (err) { next(err); }
});

// GET /api/clients/:clientId/knowledge/:articleId
router.get('/:clientId/knowledge/:articleId', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT ka.*, o.full_name AS author_name
       FROM knowledge_base_articles ka
       LEFT JOIN operators o ON ka.created_by = o.id
       WHERE ka.id = $1 AND (ka.client_id = $2 OR ka.client_id IS NULL)`,
      [req.params.articleId, req.params.clientId]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Article not found' });
    res.json({ article: result.rows[0] });
  } catch (err) { next(err); }
});

// POST /api/clients/:clientId/knowledge
router.post('/:clientId/knowledge', requireRole('admin', 'supervisor'), async (req, res, next) => {
  try {
    const { title, content, category, tags = [] } = req.body;
    if (!title) return res.status(400).json({ error: 'title is required' });
    if (!content) return res.status(400).json({ error: 'content is required' });

    const result = await pool.query(
      `INSERT INTO knowledge_base_articles (client_id, title, content, category, tags, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [req.params.clientId, title, content, category || null, tags, req.operator.id]
    );
    res.status(201).json({ article: result.rows[0] });
  } catch (err) { next(err); }
});

// PUT /api/clients/:clientId/knowledge/:articleId
router.put('/:clientId/knowledge/:articleId', requireRole('admin', 'supervisor'), async (req, res, next) => {
  try {
    const { title, content, category, tags, is_active } = req.body;
    const result = await pool.query(
      `UPDATE knowledge_base_articles SET
         title      = COALESCE($1, title),
         content    = COALESCE($2, content),
         category   = COALESCE($3, category),
         tags       = COALESCE($4, tags),
         is_active  = COALESCE($5, is_active)
       WHERE id = $6 AND client_id = $7
       RETURNING *`,
      [title, content, category, tags, is_active, req.params.articleId, req.params.clientId]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Article not found' });
    res.json({ article: result.rows[0] });
  } catch (err) { next(err); }
});

// DELETE /api/clients/:clientId/knowledge/:articleId
router.delete('/:clientId/knowledge/:articleId', requireRole('admin', 'supervisor'), async (req, res, next) => {
  try {
    const result = await pool.query(
      'DELETE FROM knowledge_base_articles WHERE id = $1 AND client_id = $2 RETURNING id',
      [req.params.articleId, req.params.clientId]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Article not found' });
    res.json({ message: 'Article deleted' });
  } catch (err) { next(err); }
});

// POST /api/clients/:clientId/knowledge/ask — AI Q&A
router.post('/:clientId/knowledge/ask', async (req, res, next) => {
  try {
    const { question } = req.body;
    if (!question || !question.trim()) {
      return res.status(400).json({ error: 'question is required' });
    }

    // Fetch client name for context
    const clientResult = await pool.query('SELECT name FROM clients WHERE id = $1', [req.params.clientId]);
    const clientName = clientResult.rows[0]?.name || null;

    const result = await askKnowledgeBase(question.trim(), req.params.clientId, clientName);
    res.json(result);
  } catch (err) {
    if (err.message && err.message.includes('ANTHROPIC_API_KEY')) {
      return res.status(503).json({ error: 'AI service is not configured. Please set ANTHROPIC_API_KEY.' });
    }
    next(err);
  }
});

/* ------------------------------------------------------------------ */
/*  Category list helper                                               */
/* ------------------------------------------------------------------ */

// GET /api/clients/:clientId/knowledge-categories
router.get('/:clientId/knowledge-categories', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT DISTINCT category
       FROM knowledge_base_articles
       WHERE is_active = true
         AND (client_id = $1 OR client_id IS NULL)
         AND category IS NOT NULL
       ORDER BY category ASC`,
      [req.params.clientId]
    );
    res.json({ categories: result.rows.map((r) => r.category) });
  } catch (err) { next(err); }
});

module.exports = router;
