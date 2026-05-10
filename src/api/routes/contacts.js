'use strict';

const router = require('express').Router();
const pool = require('../../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');

router.use(requireAuth);

// GET /api/clients/:clientId/contacts
router.get('/:clientId/contacts', async (req, res, next) => {
  try {
    const params = [req.params.clientId];
    let tagFilter = '';
    if (req.query.tag) {
      params.push(req.query.tag.toLowerCase());
      tagFilter = `AND $${params.length} = ANY(c.tags)`;
    }
    const result = await pool.query(
      `SELECT c.*, d.name AS department_name
       FROM contacts c
       LEFT JOIN departments d ON c.department_id = d.id
       WHERE c.client_id = $1 ${tagFilter}
       ORDER BY c.priority ASC, c.name ASC`,
      params
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
      availability_type = 'always', availability_schedule = {},
      custom_fields = {},
    } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });

    const result = await pool.query(
      `INSERT INTO contacts
         (client_id, name, title, phone, email, sms_number,
          notify_email, notify_sms, notify_webhook, is_private, priority,
          department_id, call_action, transfer_extension, message_note,
          availability_type, availability_schedule, custom_fields)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       RETURNING *`,
      [
        req.params.clientId, name, title, phone, email, sms_number,
        notify_email, notify_sms, notify_webhook, is_private, priority,
        department_id || null, call_action, transfer_extension || null, message_note || null,
        availability_type, JSON.stringify(availability_schedule), JSON.stringify(custom_fields),
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
      availability_type, availability_schedule, custom_fields,
    } = req.body;

    const result = await pool.query(
      `UPDATE contacts SET
         name                  = COALESCE($1,  name),
         title                 = COALESCE($2,  title),
         phone                 = COALESCE($3,  phone),
         email                 = COALESCE($4,  email),
         sms_number            = COALESCE($5,  sms_number),
         notify_email          = COALESCE($6,  notify_email),
         notify_sms            = COALESCE($7,  notify_sms),
         notify_webhook        = COALESCE($8,  notify_webhook),
         is_private            = COALESCE($9,  is_private),
         priority              = COALESCE($10, priority),
         is_active             = COALESCE($11, is_active),
         department_id         = COALESCE($12, department_id),
         call_action           = COALESCE($13, call_action),
         transfer_extension    = COALESCE($14, transfer_extension),
         message_note          = COALESCE($15, message_note),
         availability_type     = COALESCE($16, availability_type),
         availability_schedule = COALESCE($17, availability_schedule),
         custom_fields         = COALESCE($18, custom_fields)
       WHERE id = $19 AND client_id = $20
       RETURNING *`,
      [
        name, title, phone, email, sms_number,
        notify_email, notify_sms, notify_webhook, is_private, priority, is_active,
        department_id !== undefined ? department_id : null,
        call_action, transfer_extension, message_note,
        availability_type || null,
        availability_schedule !== undefined ? JSON.stringify(availability_schedule) : null,
        custom_fields !== undefined ? JSON.stringify(custom_fields) : null,
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

// POST /api/clients/:clientId/contacts/:contactId/notify — quick email or SMS to a contact
router.post('/:clientId/contacts/:contactId/notify', requireRole('admin', 'supervisor', 'operator'), async (req, res, next) => {
  try {
    const { channel, subject, body } = req.body;
    if (!channel || !body) return res.status(400).json({ error: 'channel and body are required' });

    const result = await pool.query(
      `SELECT ct.*, cl.smtp_host, cl.smtp_port, cl.smtp_user, cl.smtp_from,
              cl.name AS client_name
       FROM contacts ct
       JOIN clients cl ON ct.client_id = cl.id
       WHERE ct.id = $1 AND ct.client_id = $2`,
      [req.params.contactId, req.params.clientId]
    );
    const contact = result.rows[0];
    if (!contact) return res.status(404).json({ error: 'Contact not found' });

    // Fetch SMTP pass separately so it's never in the response object
    if (channel === 'email') {
      const smtpResult = await pool.query(
        'SELECT smtp_pass FROM clients WHERE id = $1',
        [req.params.clientId]
      );
      contact.smtp_pass = smtpResult.rows[0]?.smtp_pass || null;
    }

    const { sendQuickNotify } = require('../../services/delivery');
    await sendQuickNotify(contact, channel, subject, body, req.operator);
    res.json({ sent: true });
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

// GET /api/clients/:clientId/contacts/import/template — download CSV template
router.get('/:clientId/contacts/import/template', requireRole('admin', 'supervisor'), (req, res) => {
  const header = 'name,email,phone,mobile,role,priority,notify_email,notify_sms,notify_phone_call\r\n';
  const example = '"Jane Smith","jane@example.com","+441234567890","+447700900123","Manager",1,true,true,false\r\n';
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="contacts-template.csv"');
  res.send(header + example);
});

// POST /api/clients/:clientId/contacts/import — bulk import contacts from CSV body (text/csv or multipart field)
router.post('/:clientId/contacts/import', requireRole('admin', 'supervisor'), async (req, res, next) => {
  try {
    // Accept raw CSV body or a 'csv' text field in JSON
    let csvText = '';
    const ct = req.headers['content-type'] || '';
    if (ct.includes('text/csv') || ct.includes('text/plain')) {
      csvText = req.body?.toString() || '';
    } else {
      csvText = req.body?.csv || '';
    }
    if (!csvText) return res.status(400).json({ error: 'CSV body required (Content-Type: text/csv or JSON {csv:"..."}' });

    const lines = csvText.split(/\r?\n/).filter(Boolean);
    if (lines.length < 2) return res.status(400).json({ error: 'CSV must have a header row and at least one data row' });

    const header = lines[0].split(',').map(h => h.replace(/^"|"$/g, '').trim().toLowerCase());
    const col = (row, name) => {
      const idx = header.indexOf(name);
      if (idx === -1) return undefined;
      return row[idx]?.replace(/^"|"$/g, '').trim() || null;
    };

    const parseBoolean = (v) => v === 'true' || v === '1' || v === 'yes';

    let imported = 0, skipped = 0;
    const errors = [];
    const clientId = req.params.clientId;

    for (let i = 1; i < lines.length; i++) {
      const row = lines[i].split(',');
      const name = col(row, 'name');
      const email = col(row, 'email');
      if (!name) { errors.push({ line: i + 1, error: 'name is required' }); skipped++; continue; }

      try {
        await pool.query(
          `INSERT INTO contacts
             (client_id, name, email, phone, mobile, role, priority, notify_email, notify_sms, notify_phone_call)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           ON CONFLICT (client_id, email) WHERE email IS NOT NULL
           DO UPDATE SET
             name = EXCLUDED.name, phone = EXCLUDED.phone, mobile = EXCLUDED.mobile,
             role = EXCLUDED.role, priority = EXCLUDED.priority,
             notify_email = EXCLUDED.notify_email, notify_sms = EXCLUDED.notify_sms,
             notify_phone_call = EXCLUDED.notify_phone_call`,
          [
            clientId, name, email,
            col(row, 'phone'), col(row, 'mobile'), col(row, 'role'),
            parseInt(col(row, 'priority') || '100', 10) || 100,
            parseBoolean(col(row, 'notify_email') ?? 'true'),
            parseBoolean(col(row, 'notify_sms') ?? 'false'),
            parseBoolean(col(row, 'notify_phone_call') ?? 'false'),
          ]
        );
        imported++;
      } catch (err) {
        errors.push({ line: i + 1, error: err.message });
        skipped++;
      }
    }

    res.json({ imported, skipped, errors });
  } catch (err) { next(err); }
});

// PATCH /api/clients/:clientId/contacts/:contactId/tags — set contact tags
router.patch('/:clientId/contacts/:contactId/tags', requireRole('admin', 'supervisor'), async (req, res, next) => {
  try {
    const { tags } = req.body;
    if (!Array.isArray(tags)) return res.status(400).json({ error: 'tags must be an array of strings' });
    const cleaned = tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean);
    const result = await pool.query(
      `UPDATE contacts SET tags = $1 WHERE id = $2 AND client_id = $3 RETURNING id, tags`,
      [cleaned, req.params.contactId, req.params.clientId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Contact not found' });
    res.json({ contact: result.rows[0] });
  } catch (err) { next(err); }
});

module.exports = router;
