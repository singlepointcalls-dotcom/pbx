'use strict';

const router = require('express').Router();
const pool = require('../../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const { getConnectedOperators } = require('../../services/realtime');

router.use(requireAuth);
router.use(requireRole('admin', 'supervisor'));

function toCsv(rows) {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);
  const escape = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  return [headers.join(','), ...rows.map((r) => headers.map((h) => escape(r[h])).join(','))].join('\r\n');
}

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
    if (req.query.format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="operator-report.csv"');
      return res.send(toCsv(result.rows));
    }
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
    if (req.query.format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="client-report.csv"');
      return res.send(toCsv(result.rows));
    }
    res.json({ days, clients: result.rows });
  } catch (err) {
    next(err);
  }
});

// ── Scheduled reports ──────────────────────────────────────────────────────

// GET /api/reports/schedules
router.get('/schedules', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT rs.*, c.name AS client_name, o.full_name AS created_by_name
       FROM report_schedules rs
       LEFT JOIN clients c ON rs.client_id = c.id
       LEFT JOIN operators o ON rs.created_by = o.id
       ORDER BY rs.created_at DESC`
    );
    res.json({ schedules: result.rows });
  } catch (err) { next(err); }
});

// POST /api/reports/schedules
router.post('/schedules', async (req, res, next) => {
  try {
    const { report_type, frequency, recipients, client_id } = req.body;
    if (!report_type || !frequency || !recipients?.length) {
      return res.status(400).json({ error: 'report_type, frequency, and recipients are required' });
    }
    const validTypes = ['calls', 'messages', 'performance', 'sla'];
    const validFreq = ['daily', 'weekly', 'monthly'];
    if (!validTypes.includes(report_type)) return res.status(400).json({ error: 'Invalid report_type' });
    if (!validFreq.includes(frequency)) return res.status(400).json({ error: 'Invalid frequency' });

    // Calculate first run time
    const nextRun = new Date();
    if (frequency === 'daily') nextRun.setDate(nextRun.getDate() + 1);
    else if (frequency === 'weekly') nextRun.setDate(nextRun.getDate() + 7);
    else nextRun.setMonth(nextRun.getMonth() + 1);
    nextRun.setHours(8, 0, 0, 0); // send at 08:00

    const result = await pool.query(
      `INSERT INTO report_schedules (report_type, frequency, recipients, client_id, next_run_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [report_type, frequency, recipients, client_id || null, nextRun, req.operator.id]
    );
    res.status(201).json({ schedule: result.rows[0] });
  } catch (err) { next(err); }
});

// PATCH /api/reports/schedules/:id
router.patch('/schedules/:id', async (req, res, next) => {
  try {
    const { is_active, recipients, frequency } = req.body;
    const result = await pool.query(
      `UPDATE report_schedules SET
         is_active  = COALESCE($1, is_active),
         recipients = COALESCE($2, recipients),
         frequency  = COALESCE($3, frequency)
       WHERE id = $4 RETURNING *`,
      [is_active ?? null, recipients || null, frequency || null, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Schedule not found' });
    res.json({ schedule: result.rows[0] });
  } catch (err) { next(err); }
});

// DELETE /api/reports/schedules/:id
router.delete('/schedules/:id', async (req, res, next) => {
  try {
    const result = await pool.query('DELETE FROM report_schedules WHERE id = $1 RETURNING id', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Schedule not found' });
    res.json({ message: 'Schedule deleted' });
  } catch (err) { next(err); }
});

// GET /api/reports/sla-compliance?days=30&client_id=
// Per-client SLA compliance: messages within SLA window vs. breached
router.get('/sla-compliance', async (req, res, next) => {
  try {
    const days = Math.min(parseInt(req.query.days) || 30, 365);
    const clientFilter = req.query.client_id ? 'AND m.client_id = $2' : '';
    const params = [days];
    if (req.query.client_id) params.push(req.query.client_id);

    const result = await pool.query(
      `SELECT
         c.id AS client_id,
         c.name AS client_name,
         COALESCE(c.sla_minutes, 60) AS sla_minutes,
         COUNT(m.id) AS total_messages,
         COUNT(m.id) FILTER (WHERE m.acknowledged_at IS NOT NULL) AS acknowledged,
         COUNT(m.id) FILTER (
           WHERE m.acknowledged_at IS NOT NULL
             AND EXTRACT(EPOCH FROM (m.acknowledged_at - m.created_at))/60 <= COALESCE(c.sla_minutes, 60)
         ) AS within_sla,
         COUNT(m.id) FILTER (
           WHERE m.acknowledged_at IS NOT NULL
             AND EXTRACT(EPOCH FROM (m.acknowledged_at - m.created_at))/60 > COALESCE(c.sla_minutes, 60)
         ) AS breached_sla,
         COUNT(m.id) FILTER (WHERE m.acknowledged_at IS NULL) AS unacknowledged,
         ROUND(AVG(
           EXTRACT(EPOCH FROM (m.acknowledged_at - m.created_at))/60
         ) FILTER (WHERE m.acknowledged_at IS NOT NULL), 1) AS avg_ack_minutes
       FROM clients c
       LEFT JOIN messages m ON m.client_id = c.id
         AND m.created_at >= NOW() - ($1 || ' days')::INTERVAL
       WHERE c.is_active = true ${clientFilter}
       GROUP BY c.id, c.name, c.sla_minutes
       ORDER BY c.name ASC`,
      params
    );

    const rows = result.rows.map((r) => ({
      ...r,
      sla_pct: r.acknowledged > 0
        ? Math.round((parseInt(r.within_sla) / parseInt(r.acknowledged)) * 100)
        : null,
    }));

    res.json({ days, clients: rows });
  } catch (err) { next(err); }
});

// GET /api/reports/operator-performance — per-operator KPI summary
router.get('/operator-performance', async (req, res, next) => {
  try {
    const { days = 30, operator_id } = req.query;
    const since = `NOW() - INTERVAL '${parseInt(days, 10)} days'`;
    const opFilter = operator_id ? `AND cl.operator_id = '${operator_id}'::uuid` : '';

    const rows = await pool.query(`
      SELECT
        o.id,
        o.username,
        o.display_name,
        COUNT(DISTINCT cl.id) FILTER (WHERE cl.call_start > ${since}) AS calls_handled,
        ROUND(AVG(cl.duration_seconds) FILTER (WHERE cl.call_start > ${since} AND cl.duration_seconds > 0))::INT AS avg_call_duration_sec,
        COUNT(DISTINCT m.id) FILTER (WHERE m.created_at > ${since}) AS messages_taken,
        ROUND(AVG(EXTRACT(EPOCH FROM (m.acknowledged_at - m.created_at)) / 60) FILTER (WHERE m.acknowledged_at IS NOT NULL AND m.created_at > ${since}))::INT AS avg_ack_minutes,
        COUNT(DISTINCT qa.id) FILTER (WHERE qa.created_at > ${since}) AS qa_reviews,
        ROUND(AVG(qa.score) FILTER (WHERE qa.created_at > ${since}), 1) AS avg_qa_score,
        COUNT(DISTINCT cb.id) FILTER (WHERE cb.created_at > ${since} AND cb.status = 'completed') AS callbacks_completed
      FROM operators o
      LEFT JOIN call_logs cl ON cl.operator_id = o.id ${opFilter}
      LEFT JOIN messages m   ON m.operator_id  = o.id
      LEFT JOIN qa_scores qa ON qa.operator_id = o.id
      LEFT JOIN callback_records cb ON cb.operator_id = o.id
      WHERE o.is_active = true
      GROUP BY o.id, o.username, o.display_name
      ORDER BY calls_handled DESC NULLS LAST
    `);

    res.json({ days: parseInt(days, 10), operators: rows.rows });
  } catch (err) { next(err); }
});

module.exports = router;
