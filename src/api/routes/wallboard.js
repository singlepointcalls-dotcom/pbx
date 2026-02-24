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
      });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
