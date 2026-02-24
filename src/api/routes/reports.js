'use strict';

const router = require('express').Router();
const pool = require('../../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const { getConnectedOperators } = require('../../services/realtime');

router.use(requireAuth);
router.use(requireRole('admin', 'supervisor'));

// GET /api/reports/summary — today's headline figures
router.get('/summary', async (req, res, next) => {
  try {
    const [calls, messages, tasks] = await Promise.all([
      pool.query(`
        SELECT
          COUNT(*) AS total,
          COUNT(*) FILTER (WHERE disposition = 'answered') AS answered,
          COUNT(*) FILTER (WHERE disposition = 'no_answer' OR disposition IS NULL) AS missed,
          COALESCE(SUM(duration_seconds), 0) AS total_seconds
        FROM call_logs
        WHERE call_start >= CURRENT_DATE
      `),
      pool.query(`SELECT COUNT(*) AS total FROM messages WHERE created_at >= CURRENT_DATE`),
      pool.query(`SELECT COUNT(*) AS pending FROM tasks WHERE completed_at IS NULL`),
    ]);

    res.json({
      calls_today:      parseInt(calls.rows[0].total),
      answered_today:   parseInt(calls.rows[0].answered),
      missed_today:     parseInt(calls.rows[0].missed),
      total_seconds_today: parseInt(calls.rows[0].total_seconds),
      messages_today:   parseInt(messages.rows[0].total),
      tasks_pending:    parseInt(tasks.rows[0].pending),
      operators_online: getConnectedOperators().length,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/reports/call-volume?days=30 — daily call volumes
router.get('/call-volume', async (req, res, next) => {
  try {
    const days = Math.min(parseInt(req.query.days || '30'), 90);
    const result = await pool.query(`
      SELECT
        DATE(call_start) AS date,
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE disposition = 'answered') AS answered,
        COUNT(*) FILTER (WHERE disposition = 'no_answer' OR disposition IS NULL) AS missed,
        COALESCE(SUM(duration_seconds), 0) AS total_seconds
      FROM call_logs
      WHERE call_start >= NOW() - ($1 || ' days')::INTERVAL
      GROUP BY DATE(call_start)
      ORDER BY date ASC
    `, [days]);
    res.json({ days, data: result.rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/reports/operators?days=30 — per-operator performance
router.get('/operators', async (req, res, next) => {
  try {
    const days = Math.min(parseInt(req.query.days || '30'), 90);
    const result = await pool.query(`
      SELECT
        o.id,
        o.full_name,
        o.username,
        COUNT(DISTINCT cl.id) AS calls_answered,
        COUNT(DISTINCT m.id)  AS messages_taken,
        COALESCE(SUM(cl.duration_seconds), 0) AS total_seconds,
        ROUND(AVG(cl.duration_seconds))::INT AS avg_duration_seconds
      FROM operators o
      LEFT JOIN call_logs cl
             ON cl.operator_id = o.id
            AND cl.call_start >= NOW() - ($1 || ' days')::INTERVAL
            AND cl.disposition = 'answered'
      LEFT JOIN messages m
             ON m.operator_id = o.id
            AND m.created_at >= NOW() - ($1 || ' days')::INTERVAL
      WHERE o.is_active = true
      GROUP BY o.id, o.full_name, o.username
      ORDER BY calls_answered DESC
    `, [days]);
    res.json({ days, operators: result.rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/reports/clients?days=30 — per-client call & message volumes
router.get('/clients', async (req, res, next) => {
  try {
    const days = Math.min(parseInt(req.query.days || '30'), 90);
    const result = await pool.query(`
      SELECT
        c.id,
        c.name,
        c.account_number,
        COUNT(DISTINCT cl.id)                                               AS total_calls,
        COUNT(DISTINCT cl.id) FILTER (WHERE cl.disposition = 'answered')   AS answered_calls,
        COUNT(DISTINCT m.id)                                                AS total_messages,
        COALESCE(SUM(cl.duration_seconds), 0)                              AS total_seconds,
        ROUND(AVG(cl.duration_seconds))::INT                               AS avg_duration_seconds
      FROM clients c
      LEFT JOIN call_logs cl
             ON cl.client_id = c.id
            AND cl.call_start >= NOW() - ($1 || ' days')::INTERVAL
      LEFT JOIN messages m
             ON m.client_id = c.id
            AND m.created_at >= NOW() - ($1 || ' days')::INTERVAL
      WHERE c.is_active = true
      GROUP BY c.id, c.name, c.account_number
      ORDER BY total_calls DESC
    `, [days]);
    res.json({ days, clients: result.rows });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
