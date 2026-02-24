'use strict';

const router = require('express').Router();
const pool = require('../../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');

router.use(requireAuth);

// GET /api/canned — list canned responses; optional ?client_id= filter
router.get('/', async (req, res, next) => {
  try {
    const { client_id } = req.query;
    let result;
    if (client_id) {
      result = await pool.query(
        `SELECT cr.*, o.username AS created_by_name
         FROM canned_responses cr
         LEFT JOIN operators o ON cr.created_by = o.id
         WHERE (cr.client_id = $1 OR cr.client_id IS NULL)
         ORDER BY cr.shortcode`,
        [client_id]
      );
    } else {
      result = await pool.query(
        `SELECT cr.*, o.username AS created_by_name
         FROM canned_responses cr
         LEFT JOIN operators o ON cr.created_by = o.id
         ORDER BY cr.shortcode`
      );
    }
    res.json({ canned_responses: result.rows });
  } catch (err) {
    next(err);
  }
});

// POST /api/canned — create a canned response
router.post('/', requireRole('admin', 'supervisor'), async (req, res, next) => {
  try {
    const { shortcode, title, body, client_id } = req.body;
    if (!shortcode) return res.status(400).json({ error: 'shortcode is required' });
    if (!body) return res.status(400).json({ error: 'body is required' });

    const result = await pool.query(
      `INSERT INTO canned_responses (shortcode, title, body, client_id, created_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [shortcode, title || null, body, client_id || null, req.operator.id]
    );
    res.status(201).json({ canned_response: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// PUT /api/canned/:id — update a canned response
router.put('/:id', requireRole('admin', 'supervisor'), async (req, res, next) => {
  try {
    const { shortcode, title, body, client_id } = req.body;
    const result = await pool.query(
      `UPDATE canned_responses SET
         shortcode  = COALESCE($1, shortcode),
         title      = COALESCE($2, title),
         body       = COALESCE($3, body),
         client_id  = COALESCE($4, client_id)
       WHERE id = $5
       RETURNING *`,
      [shortcode, title, body, client_id, req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Canned response not found' });
    res.json({ canned_response: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/canned/:id — delete a canned response
router.delete('/:id', requireRole('admin', 'supervisor'), async (req, res, next) => {
  try {
    const result = await pool.query(
      'DELETE FROM canned_responses WHERE id = $1 RETURNING id',
      [req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Canned response not found' });
    res.json({ message: 'Deleted' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
