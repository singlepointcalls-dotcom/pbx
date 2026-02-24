'use strict';

const router = require('express').Router();
const pool = require('../../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');

router.use(requireAuth);

// GET /api/tasks — list tasks; ?completed=false for pending only
router.get('/', async (req, res, next) => {
  try {
    const { client_id, completed = 'false', limit = 100 } = req.query;

    let query = `
      SELECT t.*,
             c.name  AS client_name,
             o.full_name  AS operator_name,
             cb.full_name AS created_by_name
      FROM tasks t
      LEFT JOIN clients   c  ON t.client_id   = c.id
      LEFT JOIN operators o  ON t.operator_id = o.id
      LEFT JOIN operators cb ON t.created_by  = cb.id
      WHERE 1=1
    `;
    const params = [];

    if (client_id) {
      params.push(client_id);
      query += ` AND t.client_id = $${params.length}`;
    }
    if (completed === 'false') {
      query += ` AND t.completed_at IS NULL`;
    } else if (completed === 'true') {
      query += ` AND t.completed_at IS NOT NULL`;
    }

    params.push(parseInt(limit));
    query += ` ORDER BY t.completed_at NULLS FIRST, t.due_at NULLS LAST, t.created_at DESC LIMIT $${params.length}`;

    const result = await pool.query(query, params);
    res.json({ tasks: result.rows });
  } catch (err) {
    next(err);
  }
});

// POST /api/tasks — create a task
router.post('/', async (req, res, next) => {
  try {
    const { client_id, operator_id, call_log_id, title, notes, due_at } = req.body;
    if (!title) return res.status(400).json({ error: 'title is required' });

    const result = await pool.query(
      `INSERT INTO tasks (client_id, operator_id, created_by, call_log_id, title, notes, due_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [client_id || null, operator_id || null, req.operator.id, call_log_id || null, title, notes || null, due_at || null]
    );
    res.status(201).json({ task: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// PUT /api/tasks/:id — update task fields
router.put('/:id', async (req, res, next) => {
  try {
    const { title, notes, due_at, operator_id } = req.body;
    const result = await pool.query(
      `UPDATE tasks SET
         title       = COALESCE($1, title),
         notes       = COALESCE($2, notes),
         due_at      = COALESCE($3, due_at),
         operator_id = COALESCE($4, operator_id)
       WHERE id = $5
       RETURNING *`,
      [title, notes, due_at || null, operator_id || null, req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Task not found' });
    res.json({ task: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// POST /api/tasks/:id/complete — mark task complete
router.post('/:id/complete', async (req, res, next) => {
  try {
    const result = await pool.query(
      `UPDATE tasks SET completed_at = NOW() WHERE id = $1 AND completed_at IS NULL RETURNING *`,
      [req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Task not found or already completed' });
    res.json({ task: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/tasks/:id
router.delete('/:id', requireRole('admin', 'supervisor'), async (req, res, next) => {
  try {
    await pool.query('DELETE FROM tasks WHERE id = $1', [req.params.id]);
    res.json({ message: 'Task deleted' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
