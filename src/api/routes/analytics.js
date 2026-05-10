'use strict';

/**
 * Advanced analytics — time-series data ready for charts.
 * All endpoints accept ?from=ISO&to=ISO&client_id=UUID filters.
 */

const router = require('express').Router();
const pool = require('../../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');

router.use(requireAuth);
router.use(requireRole('admin', 'supervisor'));

function toCsv(rows) {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);
  const escape = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  return [headers.join(','), ...rows.map((r) => headers.map((h) => escape(r[h])).join(','))].join('\r\n');
}

function sendCsvOrJson(res, rows, filename, jsonKey) {
  if (res.req.query.format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(rows.length ? toCsv(rows) : '');
  }
  res.json({ [jsonKey]: rows });
}

function parseRange(req) {
  const from = req.query.from || new Date(Date.now() - 7 * 86400 * 1000).toISOString();
  const to   = req.query.to   || new Date().toISOString();
  const granularity = req.query.granularity || 'hour'; // hour | day | week
  if (!['hour', 'day', 'week'].includes(granularity)) throw new Error('Invalid granularity');
  return { from, to, granularity };
}

// GET /api/analytics/calls — calls per time bucket
router.get('/calls', async (req, res, next) => {
  try {
    const { from, to, granularity } = parseRange(req);
    const params = [from, to];
    let clientFilter = '';
    if (req.query.client_id) {
      params.push(req.query.client_id);
      clientFilter = ` AND client_id = $${params.length}`;
    }

    const result = await pool.query(
      `SELECT
         date_trunc($3, started_at) AS bucket,
         COUNT(*) AS total,
         COUNT(*) FILTER (WHERE answered_at IS NOT NULL) AS answered,
         COUNT(*) FILTER (WHERE disposition = 'no_answer') AS missed,
         COALESCE(AVG(EXTRACT(EPOCH FROM (ended_at - answered_at)))::int, 0) AS avg_handle_seconds
       FROM call_logs
       WHERE started_at BETWEEN $1 AND $2 ${clientFilter}
       GROUP BY bucket
       ORDER BY bucket ASC`,
      [...params, granularity]
    );
    if (res.req.query.format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="analytics-calls.csv"');
      return res.send(toCsv(result.rows));
    }
    res.json({ series: result.rows, granularity });
  } catch (err) { next(err); }
});

// GET /api/analytics/messages — message volume per channel per bucket
router.get('/messages', async (req, res, next) => {
  try {
    const { from, to, granularity } = parseRange(req);
    const params = [from, to];
    let clientFilter = '';
    if (req.query.client_id) {
      params.push(req.query.client_id);
      clientFilter = ` AND m.client_id = $${params.length}`;
    }

    const result = await pool.query(
      `SELECT
         date_trunc($3, m.created_at) AS bucket,
         m.urgency,
         COUNT(*)::int AS count
       FROM messages m
       WHERE m.created_at BETWEEN $1 AND $2 ${clientFilter}
       GROUP BY bucket, m.urgency
       ORDER BY bucket ASC`,
      [...params, granularity]
    );
    if (res.req.query.format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="analytics-messages.csv"');
      return res.send(toCsv(result.rows));
    }
    res.json({ series: result.rows, granularity });
  } catch (err) { next(err); }
});

// GET /api/analytics/delivery — delivery success rates per channel
router.get('/delivery', async (req, res, next) => {
  try {
    const { from, to } = parseRange(req);
    const params = [from, to];
    let clientFilter = '';
    if (req.query.client_id) {
      params.push(req.query.client_id);
      clientFilter = ` AND m.client_id = $${params.length}`;
    }

    const result = await pool.query(
      `SELECT
         d.channel,
         COUNT(*)::int                              AS total,
         COUNT(*) FILTER (WHERE d.status = 'sent')::int   AS sent,
         COUNT(*) FILTER (WHERE d.status = 'failed')::int AS failed,
         ROUND(100.0 * COUNT(*) FILTER (WHERE d.status = 'sent') / NULLIF(COUNT(*),0), 1) AS success_pct
       FROM message_deliveries d
       JOIN messages m ON d.message_id = m.id
       WHERE d.created_at BETWEEN $1 AND $2 ${clientFilter}
       GROUP BY d.channel
       ORDER BY total DESC`,
      params
    );
    sendCsvOrJson(res, result.rows, 'analytics-delivery.csv', 'channels');
  } catch (err) { next(err); }
});

// GET /api/analytics/sla — SLA compliance over time
router.get('/sla', async (req, res, next) => {
  try {
    const { from, to, granularity } = parseRange(req);
    const params = [from, to];
    let clientFilter = '';
    if (req.query.client_id) {
      params.push(req.query.client_id);
      clientFilter = ` AND client_id = $${params.length}`;
    }

    const result = await pool.query(
      `SELECT
         date_trunc($3, started_at) AS bucket,
         COUNT(*)::int                                AS total_calls,
         COUNT(*) FILTER (WHERE sla_met = true)::int  AS sla_met,
         ROUND(100.0 * COUNT(*) FILTER (WHERE sla_met = true) / NULLIF(COUNT(*),0), 1) AS sla_pct
       FROM call_logs
       WHERE started_at BETWEEN $1 AND $2 AND answered_at IS NOT NULL ${clientFilter}
       GROUP BY bucket
       ORDER BY bucket ASC`,
      [...params, granularity]
    );
    if (res.req.query.format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="analytics-sla.csv"');
      return res.send(toCsv(result.rows));
    }
    res.json({ series: result.rows, granularity });
  } catch (err) { next(err); }
});

// GET /api/analytics/clients — top clients by message volume
router.get('/clients', async (req, res, next) => {
  try {
    const { from, to } = parseRange(req);
    const result = await pool.query(
      `SELECT
         c.id,
         c.name,
         COUNT(m.id)::int                                                    AS messages,
         COUNT(m.id) FILTER (WHERE m.urgency = 'high')::int                  AS high_urgency,
         COUNT(DISTINCT cl.id)::int                                          AS calls,
         COALESCE(AVG(EXTRACT(EPOCH FROM (cl.ended_at - cl.answered_at)))::int, 0) AS avg_handle_seconds
       FROM clients c
       LEFT JOIN messages m  ON m.client_id  = c.id AND m.created_at BETWEEN $1 AND $2
       LEFT JOIN call_logs cl ON cl.client_id = c.id AND cl.started_at BETWEEN $1 AND $2
       WHERE c.is_active = true
       GROUP BY c.id, c.name
       ORDER BY messages DESC, calls DESC
       LIMIT 50`,
      [from, to]
    );
    sendCsvOrJson(res, result.rows, 'analytics-clients.csv', 'clients');
  } catch (err) { next(err); }
});

// GET /api/analytics/operators — operator productivity
router.get('/operators', async (req, res, next) => {
  try {
    const { from, to } = parseRange(req);
    const result = await pool.query(
      `SELECT
         o.id,
         o.full_name,
         COUNT(DISTINCT cl.id)::int                                          AS calls_taken,
         COUNT(DISTINCT m.id)::int                                           AS messages_logged,
         COALESCE(AVG(EXTRACT(EPOCH FROM (cl.ended_at - cl.answered_at)))::int, 0) AS avg_handle_seconds,
         COALESCE(AVG(qa.overall_score)::numeric(3,1), NULL)                  AS avg_qa_score
       FROM operators o
       LEFT JOIN call_logs cl  ON cl.answered_by_id = o.id AND cl.answered_at BETWEEN $1 AND $2
       LEFT JOIN messages  m   ON m.operator_id     = o.id AND m.created_at  BETWEEN $1 AND $2
       LEFT JOIN call_qa_scores qa ON qa.scored_by  = o.id AND qa.created_at BETWEEN $1 AND $2
       WHERE o.is_active = true
       GROUP BY o.id, o.full_name
       ORDER BY calls_taken DESC, messages_logged DESC`,
      [from, to]
    );
    sendCsvOrJson(res, result.rows, 'analytics-operators.csv', 'operators');
  } catch (err) { next(err); }
});

module.exports = router;
