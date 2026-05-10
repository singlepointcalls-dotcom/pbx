'use strict';

/**
 * Operator shift scheduling and time-off requests.
 * Operators manage their own shifts; admins/supervisors manage all.
 */

const router = require('express').Router();
const pool = require('../../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');

router.use(requireAuth);

// ── Shifts ────────────────────────────────────────────────────────────────

// GET /api/shifts — list shifts (own, or all for admin/supervisor)
router.get('/', async (req, res, next) => {
  try {
    const { from, to, operator_id } = req.query;
    const isManager = ['admin', 'supervisor'].includes(req.operator.role);
    const targetId = isManager && operator_id ? operator_id : req.operator.id;

    const params = [targetId];
    let filter = 'WHERE s.operator_id = $1';
    if (isManager && !operator_id) {
      params.length = 0;
      filter = 'WHERE 1=1';
    }
    if (from) { params.push(from); filter += ` AND s.shift_date >= $${params.length}`; }
    if (to)   { params.push(to);   filter += ` AND s.shift_date <= $${params.length}`; }

    const result = await pool.query(
      `SELECT s.*, o.full_name AS operator_name
       FROM operator_shifts s
       JOIN operators o ON s.operator_id = o.id
       ${filter}
       ORDER BY s.shift_date ASC, s.start_time ASC`,
      params
    );
    res.json({ shifts: result.rows });
  } catch (err) { next(err); }
});

// GET /api/shifts/coverage?date=YYYY-MM-DD — who is on shift for a given date
router.get('/coverage', async (req, res, next) => {
  try {
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    const result = await pool.query(
      `SELECT s.*, o.full_name AS operator_name, o.extension, o.status AS operator_status
       FROM operator_shifts s
       JOIN operators o ON s.operator_id = o.id
       WHERE s.shift_date = $1 AND o.is_active = true
       ORDER BY s.start_time ASC`,
      [date]
    );
    res.json({ date, shifts: result.rows });
  } catch (err) { next(err); }
});

// POST /api/shifts — create a shift (admin/supervisor only)
router.post('/', requireRole('admin', 'supervisor'), async (req, res, next) => {
  try {
    const { operator_id, shift_date, start_time, end_time, shift_type = 'regular', notes } = req.body;
    if (!operator_id || !shift_date || !start_time || !end_time) {
      return res.status(400).json({ error: 'operator_id, shift_date, start_time, end_time are required' });
    }
    const VALID_TYPES = ['regular', 'oncall', 'training'];
    if (!VALID_TYPES.includes(shift_type)) {
      return res.status(400).json({ error: `shift_type must be one of: ${VALID_TYPES.join(', ')}` });
    }
    const result = await pool.query(
      `INSERT INTO operator_shifts (operator_id, shift_date, start_time, end_time, shift_type, notes)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING *`,
      [operator_id, shift_date, start_time, end_time, shift_type, notes || null]
    );
    res.status(201).json({ shift: result.rows[0] });
  } catch (err) { next(err); }
});

// PUT /api/shifts/:id — update a shift
router.put('/:id', requireRole('admin', 'supervisor'), async (req, res, next) => {
  try {
    const { shift_date, start_time, end_time, shift_type, notes } = req.body;
    const result = await pool.query(
      `UPDATE operator_shifts SET
         shift_date = COALESCE($1, shift_date),
         start_time = COALESCE($2, start_time),
         end_time   = COALESCE($3, end_time),
         shift_type = COALESCE($4, shift_type),
         notes      = COALESCE($5, notes)
       WHERE id = $6
       RETURNING *`,
      [shift_date, start_time, end_time, shift_type, notes, req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Shift not found' });
    res.json({ shift: result.rows[0] });
  } catch (err) { next(err); }
});

// DELETE /api/shifts/:id
router.delete('/:id', requireRole('admin', 'supervisor'), async (req, res, next) => {
  try {
    await pool.query('DELETE FROM operator_shifts WHERE id = $1', [req.params.id]);
    res.json({ message: 'Shift deleted' });
  } catch (err) { next(err); }
});

// ── Time-off requests ─────────────────────────────────────────────────────

// GET /api/shifts/timeoff — list time-off requests
router.get('/timeoff', async (req, res, next) => {
  try {
    const isManager = ['admin', 'supervisor'].includes(req.operator.role);
    const { status } = req.query;
    const params = isManager ? [] : [req.operator.id];
    let filter = isManager ? 'WHERE 1=1' : 'WHERE t.operator_id = $1';
    if (status) { params.push(status); filter += ` AND t.status = $${params.length}`; }

    const result = await pool.query(
      `SELECT t.*, o.full_name AS operator_name,
              r.full_name AS reviewed_by_name
       FROM time_off_requests t
       JOIN operators o ON t.operator_id = o.id
       LEFT JOIN operators r ON t.reviewed_by = r.id
       ${filter}
       ORDER BY t.created_at DESC`,
      params
    );
    res.json({ requests: result.rows });
  } catch (err) { next(err); }
});

// POST /api/shifts/timeoff — operator submits a time-off request
router.post('/timeoff', async (req, res, next) => {
  try {
    const { from_date, to_date, reason } = req.body;
    if (!from_date || !to_date) {
      return res.status(400).json({ error: 'from_date and to_date are required' });
    }
    if (new Date(to_date) < new Date(from_date)) {
      return res.status(400).json({ error: 'to_date must be on or after from_date' });
    }
    const result = await pool.query(
      `INSERT INTO time_off_requests (operator_id, from_date, to_date, reason)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [req.operator.id, from_date, to_date, reason || null]
    );
    res.status(201).json({ request: result.rows[0] });
  } catch (err) { next(err); }
});

// PUT /api/shifts/timeoff/:id — approve or deny (admin/supervisor)
router.put('/timeoff/:id', requireRole('admin', 'supervisor'), async (req, res, next) => {
  try {
    const { status } = req.body;
    if (!['approved', 'denied'].includes(status)) {
      return res.status(400).json({ error: 'status must be approved or denied' });
    }
    const result = await pool.query(
      `UPDATE time_off_requests
       SET status = $1, reviewed_by = $2, reviewed_at = NOW()
       WHERE id = $3
       RETURNING *`,
      [status, req.operator.id, req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Request not found' });
    res.json({ request: result.rows[0] });
  } catch (err) { next(err); }
});

// DELETE /api/shifts/timeoff/:id — operator cancels own pending request
router.delete('/timeoff/:id', async (req, res, next) => {
  try {
    const result = await pool.query(
      `DELETE FROM time_off_requests
       WHERE id = $1 AND operator_id = $2 AND status = 'pending'
       RETURNING id`,
      [req.params.id, req.operator.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Request not found or already reviewed' });
    res.json({ message: 'Request cancelled' });
  } catch (err) { next(err); }
});

module.exports = router;
