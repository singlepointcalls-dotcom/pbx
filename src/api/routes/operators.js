'use strict';

const router = require('express').Router();
const bcrypt = require('bcryptjs');
const pool = require('../../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const { validatePassword } = require('./auth');
const audit = require('../../services/audit');

// Close any open status log entry and open a new one
async function logStatusChange(operatorId, newStatus) {
  const now = new Date();
  await pool.query(
    `UPDATE operator_status_log
     SET ended_at = $1,
         duration_seconds = EXTRACT(EPOCH FROM ($1 - started_at))::INTEGER
     WHERE operator_id = $2 AND ended_at IS NULL`,
    [now, operatorId]
  );
  await pool.query(
    `INSERT INTO operator_status_log (operator_id, status, started_at) VALUES ($1, $2, $3)`,
    [operatorId, newStatus, now]
  );
}

router.use(requireAuth);

// GET /api/operators
router.get('/', requireRole('admin', 'supervisor'), async (req, res, next) => {
  try {
    const result = await pool.query(
      'SELECT id, username, full_name, display_name, email, role, is_active, sip_extension, created_at FROM operators ORDER BY full_name'
    );
    res.json({ operators: result.rows });
  } catch (err) {
    next(err);
  }
});

// POST /api/operators
router.post('/', requireRole('admin'), async (req, res, next) => {
  try {
    const { username, password, full_name, email, role = 'operator' } = req.body;
    if (!username || !password || !full_name || !email) {
      return res.status(400).json({ error: 'username, password, full_name, and email are required' });
    }
    const pwErr = validatePassword(password);
    if (pwErr) return res.status(400).json({ error: pwErr });

    const hash = await bcrypt.hash(password, 12);
    const result = await pool.query(
      `INSERT INTO operators (username, password_hash, full_name, email, role)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, username, full_name, email, role, is_active, created_at`,
      [username, hash, full_name, email, role]
    );
    audit.log(req, 'operator.create', {
      resourceType: 'operator', resourceId: String(result.rows[0].id),
      details: { username, role, email },
    });
    res.status(201).json({ operator: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Username or email already exists' });
    next(err);
  }
});

// PUT /api/operators/:id
router.put('/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const { full_name, display_name, email, role, is_active, password, sip_extension } = req.body;
    let hash;
    if (password) {
      hash = await bcrypt.hash(password, 12);
    }

    const result = await pool.query(
      `UPDATE operators SET
         full_name = COALESCE($1, full_name),
         display_name = COALESCE($2, display_name),
         email = COALESCE($3, email),
         role = COALESCE($4, role),
         is_active = COALESCE($5, is_active),
         password_hash = COALESCE($6, password_hash),
         sip_extension = COALESCE($7, sip_extension)
       WHERE id = $8
       RETURNING id, username, full_name, display_name, email, role, is_active, sip_extension`,
      [full_name, display_name, email, role, is_active, hash, sip_extension || null, req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Operator not found' });
    audit.log(req, 'operator.update', {
      resourceType: 'operator', resourceId: req.params.id,
      details: { fields: Object.keys(req.body).filter((k) => k !== 'password') },
    });
    res.json({ operator: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// GET /api/operators/me — get own profile
router.get('/me', async (req, res, next) => {
  try {
    const r = await pool.query(
      `SELECT id, username, full_name, display_name, email, role, sip_extension,
              notify_new_message, notify_missed_call, notify_sla_breach, notify_escalation,
              totp_enabled, preferred_language, skills, is_active, created_at
         FROM operators WHERE id = $1`,
      [req.operator.id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Operator not found' });
    res.json({ operator: r.rows[0] });
  } catch (err) { next(err); }
});

// PATCH /api/operators/me — update own profile (non-admin fields only)
router.patch('/me', async (req, res, next) => {
  try {
    const { display_name, sip_extension, preferred_language } = req.body;
    const r = await pool.query(
      `UPDATE operators SET
         display_name       = COALESCE($1, display_name),
         sip_extension      = COALESCE($2, sip_extension),
         preferred_language = COALESCE($3, preferred_language)
       WHERE id = $4
       RETURNING id, username, full_name, display_name, email, role, sip_extension, preferred_language`,
      [display_name || null, sip_extension || null, preferred_language || null, req.operator.id]
    );
    res.json({ operator: r.rows[0] });
  } catch (err) { next(err); }
});

// PUT /api/operators/me/password — change own password
router.put('/me/password', async (req, res, next) => {
  try {
    const { current_password, new_password } = req.body;
    if (!current_password || !new_password) {
      return res.status(400).json({ error: 'current_password and new_password required' });
    }
    const pwErr = validatePassword(new_password);
    if (pwErr) return res.status(400).json({ error: pwErr });

    const result = await pool.query('SELECT * FROM operators WHERE id = $1', [req.operator.id]);
    const op = result.rows[0];
    if (!op || !(await bcrypt.compare(current_password, op.password_hash))) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    const hash = await bcrypt.hash(new_password, 12);
    await pool.query('UPDATE operators SET password_hash = $1 WHERE id = $2', [hash, req.operator.id]);
    res.json({ message: 'Password updated' });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/operators/me/notifications — update operator notification preferences
router.patch('/me/notifications', async (req, res, next) => {
  try {
    const allowed = ['notify_new_message', 'notify_missed_call', 'notify_sla_breach', 'notify_escalation'];
    const updates = {};
    for (const key of allowed) {
      if (typeof req.body[key] === 'boolean') updates[key] = req.body[key];
    }
    if (!Object.keys(updates).length) return res.status(400).json({ error: 'No valid notification fields provided' });
    const sets = Object.keys(updates).map((k, i) => `${k} = $${i + 1}`).join(', ');
    const vals = [...Object.values(updates), req.operator.id];
    await pool.query(
      `UPDATE operators SET ${sets} WHERE id = $${vals.length}`,
      vals
    );
    res.json({ message: 'Notification preferences updated' });
  } catch (err) { next(err); }
});

// DELETE /api/operators/:id/2fa — admin reset 2FA for any operator
router.delete('/:id/2fa', requireRole('admin'), async (req, res, next) => {
  try {
    await pool.query(
      'UPDATE operators SET totp_secret = NULL, totp_enabled = false WHERE id = $1',
      [req.params.id]
    );
    res.json({ message: '2FA reset for operator' });
  } catch (err) { next(err); }
});

// POST /api/operators/me/status — update own status
router.post('/me/status', async (req, res, next) => {
  try {
    const { status } = req.body;
    const allowed = ['ready', 'busy', 'break', 'lunch', 'comfort', 'training', 'admin', 'meeting', 'offline'];
    if (!allowed.includes(status)) return res.status(400).json({ error: 'Invalid status' });
    await pool.query(
      'UPDATE operators SET current_status = $1, status_changed_at = NOW() WHERE id = $2',
      [status, req.operator.id]
    );
    await logStatusChange(req.operator.id, status);
    const { broadcast } = require('../../services/realtime');
    broadcast('operator:status_change', { operator_id: req.operator.id, status });
    res.json({ status });
  } catch (err) { next(err); }
});

// POST /api/operators/me/break/start — log start of break
router.post('/me/break/start', async (req, res, next) => {
  try {
    const { break_type = 'break', notes } = req.body;
    const allowed = ['break', 'lunch', 'comfort', 'training', 'admin', 'meeting'];
    if (!allowed.includes(break_type)) return res.status(400).json({ error: 'Invalid break_type' });
    await pool.query(
      `UPDATE operator_breaks SET ended_at = NOW()
       WHERE operator_id = $1 AND ended_at IS NULL`,
      [req.operator.id]
    );
    const result = await pool.query(
      `INSERT INTO operator_breaks (operator_id, break_type, notes)
       VALUES ($1, $2, $3) RETURNING *`,
      [req.operator.id, break_type, notes || null]
    );
    await pool.query(
      'UPDATE operators SET current_status = $1, status_changed_at = NOW() WHERE id = $2',
      [break_type, req.operator.id]
    );
    await logStatusChange(req.operator.id, break_type);
    res.json({ break: result.rows[0] });
  } catch (err) { next(err); }
});

// POST /api/operators/me/break/end — log end of break
router.post('/me/break/end', async (req, res, next) => {
  try {
    await pool.query(
      `UPDATE operator_breaks SET ended_at = NOW()
       WHERE operator_id = $1 AND ended_at IS NULL`,
      [req.operator.id]
    );
    await pool.query(
      'UPDATE operators SET current_status = $1, status_changed_at = NOW() WHERE id = $2',
      ['ready', req.operator.id]
    );
    await logStatusChange(req.operator.id, 'ready');
    res.json({ message: 'Break ended' });
  } catch (err) { next(err); }
});

// GET /api/operators/me/breaks — today's break log
router.get('/me/breaks', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT * FROM operator_breaks
       WHERE operator_id = $1 AND started_at >= CURRENT_DATE
       ORDER BY started_at DESC`,
      [req.operator.id]
    );
    res.json({ breaks: result.rows });
  } catch (err) { next(err); }
});

// GET /api/operators/me/time-report — own status time breakdown
// GET /api/operators/time-report?operator_id=uuid — admin view of any operator
router.get('/me/time-report', async (req, res, next) => {
  try {
    const { period = 'day' } = req.query;
    const rows = await queryTimeReport(req.operator.id, period);
    res.json({ operator_id: req.operator.id, period, rows });
  } catch (err) { next(err); }
});

router.get('/time-report', requireRole('admin', 'supervisor'), async (req, res, next) => {
  try {
    const { operator_id, period = 'day' } = req.query;
    if (!operator_id) return res.status(400).json({ error: 'operator_id required' });
    const rows = await queryTimeReport(operator_id, period);
    res.json({ operator_id, period, rows });
  } catch (err) { next(err); }
});

// GET /api/operators/time-report/all — summary for all operators (admin)
router.get('/time-report/all', requireRole('admin', 'supervisor'), async (req, res, next) => {
  try {
    const { period = 'day' } = req.query;
    const since = periodStart(period);
    const result = await pool.query(
      `SELECT o.id, o.full_name, o.username,
              sl.status,
              COUNT(*)::INT AS occurrences,
              SUM(COALESCE(sl.duration_seconds,
                EXTRACT(EPOCH FROM (NOW() - sl.started_at))::INTEGER))::INT AS total_seconds
       FROM operator_status_log sl
       JOIN operators o ON o.id = sl.operator_id
       WHERE sl.started_at >= $1
       GROUP BY o.id, o.full_name, o.username, sl.status
       ORDER BY o.full_name, total_seconds DESC`,
      [since]
    );
    res.json({ period, rows: result.rows });
  } catch (err) { next(err); }
});

function periodStart(period) {
  const now = new Date();
  switch (period) {
    case 'week':  { const d = new Date(now); d.setDate(d.getDate() - 7); return d; }
    case 'month': { const d = new Date(now); d.setMonth(d.getMonth() - 1); return d; }
    case 'year':  { const d = new Date(now); d.setFullYear(d.getFullYear() - 1); return d; }
    default:      return new Date(now.getFullYear(), now.getMonth(), now.getDate()); // today
  }
}

async function queryTimeReport(operatorId, period) {
  const since = periodStart(period);
  const result = await pool.query(
    `SELECT
       status,
       COUNT(*)::INT                                                                       AS occurrences,
       SUM(COALESCE(duration_seconds,
         EXTRACT(EPOCH FROM (NOW() - started_at))::INTEGER))::INT                         AS total_seconds,
       ROUND(AVG(COALESCE(duration_seconds,
         EXTRACT(EPOCH FROM (NOW() - started_at))::INTEGER)))::INT                        AS avg_seconds,
       MIN(started_at)                                                                     AS first_seen,
       MAX(COALESCE(ended_at, NOW()))                                                      AS last_seen
     FROM operator_status_log
     WHERE operator_id = $1
       AND started_at >= $2
     GROUP BY status
     ORDER BY total_seconds DESC`,
    [operatorId, since]
  );
  const grand = result.rows.reduce((s, r) => s + (r.total_seconds || 0), 0);
  return result.rows.map(r => ({
    ...r,
    pct: grand > 0 ? Math.round((r.total_seconds / grand) * 100) : 0,
  }));
}

// GET /api/operators/performance — operator performance stats (admin/supervisor)
router.get('/performance', requireRole('admin', 'supervisor'), async (req, res, next) => {
  try {
    const days = parseInt(req.query.days || '30');
    const result = await pool.query(
      `SELECT o.id, o.full_name, o.username,
              COUNT(cl.id) FILTER (WHERE cl.call_answered IS NOT NULL) AS calls_answered,
              COUNT(cl.id) FILTER (WHERE cl.call_answered IS NULL AND cl.call_end IS NOT NULL) AS calls_missed,
              ROUND(AVG(cl.duration_seconds) FILTER (WHERE cl.duration_seconds IS NOT NULL)) AS avg_duration_seconds,
              COUNT(m.id) AS messages_taken,
              ROUND(AVG(q.overall)) AS avg_qa_score
       FROM operators o
       LEFT JOIN call_logs cl ON cl.operator_id = o.id AND cl.call_start >= NOW() - ($1 || ' days')::INTERVAL
       LEFT JOIN messages m ON m.operator_id = o.id AND m.created_at >= NOW() - ($1 || ' days')::INTERVAL
       LEFT JOIN call_qa_scores q ON q.call_log_id = cl.id
       WHERE o.is_active = true
       GROUP BY o.id, o.full_name, o.username
       ORDER BY calls_answered DESC`,
      [days]
    );
    res.json({ performance: result.rows, days });
  } catch (err) { next(err); }
});

// GET /api/operators/:id/targets — get performance targets for an operator
router.get('/:id/targets', requireRole('admin', 'supervisor'), async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT ot.*, o.full_name, o.username
       FROM operator_targets ot
       JOIN operators o ON ot.operator_id = o.id
       WHERE ot.operator_id = $1`,
      [req.params.id]
    );
    res.json({ targets: result.rows[0] || null });
  } catch (err) { next(err); }
});

// PUT /api/operators/:id/targets — create or update performance targets
router.put('/:id/targets', requireRole('admin', 'supervisor'), async (req, res, next) => {
  try {
    const { calls_per_day = 0, messages_per_day = 0, qa_score_target = 0 } = req.body;
    if (qa_score_target < 0 || qa_score_target > 100) {
      return res.status(400).json({ error: 'qa_score_target must be between 0 and 100' });
    }
    const result = await pool.query(
      `INSERT INTO operator_targets (operator_id, calls_per_day, messages_per_day, qa_score_target, updated_at)
       VALUES ($1,$2,$3,$4,NOW())
       ON CONFLICT (operator_id) DO UPDATE SET
         calls_per_day    = EXCLUDED.calls_per_day,
         messages_per_day = EXCLUDED.messages_per_day,
         qa_score_target  = EXCLUDED.qa_score_target,
         updated_at       = NOW()
       RETURNING *`,
      [req.params.id, calls_per_day, messages_per_day, qa_score_target]
    );
    audit.log(req, 'operator.targets_update', {
      resourceType: 'operator', resourceId: req.params.id,
      details: { calls_per_day, messages_per_day, qa_score_target },
    });
    res.json({ targets: result.rows[0] });
  } catch (err) { next(err); }
});

// GET /api/operators/targets/all — all operators with targets + today's progress
router.get('/targets/all', requireRole('admin', 'supervisor'), async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT o.id, o.full_name, o.username,
              COALESCE(ot.calls_per_day, 0)    AS target_calls,
              COALESCE(ot.messages_per_day, 0) AS target_messages,
              COALESCE(ot.qa_score_target, 0)  AS target_qa,
              COUNT(DISTINCT cl.id) FILTER (WHERE cl.call_start >= CURRENT_DATE AND cl.call_answered IS NOT NULL) AS today_calls,
              COUNT(DISTINCT m.id)  FILTER (WHERE m.created_at  >= CURRENT_DATE) AS today_messages,
              ROUND(AVG(q.overall) FILTER (WHERE q.created_at >= CURRENT_DATE)) AS today_qa
       FROM operators o
       LEFT JOIN operator_targets ot ON ot.operator_id = o.id
       LEFT JOIN call_logs cl ON cl.operator_id = o.id
       LEFT JOIN messages m ON m.operator_id = o.id
       LEFT JOIN call_qa_scores q ON q.call_log_id = cl.id
       WHERE o.is_active = true
       GROUP BY o.id, o.full_name, o.username, ot.calls_per_day, ot.messages_per_day, ot.qa_score_target
       ORDER BY o.full_name`
    );
    res.json({ targets: result.rows });
  } catch (err) { next(err); }
});

// GET /api/operators/presence — live status snapshot for supervisor team view
router.get('/presence', requireRole('admin', 'supervisor'), async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT
         o.id, o.full_name, o.username, o.role,
         o.current_status, o.status_changed_at,
         o.is_active,
         -- On break?
         EXISTS (
           SELECT 1 FROM operator_breaks ob
           WHERE ob.operator_id = o.id AND ob.ended_at IS NULL
         ) AS is_on_break,
         -- Break type
         (SELECT ob.break_type FROM operator_breaks ob
          WHERE ob.operator_id = o.id AND ob.ended_at IS NULL
          ORDER BY ob.started_at DESC LIMIT 1) AS break_type,
         -- Active call?
         EXISTS (
           SELECT 1 FROM call_logs cl
           WHERE cl.operator_id = o.id AND cl.call_end IS NULL AND cl.call_answered IS NOT NULL
         ) AS is_on_call,
         -- Today stats
         COUNT(DISTINCT cl.id) FILTER (WHERE cl.call_start >= CURRENT_DATE) AS calls_today,
         COUNT(DISTINCT m.id)  FILTER (WHERE m.created_at  >= CURRENT_DATE) AS messages_today
       FROM operators o
       LEFT JOIN call_logs cl ON cl.operator_id = o.id
       LEFT JOIN messages m   ON m.operator_id  = o.id
       WHERE o.is_active = true
       GROUP BY o.id, o.full_name, o.username, o.role, o.current_status, o.status_changed_at, o.is_active
       ORDER BY o.full_name`
    );
    res.json({ operators: result.rows });
  } catch (err) { next(err); }
});

module.exports = router;
