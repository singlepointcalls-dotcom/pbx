'use strict';

/**
 * Operator leaderboard / gamification.
 * Aggregates calls answered, messages logged, QA scores, attendance.
 * Awards badges based on milestones.
 */

const router = require('express').Router();
const pool = require('../../config/database');
const { requireAuth } = require('../middleware/auth');

router.use(requireAuth);

const PERIODS = {
  today: "started_at >= date_trunc('day', NOW())",
  week:  "started_at >= date_trunc('week', NOW())",
  month: "started_at >= date_trunc('month', NOW())",
  all:   "1=1",
};

// GET /api/leaderboard?period=today|week|month|all
router.get('/', async (req, res, next) => {
  try {
    const period = req.query.period || 'week';
    const filter = PERIODS[period];
    if (!filter) return res.status(400).json({ error: 'Invalid period' });

    const result = await pool.query(
      `WITH call_stats AS (
         SELECT
           o.id AS operator_id,
           o.full_name,
           COUNT(cl.id)::int                                                          AS calls,
           COUNT(cl.id) FILTER (WHERE cl.sla_met = true)::int                         AS sla_met,
           COALESCE(AVG(EXTRACT(EPOCH FROM (cl.ended_at - cl.answered_at)))::int, 0) AS avg_handle_seconds
         FROM operators o
         LEFT JOIN call_logs cl ON cl.answered_by_id = o.id AND ${filter}
         WHERE o.is_active = true
         GROUP BY o.id, o.full_name
       ),
       msg_stats AS (
         SELECT
           m.operator_id,
           COUNT(*)::int                                                             AS messages,
           COUNT(*) FILTER (WHERE m.urgency = 'high')::int                            AS high_priority
         FROM messages m
         WHERE ${filter.replace('started_at', 'm.created_at')}
         GROUP BY m.operator_id
       ),
       qa_stats AS (
         SELECT
           qa.scored_by AS operator_id,
           ROUND(AVG(qa.overall_score)::numeric, 1)                                  AS avg_qa
         FROM call_qa_scores qa
         WHERE ${filter.replace('started_at', 'qa.created_at')}
         GROUP BY qa.scored_by
       )
       SELECT
         cs.operator_id,
         cs.full_name,
         cs.calls,
         cs.sla_met,
         cs.avg_handle_seconds,
         COALESCE(ms.messages, 0)      AS messages,
         COALESCE(ms.high_priority, 0) AS high_priority,
         qa.avg_qa,
         (cs.calls * 10 + COALESCE(ms.messages, 0) * 5 + cs.sla_met * 3 +
           COALESCE(qa.avg_qa, 0) * 20)::int AS score
       FROM call_stats cs
       LEFT JOIN msg_stats ms ON ms.operator_id = cs.operator_id
       LEFT JOIN qa_stats  qa ON qa.operator_id = cs.operator_id
       ORDER BY score DESC, cs.calls DESC
       LIMIT 100`
    );

    // Award badges
    const enriched = result.rows.map((row, idx) => ({
      ...row,
      rank: idx + 1,
      badges: computeBadges(row, idx),
    }));

    res.json({ period, leaderboard: enriched });
  } catch (err) { next(err); }
});

function computeBadges(row, rank) {
  const badges = [];
  if (rank === 0) badges.push({ icon: '👑', name: 'Top performer' });
  if (rank < 3)   badges.push({ icon: '🏆', name: 'Top 3' });
  if (row.calls >= 100)             badges.push({ icon: '📞', name: 'Century caller (100+)' });
  if (row.calls >= 500)             badges.push({ icon: '🌟', name: 'Marathon (500+)' });
  if (row.messages >= 50)           badges.push({ icon: '✉️', name: 'Message master (50+)' });
  if (row.high_priority >= 10)      badges.push({ icon: '🚨', name: 'Crisis handler' });
  if (row.avg_qa && row.avg_qa >= 9) badges.push({ icon: '⭐', name: 'Quality champion' });
  if (row.avg_handle_seconds > 0 && row.avg_handle_seconds < 90) badges.push({ icon: '⚡', name: 'Speed demon' });
  return badges;
}

// GET /api/leaderboard/me — current operator's stats and rank
router.get('/me', async (req, res, next) => {
  try {
    const period = req.query.period || 'week';
    const filter = PERIODS[period];
    if (!filter) return res.status(400).json({ error: 'Invalid period' });

    const result = await pool.query(
      `SELECT
         (SELECT COUNT(*) FROM call_logs cl WHERE cl.answered_by_id = $1 AND ${filter})::int AS calls,
         (SELECT COUNT(*) FROM messages  m  WHERE m.operator_id   = $1 AND ${filter.replace('started_at','m.created_at')})::int AS messages,
         (SELECT ROUND(AVG(qa.overall_score)::numeric, 1)
          FROM call_qa_scores qa WHERE qa.scored_by = $1 AND ${filter.replace('started_at','qa.created_at')}) AS avg_qa`,
      [req.operator.id]
    );
    res.json({ period, stats: result.rows[0] });
  } catch (err) { next(err); }
});

module.exports = router;
