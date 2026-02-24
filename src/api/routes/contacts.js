'use strict';

const router = require('express').Router();
const pool = require('../../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');

router.use(requireAuth);

// GET /api/clients/:clientId/contacts
router.get('/:clientId/contacts', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT c.*, d.name AS department_name
       FROM contacts c
       LEFT JOIN departments d ON c.department_id = d.id
       WHERE c.client_id = $1
       ORDER BY c.priority ASC, c.name ASC`,
      [req.params.clientId]
    );
    res.json({ contacts: result.rows });
  } catch (err) {
    next(err);
  }
});

// POST /api/clients/:clientId/contacts
router.post('/:clientId/contacts', requireRole('admin', 'supervisor'), async (req, res, next) => {
  try {
    const {
      name, title, phone, email, sms_number,
      notify_email = true, notify_sms = false, notify_webhook = false,
      is_private = false, priority = 1,
      department_id, call_action = 'message', transfer_extension, message_note,
    } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });

    const result = await pool.query(
      `INSERT INTO contacts
         (client_id, name, title, phone, email, sms_number,
          notify_email, notify_sms, notify_webhook, is_private, priority,
          department_id, call_action, transfer_extension, message_note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING *`,
      [
        req.params.clientId, name, title, phone, email, sms_number,
        notify_email, notify_sms, notify_webhook, is_private, priority,
        department_id || null, call_action, transfer_extension || null, message_note || null,
      ]
    );
    res.status(201).json({ contact: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// PUT /api/clients/:clientId/contacts/:contactId
router.put('/:clientId/contacts/:contactId', requireRole('admin', 'supervisor'), async (req, res, next) => {
  try {
    const {
      name, title, phone, email, sms_number,
      notify_email, notify_sms, notify_webhook, is_private, priority, is_active,
      department_id, call_action, transfer_extension, message_note,
    } = req.body;

    const result = await pool.query(
      `UPDATE contacts SET
         name               = COALESCE($1,  name),
         title              = COALESCE($2,  title),
         phone              = COALESCE($3,  phone),
         email              = COALESCE($4,  email),
         sms_number         = COALESCE($5,  sms_number),
         notify_email       = COALESCE($6,  notify_email),
         notify_sms         = COALESCE($7,  notify_sms),
         notify_webhook     = COALESCE($8,  notify_webhook),
         is_private         = COALESCE($9,  is_private),
         priority           = COALESCE($10, priority),
         is_active          = COALESCE($11, is_active),
         department_id      = COALESCE($12, department_id),
         call_action        = COALESCE($13, call_action),
         transfer_extension = COALESCE($14, transfer_extension),
         message_note       = COALESCE($15, message_note)
       WHERE id = $16 AND client_id = $17
       RETURNING *`,
      [
        name, title, phone, email, sms_number,
        notify_email, notify_sms, notify_webhook, is_private, priority, is_active,
        department_id !== undefined ? department_id : null,
        call_action, transfer_extension, message_note,
        req.params.contactId, req.params.clientId,
      ]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Contact not found' });
    res.json({ contact: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/clients/:clientId/contacts/:contactId
router.delete('/:clientId/contacts/:contactId', requireRole('admin', 'supervisor'), async (req, res, next) => {
  try {
    await pool.query(
      'DELETE FROM contacts WHERE id = $1 AND client_id = $2',
      [req.params.contactId, req.params.clientId]
    );
    res.json({ message: 'Contact deleted' });
  } catch (err) {
    next(err);
  }
});

// On-call schedule management
// GET /api/clients/:clientId/oncall
router.get('/:clientId/oncall', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT os.*, c.name AS contact_name, c.phone AS contact_phone
       FROM oncall_schedules os
       JOIN contacts c ON os.contact_id = c.id
       WHERE os.client_id = $1
       ORDER BY os.day_of_week, os.start_time`,
      [req.params.clientId]
    );
    res.json({ schedules: result.rows });
  } catch (err) {
    next(err);
  }
});

// POST /api/clients/:clientId/oncall
router.post('/:clientId/oncall', requireRole('admin', 'supervisor'), async (req, res, next) => {
  try {
    const { contact_id, day_of_week, start_time, end_time, override_start, override_end } = req.body;
    if (!contact_id) return res.status(400).json({ error: 'contact_id is required' });

    const result = await pool.query(
      `INSERT INTO oncall_schedules (client_id, contact_id, day_of_week, start_time, end_time, override_start, override_end)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [req.params.clientId, contact_id, day_of_week, start_time, end_time, override_start, override_end]
    );
    res.status(201).json({ schedule: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/clients/:clientId/oncall/:scheduleId
router.delete('/:clientId/oncall/:scheduleId', requireRole('admin', 'supervisor'), async (req, res, next) => {
  try {
    await pool.query(
      'DELETE FROM oncall_schedules WHERE id = $1 AND client_id = $2',
      [req.params.scheduleId, req.params.clientId]
    );
    res.json({ message: 'Schedule deleted' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
