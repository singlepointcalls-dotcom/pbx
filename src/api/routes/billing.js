'use strict';

const router = require('express').Router();
const pool = require('../../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');

/* ============================================================
   Billing — monthly reports per client
   Schema stores plan config and auto-generates monthly summaries
   ============================================================ */

router.use(requireAuth);

/* ---- Plan management (admin) ---- */

// GET /api/billing/plans/:clientId
router.get('/plans/:clientId', requireRole('admin', 'supervisor'), async (req, res, next) => {
  try {
    const result = await pool.query(
      'SELECT * FROM billing_plans WHERE client_id = $1',
      [req.params.clientId]
    );
    res.json({ plan: result.rows[0] || null });
  } catch (err) { next(err); }
});

// PUT /api/billing/plans/:clientId — create or update plan
router.put('/plans/:clientId', requireRole('admin'), async (req, res, next) => {
  try {
    const {
      plan_name, monthly_fee, included_calls, included_minutes, included_admin_minutes,
      extra_call_rate, extra_minute_rate, extra_admin_rate, currency = 'GBP',
    } = req.body;

    const result = await pool.query(
      `INSERT INTO billing_plans
         (client_id, plan_name, monthly_fee, included_calls, included_minutes,
          included_admin_minutes, extra_call_rate, extra_minute_rate, extra_admin_rate, currency)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (client_id) DO UPDATE SET
         plan_name = $2, monthly_fee = $3, included_calls = $4,
         included_minutes = $5, included_admin_minutes = $6,
         extra_call_rate = $7, extra_minute_rate = $8,
         extra_admin_rate = $9, currency = $10, updated_at = NOW()
       RETURNING *`,
      [req.params.clientId, plan_name, monthly_fee, included_calls, included_minutes,
       included_admin_minutes, extra_call_rate, extra_minute_rate, extra_admin_rate, currency]
    );
    res.json({ plan: result.rows[0] });
  } catch (err) { next(err); }
});

/* ---- Monthly report generation ---- */

// GET /api/billing/reports/:clientId?year=2025&month=1
router.get('/reports/:clientId', requireRole('admin', 'supervisor'), async (req, res, next) => {
  try {
    const { year, month } = req.query;
    let query = 'SELECT * FROM billing_reports WHERE client_id = $1';
    const params = [req.params.clientId];
    if (year) { params.push(year); query += ` AND year = $${params.length}`; }
    if (month) { params.push(month); query += ` AND month = $${params.length}`; }
    query += ' ORDER BY year DESC, month DESC';
    const result = await pool.query(query, params);
    res.json({ reports: result.rows });
  } catch (err) { next(err); }
});

// POST /api/billing/reports/:clientId/generate — generate report for a month
router.post('/reports/:clientId/generate', requireRole('admin'), async (req, res, next) => {
  try {
    const { year, month } = req.body;
    if (!year || !month) return res.status(400).json({ error: 'year and month required' });

    const startDate = new Date(year, month - 1, 1);
    const endDate   = new Date(year, month, 1);

    // Pull call stats
    const callStats = await pool.query(
      `SELECT
         COUNT(*) AS total_calls,
         COUNT(*) FILTER (WHERE disposition = 'answered') AS answered_calls,
         COUNT(*) FILTER (WHERE disposition = 'no_answer') AS missed_calls,
         COALESCE(SUM(duration_seconds) FILTER (WHERE disposition = 'answered'), 0) AS total_seconds
       FROM call_logs
       WHERE client_id = $1 AND call_start >= $2 AND call_start < $3`,
      [req.params.clientId, startDate, endDate]
    );

    // Pull message/admin stats
    const msgStats = await pool.query(
      `SELECT COUNT(*) AS total_messages FROM messages
       WHERE client_id = $1 AND created_at >= $2 AND created_at < $3`,
      [req.params.clientId, startDate, endDate]
    );

    // Pull billing plan
    const planResult = await pool.query(
      'SELECT * FROM billing_plans WHERE client_id = $1',
      [req.params.clientId]
    );
    const plan = planResult.rows[0];

    const stats = callStats.rows[0];
    const totalCalls   = parseInt(stats.total_calls);
    const totalMinutes = Math.ceil(parseInt(stats.total_seconds) / 60);
    const totalMessages = parseInt(msgStats.rows[0].total_messages);
    // Admin time estimate: 3 minutes per message taken
    const adminMinutes = totalMessages * 3;

    let amountDue = plan ? parseFloat(plan.monthly_fee) : 0;
    let breakdown = {};

    if (plan) {
      const extraCalls   = Math.max(0, totalCalls - (plan.included_calls || 0));
      const extraMins    = Math.max(0, totalMinutes - (plan.included_minutes || 0));
      const extraAdmin   = Math.max(0, adminMinutes - (plan.included_admin_minutes || 0));
      const extraCost    = (extraCalls * (plan.extra_call_rate || 0)) +
                           (extraMins  * (plan.extra_minute_rate || 0)) +
                           (extraAdmin * (plan.extra_admin_rate || 0));
      amountDue += extraCost;
      breakdown = {
        plan_fee: plan.monthly_fee,
        included_calls: plan.included_calls,
        included_minutes: plan.included_minutes,
        included_admin_minutes: plan.included_admin_minutes,
        extra_calls: extraCalls,
        extra_minutes: extraMins,
        extra_admin_minutes: extraAdmin,
        extra_cost: extraCost.toFixed(2),
        currency: plan.currency,
      };
    }

    const result = await pool.query(
      `INSERT INTO billing_reports
         (client_id, year, month, total_calls, answered_calls, missed_calls,
          total_minutes, admin_minutes, total_messages, amount_due, currency, breakdown, generated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW())
       ON CONFLICT (client_id, year, month) DO UPDATE SET
         total_calls = $4, answered_calls = $5, missed_calls = $6,
         total_minutes = $7, admin_minutes = $8, total_messages = $9,
         amount_due = $10, breakdown = $12, generated_at = NOW()
       RETURNING *`,
      [
        req.params.clientId, year, month,
        totalCalls, parseInt(stats.answered_calls), parseInt(stats.missed_calls),
        totalMinutes, adminMinutes, totalMessages,
        amountDue.toFixed(2),
        plan?.currency || 'GBP',
        JSON.stringify(breakdown),
      ]
    );
    res.json({ report: result.rows[0] });
  } catch (err) { next(err); }
});

/* ---- Portal: client can view their own reports ---- */
const jwt = require('jsonwebtoken');

function requirePortalAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const payload = jwt.verify(auth.split(' ')[1], process.env.JWT_SECRET);
    if (payload.type !== 'portal') return res.status(403).json({ error: 'Forbidden' });
    req.portalUser = payload;
    next();
  } catch { res.status(401).json({ error: 'Invalid token' }); }
}

// GET /api/billing/portal/reports
router.get('/portal/reports', requirePortalAuth, async (req, res, next) => {
  try {
    const result = await pool.query(
      'SELECT * FROM billing_reports WHERE client_id = $1 ORDER BY year DESC, month DESC LIMIT 24',
      [req.portalUser.client_id]
    );
    const planResult = await pool.query(
      'SELECT plan_name, monthly_fee, included_calls, included_minutes, currency FROM billing_plans WHERE client_id = $1',
      [req.portalUser.client_id]
    );
    res.json({ reports: result.rows, plan: planResult.rows[0] || null });
  } catch (err) { next(err); }
});

module.exports = router;
