'use strict';

const router = require('express').Router();
const pool = require('../../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');

// GET /api/wallboard — real-time stats for the wallboard
router.get(
  '/',
  requireAuth,
  requireRole('admin', 'supervisor', 'operator'),
  async (req, res, next) => {
    try {
      const [
        activeCallsResult,
        queueResult,
        todayCallsResult,
        todayAnsweredResult,
        todayMessagesResult,
        todayMissedResult,
        slaResult,
        avgHandleResult,
        unackMessagesResult,
        operatorsResult,
      ] = await Promise.all([
        // Active calls: answered but not yet ended
        pool.query(
          `SELECT COUNT(*) FROM call_logs
           WHERE call_end IS NULL AND call_answered IS NOT NULL`
        ),
        // Queued calls: started in last 5 minutes, not yet answered
        pool.query(
          `SELECT COUNT(*) FROM call_logs
           WHERE call_start >= NOW() - INTERVAL '5 minutes'
             AND call_answered IS NULL
             AND call_end IS NULL`
        ),
        // Total calls today
        pool.query(
          `SELECT COUNT(*) FROM call_logs WHERE call_start >= CURRENT_DATE`
        ),
        // Answered calls today
        pool.query(
          `SELECT COUNT(*) FROM call_logs
           WHERE call_start >= CURRENT_DATE AND call_answered IS NOT NULL`
        ),
        // Messages created today
        pool.query(
          `SELECT COUNT(*) FROM messages WHERE created_at >= CURRENT_DATE`
        ),
        // Missed calls today: ended without being answered
        pool.query(
          `SELECT COUNT(*) FROM call_logs
           WHERE call_start >= CURRENT_DATE
             AND call_answered IS NULL
             AND call_end IS NOT NULL`
        ),
        // SLA met percentage today (answered calls only)
        pool.query(
          `SELECT ROUND(
             100.0 * SUM(CASE WHEN sla_met THEN 1 ELSE 0 END) / NULLIF(COUNT(*), 0),
             1
           ) AS sla_pct
           FROM call_logs
           WHERE call_start >= CURRENT_DATE AND call_answered IS NOT NULL`
        ),
        // Average handle time in seconds today
        pool.query(
          `SELECT ROUND(AVG(duration_seconds)) AS avg_seconds
           FROM call_logs
           WHERE call_start >= CURRENT_DATE AND duration_seconds IS NOT NULL`
        ),
        // Unacknowledged delivered messages in the last 4 hours
        pool.query(
          `SELECT COUNT(*) FROM messages
           WHERE acknowledged_at IS NULL
             AND status = 'delivered'
             AND created_at >= NOW() - INTERVAL '4 hours'`
        ),
        // Active operators with their current status
        pool.query(
          `SELECT id, full_name, current_status, last_seen_at
           FROM operators
           WHERE is_active = true
           ORDER BY
             CASE current_status WHEN 'ready' THEN 0 WHEN 'busy' THEN 1 ELSE 2 END,
             full_name ASC`
        ),
      ]);

      res.json({
        stats: {
          active_calls:        parseInt(activeCallsResult.rows[0].count),
          queue_count:         parseInt(queueResult.rows[0].count),
          today_calls:         parseInt(todayCallsResult.rows[0].count),
          today_answered:      parseInt(todayAnsweredResult.rows[0].count),
          today_messages:      parseInt(todayMessagesResult.rows[0].count),
          today_missed:        parseInt(todayMissedResult.rows[0].count),
          sla_met_pct:         slaResult.rows[0].sla_pct !== null
                                 ? parseFloat(slaResult.rows[0].sla_pct)
                                 : null,
          avg_handle_seconds:  avgHandleResult.rows[0].avg_seconds !== null
                                 ? parseInt(avgHandleResult.rows[0].avg_seconds)
                                 : null,
          unack_messages:      parseInt(unackMessagesResult.rows[0].count),
        },
        operators: operatorsResult.rows,
      });
    } catch (err) {
      next(err);
    }
  }
);

// Inline auth for SSE: EventSource cannot send Authorization headers,
// so we accept the JWT as a query param for this one endpoint only.
function requireAuthSse(req, res, next) {
  const jwt = require('jsonwebtoken');
  const raw = req.query.token ||
    (req.headers.authorization || '').replace(/^Bearer /, '');
  if (!raw) return res.status(401).json({ error: 'Authentication required' });
  try {
    req.operator = jwt.verify(raw, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// GET /api/wallboard/live — SSE stream pushing stats every 10 s
// Clients: new EventSource('/api/wallboard/live?token=<jwt>')
router.get(
  '/live',
  requireAuthSse,
  requireRole('admin', 'supervisor', 'operator'),
  async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const sendStats = async () => {
      try {
        const [active, queue, todayCalls, answered, msgs, missed, sla, aht, unack, ops] =
          await Promise.all([
            pool.query(`SELECT COUNT(*) FROM call_logs WHERE call_end IS NULL AND call_answered IS NOT NULL`),
            pool.query(`SELECT COUNT(*) FROM call_logs WHERE call_start >= NOW() - INTERVAL '5 minutes' AND call_answered IS NULL AND call_end IS NULL`),
            pool.query(`SELECT COUNT(*) FROM call_logs WHERE call_start >= CURRENT_DATE`),
            pool.query(`SELECT COUNT(*) FROM call_logs WHERE call_start >= CURRENT_DATE AND call_answered IS NOT NULL`),
            pool.query(`SELECT COUNT(*) FROM messages WHERE created_at >= CURRENT_DATE`),
            pool.query(`SELECT COUNT(*) FROM call_logs WHERE call_start >= CURRENT_DATE AND call_answered IS NULL AND call_end IS NOT NULL`),
            pool.query(`SELECT ROUND(100.0*SUM(CASE WHEN sla_met THEN 1 ELSE 0 END)/NULLIF(COUNT(*),0),1) AS pct FROM call_logs WHERE call_start >= CURRENT_DATE AND call_answered IS NOT NULL`),
            pool.query(`SELECT ROUND(AVG(duration_seconds)) AS avg FROM call_logs WHERE call_start >= CURRENT_DATE AND duration_seconds IS NOT NULL`),
            pool.query(`SELECT COUNT(*) FROM messages WHERE acknowledged_at IS NULL AND status='delivered' AND created_at >= NOW() - INTERVAL '4 hours'`),
            pool.query(`SELECT id, full_name, current_status, last_seen_at FROM operators WHERE is_active = true ORDER BY CASE current_status WHEN 'ready' THEN 0 WHEN 'busy' THEN 1 ELSE 2 END, full_name ASC`),
          ]);
        const payload = JSON.stringify({
          active_calls: parseInt(active.rows[0].count),
          queue_count: parseInt(queue.rows[0].count),
          today_calls: parseInt(todayCalls.rows[0].count),
          today_answered: parseInt(answered.rows[0].count),
          today_messages: parseInt(msgs.rows[0].count),
          today_missed: parseInt(missed.rows[0].count),
          sla_met_pct: sla.rows[0].pct !== null ? parseFloat(sla.rows[0].pct) : null,
          avg_handle_seconds: aht.rows[0].avg !== null ? parseInt(aht.rows[0].avg) : null,
          unack_messages: parseInt(unack.rows[0].count),
          operators: ops.rows,
          ts: Date.now(),
        });
        res.write(`data: ${payload}\n\n`);
      } catch { /* ignore transient DB errors in stream */ }
    };

    await sendStats();
    const interval = setInterval(sendStats, 10000);
    req.on('close', () => clearInterval(interval));
  }
);

module.exports = router;
