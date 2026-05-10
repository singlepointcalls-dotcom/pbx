'use strict';

/**
 * Call queue management — tracks inbound calls waiting for an available operator.
 *
 * GET  /api/queue                 — list waiting/recent queue entries
 * GET  /api/queue/stats           — summary stats (waiting count, avg wait, etc.)
 * GET  /api/queue/:id             — single entry
 * DELETE /api/queue/:id           — remove / abandon a queued call (admin)
 */

const router = require('express').Router();
const pool   = require('../../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const { broadcast } = require('../../services/realtime');
const audit = require('../../services/audit');

router.use(requireAuth);

/* ---- GET /api/queue — list queue entries ---- */
router.get('/', async (req, res, next) => {
  try {
    const { status = 'waiting', client_id, limit = 50, offset = 0 } = req.query;

    const conditions = [];
    const params = [];

    if (status && status !== 'all') {
      params.push(status);
      conditions.push(`q.status = $${params.length}`);
    }
    if (client_id) {
      params.push(client_id);
      conditions.push(`q.client_id = $${params.length}`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(Number(limit), Number(offset));

    const result = await pool.query(
      `SELECT q.*,
              c.name   AS client_name,
              o.username AS operator_username,
              EXTRACT(EPOCH FROM (COALESCE(q.answered_at, q.abandoned_at, NOW()) - q.queued_at))::INT AS current_wait_seconds
         FROM call_queue q
         LEFT JOIN clients   c ON c.id = q.client_id
         LEFT JOIN operators o ON o.id = q.operator_id
       ${where}
       ORDER BY q.queued_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    res.json({ entries: result.rows });
  } catch (err) { next(err); }
});

/* ---- GET /api/queue/stats — live summary ---- */
router.get('/stats', async (req, res, next) => {
  try {
    const r = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'waiting')                        AS waiting,
        COUNT(*) FILTER (WHERE status = 'connecting')                     AS connecting,
        COUNT(*) FILTER (WHERE status = 'answered' AND answered_at > NOW() - INTERVAL '1 hour') AS answered_1h,
        COUNT(*) FILTER (WHERE status = 'abandoned' AND abandoned_at > NOW() - INTERVAL '1 hour') AS abandoned_1h,
        ROUND(AVG(wait_seconds) FILTER (WHERE status = 'answered' AND answered_at > NOW() - INTERVAL '1 hour'))::INT AS avg_wait_answered_1h,
        MAX(EXTRACT(EPOCH FROM (NOW() - queued_at))::INT) FILTER (WHERE status = 'waiting') AS longest_wait_seconds
      FROM call_queue
    `);
    res.json(r.rows[0]);
  } catch (err) { next(err); }
});

/* ---- GET /api/queue/:id ---- */
router.get('/:id', async (req, res, next) => {
  try {
    const r = await pool.query(
      `SELECT q.*, c.name AS client_name, o.username AS operator_username
         FROM call_queue q
         LEFT JOIN clients   c ON c.id = q.client_id
         LEFT JOIN operators o ON o.id = q.operator_id
        WHERE q.id = $1`,
      [req.params.id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Queue entry not found' });
    res.json(r.rows[0]);
  } catch (err) { next(err); }
});

/* ---- DELETE /api/queue/:id — abandon a queued call ---- */
router.delete('/:id', requireRole('admin', 'supervisor'), async (req, res, next) => {
  try {
    const r = await pool.query(
      `UPDATE call_queue
          SET status = 'abandoned', abandoned_at = NOW(),
              wait_seconds = EXTRACT(EPOCH FROM (NOW() - queued_at))::INT
        WHERE id = $1 AND status = 'waiting'
       RETURNING *`,
      [req.params.id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Queue entry not found or not in waiting state' });
    broadcast('queue:abandoned', { entry: r.rows[0] });
    audit.log(req, 'queue.abandon', { queueId: req.params.id });
    res.json(r.rows[0]);
  } catch (err) { next(err); }
});

module.exports = router;
