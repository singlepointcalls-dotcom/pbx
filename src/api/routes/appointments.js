'use strict';

const router = require('express').Router();
const pool = require('../../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const { broadcast } = require('../../services/realtime');
const audit = require('../../services/audit');

router.use(requireAuth);

// GET /api/appointments — list with filters
router.get('/', async (req, res, next) => {
  try {
    const { client_id, status, from, to, upcoming } = req.query;
    const params = [];
    let where = 'WHERE 1=1';

    if (client_id) { params.push(client_id); where += ` AND a.client_id = $${params.length}`; }
    if (status)    { params.push(status);    where += ` AND a.status = $${params.length}`; }
    if (from)      { params.push(from);      where += ` AND a.appointment_at >= $${params.length}`; }
    if (to)        { params.push(to);        where += ` AND a.appointment_at <= $${params.length}`; }
    if (upcoming === 'true') {
      where += ' AND a.appointment_at >= NOW() AND a.status NOT IN (\'cancelled\',\'completed\',\'no_show\')';
    }

    const result = await pool.query(
      `SELECT a.*, c.name AS client_name, o.full_name AS operator_name
       FROM appointments a
       JOIN clients c ON a.client_id = c.id
       LEFT JOIN operators o ON a.operator_id = o.id
       ${where}
       ORDER BY a.appointment_at ASC`,
      params
    );
    res.json({ appointments: result.rows });
  } catch (err) { next(err); }
});

// GET /api/appointments/today — appointments for today (quick wallboard widget)
router.get('/today', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT a.*, c.name AS client_name
       FROM appointments a
       JOIN clients c ON a.client_id = c.id
       WHERE DATE(a.appointment_at AT TIME ZONE 'UTC') = CURRENT_DATE
         AND a.status NOT IN ('cancelled')
       ORDER BY a.appointment_at ASC`
    );
    res.json({ appointments: result.rows });
  } catch (err) { next(err); }
});

// GET /api/appointments/:id
router.get('/:id', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT a.*, c.name AS client_name, o.full_name AS operator_name
       FROM appointments a
       JOIN clients c ON a.client_id = c.id
       LEFT JOIN operators o ON a.operator_id = o.id
       WHERE a.id = $1`,
      [req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Appointment not found' });
    res.json({ appointment: result.rows[0] });
  } catch (err) { next(err); }
});

// POST /api/appointments
router.post('/', async (req, res, next) => {
  try {
    const {
      client_id, message_id, caller_name, caller_phone, caller_email,
      appointment_at, duration_minutes = 30, service_type, notes,
    } = req.body;

    if (!client_id || !appointment_at) {
      return res.status(400).json({ error: 'client_id and appointment_at are required' });
    }

    const apptDate = new Date(appointment_at);
    if (isNaN(apptDate.getTime()) || apptDate < new Date()) {
      return res.status(400).json({ error: 'appointment_at must be a valid future date/time' });
    }

    const result = await pool.query(
      `INSERT INTO appointments
         (client_id, message_id, operator_id, caller_name, caller_phone, caller_email,
          appointment_at, duration_minutes, service_type, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING *`,
      [
        client_id, message_id || null, req.operator.id,
        caller_name || null, caller_phone || null, caller_email || null,
        appointment_at, parseInt(duration_minutes),
        service_type || null, notes || null,
      ]
    );

    const appt = result.rows[0];
    broadcast('appointment:created', { appointment: appt });
    await audit.log(req, 'appointment.create', { resourceId: appt.id });
    res.status(201).json({ appointment: appt });
  } catch (err) { next(err); }
});

// PUT /api/appointments/:id
router.put('/:id', async (req, res, next) => {
  try {
    const {
      caller_name, caller_phone, caller_email, appointment_at,
      duration_minutes, service_type, notes, status,
    } = req.body;

    const VALID_STATUSES = ['confirmed', 'cancelled', 'completed', 'no_show', 'rescheduled'];
    if (status && !VALID_STATUSES.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${VALID_STATUSES.join(', ')}` });
    }

    const result = await pool.query(
      `UPDATE appointments SET
         caller_name      = COALESCE($1, caller_name),
         caller_phone     = COALESCE($2, caller_phone),
         caller_email     = COALESCE($3, caller_email),
         appointment_at   = COALESCE($4, appointment_at),
         duration_minutes = COALESCE($5, duration_minutes),
         service_type     = COALESCE($6, service_type),
         notes            = COALESCE($7, notes),
         status           = COALESCE($8, status),
         updated_at       = NOW()
       WHERE id = $9
       RETURNING *`,
      [
        caller_name || null, caller_phone || null, caller_email || null,
        appointment_at || null, duration_minutes ? parseInt(duration_minutes) : null,
        service_type || null, notes || null, status || null,
        req.params.id,
      ]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Appointment not found' });

    broadcast('appointment:updated', { appointment: result.rows[0] });
    await audit.log(req, 'appointment.update', { resourceId: req.params.id });
    res.json({ appointment: result.rows[0] });
  } catch (err) { next(err); }
});

// DELETE /api/appointments/:id (admin/supervisor only)
router.delete('/:id', requireRole('admin', 'supervisor'), async (req, res, next) => {
  try {
    const result = await pool.query(
      'DELETE FROM appointments WHERE id = $1 RETURNING id',
      [req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Appointment not found' });
    await audit.log(req, 'appointment.delete', { resourceId: req.params.id });
    res.json({ message: 'Appointment deleted' });
  } catch (err) { next(err); }
});

module.exports = router;
