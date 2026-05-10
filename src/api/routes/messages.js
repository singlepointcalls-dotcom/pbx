'use strict';

const router = require('express').Router();
const pool = require('../../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const { deliverMessage } = require('../../services/delivery');
const { broadcast, broadcastToPortalClient } = require('../../services/realtime');

router.use(requireAuth);

/* ---- Auto-reply helper ---- */
async function sendAutoReply(message) {
  const clientResult = await pool.query(
    `SELECT c.name AS client_name, c.smtp_host, c.smtp_port, c.smtp_user, c.smtp_from,
            c.auto_reply_enabled, c.auto_reply_subject, c.auto_reply_body, c.smtp_pass
     FROM clients c WHERE c.id = $1`,
    [message.client_id]
  );
  const client = clientResult.rows[0];
  if (!client?.auto_reply_enabled) return;

  // Need a caller email — look it up from contacts
  const contactResult = await pool.query(
    `SELECT email FROM contacts WHERE client_id = $1 AND phone = $2 AND email IS NOT NULL LIMIT 1`,
    [message.client_id, message.caller_phone]
  );
  const callerEmail = contactResult.rows[0]?.email;
  if (!callerEmail) return;

  const nodemailer = require('nodemailer');
  const { assertValidEmail } = require('../../services/delivery');
  try { (require('../../services/delivery')._assertValidEmail || (() => {}))(callerEmail); } catch { return; }

  const subject = (client.auto_reply_subject || `We received your message — ${client.client_name}`)
    .replace(/\{client\}/g, client.client_name)
    .replace(/\{name\}/g, message.caller_name || 'Customer');
  const body = (client.auto_reply_body ||
    `Dear ${message.caller_name || 'Customer'},\n\nThank you for contacting ${client.client_name}. We have received your message and will be in touch shortly.\n\nKind regards,\n${client.client_name}`)
    .replace(/\{client\}/g, client.client_name)
    .replace(/\{name\}/g, message.caller_name || 'Customer')
    .replace(/\{subject\}/g, message.subject || '');

  const transporter = nodemailer.createTransport({
    host: client.smtp_host || process.env.SMTP_HOST,
    port: parseInt(client.smtp_port || process.env.SMTP_PORT || '587'),
    secure: (client.smtp_host ? false : process.env.SMTP_SECURE === 'true'),
    auth: (client.smtp_user || process.env.SMTP_USER) ? {
      user: client.smtp_user || process.env.SMTP_USER,
      pass: client.smtp_pass || process.env.SMTP_PASS,
    } : undefined,
  });

  await transporter.sendMail({
    from: client.smtp_from || process.env.SMTP_FROM || process.env.SMTP_USER,
    to: callerEmail,
    subject,
    text: body,
  });
}

// GET /api/messages
router.get('/', async (req, res, next) => {
  try {
    const { client_id, status, urgency, from, to, tag, assigned_to, caller_phone, limit = 50, offset = 0 } = req.query;
    let query = `
      SELECT m.*, c.name AS client_name, o.full_name AS operator_name,
             ao.full_name AS assigned_to_name
      FROM messages m
      LEFT JOIN clients c ON m.client_id = c.id
      LEFT JOIN operators o ON m.operator_id = o.id
      LEFT JOIN operators ao ON m.assigned_to = ao.id
      WHERE 1=1
    `;
    const params = [];

    if (client_id) {
      params.push(client_id);
      query += ` AND m.client_id = $${params.length}`;
    }
    if (status) {
      params.push(status);
      query += ` AND m.status = $${params.length}`;
    }
    if (urgency) {
      params.push(urgency);
      query += ` AND m.urgency = $${params.length}`;
    }
    if (from) {
      params.push(from);
      query += ` AND m.created_at >= $${params.length}`;
    }
    if (to) {
      params.push(to);
      query += ` AND m.created_at < ($${params.length}::date + INTERVAL '1 day')`;
    }
    if (tag) {
      params.push(tag);
      query += ` AND $${params.length} = ANY(m.tags)`;
    }
    if (assigned_to === 'me') {
      params.push(req.operator.id);
      query += ` AND m.assigned_to = $${params.length}`;
    } else if (assigned_to === 'unassigned') {
      query += ` AND m.assigned_to IS NULL`;
    } else if (assigned_to) {
      params.push(assigned_to);
      query += ` AND m.assigned_to = $${params.length}`;
    }
    if (caller_phone) {
      params.push(caller_phone);
      query += ` AND m.caller_phone = $${params.length}`;
    }
    if (req.query.flagged === 'true') {
      query += ` AND m.is_flagged = true`;
    }

    // Count uses the same filters captured before adding LIMIT/OFFSET
    const filterParams = params.slice();
    const countQuery = query.replace(
      'SELECT m.*, c.name AS client_name, o.full_name AS operator_name',
      'SELECT COUNT(*)'
    );

    // CSV export (admin/supervisor only; client_id required for per-client data isolation)
    if (req.query.format === 'csv') {
      if (!['admin', 'supervisor'].includes(req.operator?.role)) {
        return res.status(403).json({ error: 'CSV export requires admin or supervisor role' });
      }
      if (!client_id) {
        return res.status(400).json({ error: 'client_id is required for CSV export' });
      }
      const csvResult = await pool.query(query + ' ORDER BY m.created_at DESC LIMIT 50000', params);
      const cols = ['id','client_name','operator_name','caller_name','caller_phone','caller_company','subject','body','urgency','status','created_at'];
      const header = cols.join(',');
      // Prefix cells that start with formula chars to prevent CSV injection
      const sanitizeCsv = (v) => {
        const s = String(v ?? '').replace(/"/g, '""');
        return /^[=+\-@\t\r]/.test(s) ? `"'${s}"` : `"${s}"`;
      };
      const rows = csvResult.rows.map((r) => cols.map((c) => sanitizeCsv(r[c])).join(','));
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="messages.csv"');
      return res.send([header, ...rows].join('\r\n'));
    }

    const safeLimit  = Math.min(Math.max(1, parseInt(limit)  || 50), 500);
    const safeOffset = Math.max(0, parseInt(offset) || 0);
    params.push(safeLimit, safeOffset);
    query += ` ORDER BY m.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`;

    const [result, countResult] = await Promise.all([
      pool.query(query, params),
      pool.query(countQuery, filterParams),
    ]);

    res.json({ messages: result.rows, total: parseInt(countResult.rows[0].count) });
  } catch (err) {
    next(err);
  }
});

// GET /api/messages/:id
router.get('/:id', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT m.*, c.name AS client_name, o.full_name AS operator_name,
              ao.full_name AS assigned_to_name
       FROM messages m
       LEFT JOIN clients c ON m.client_id = c.id
       LEFT JOIN operators o ON m.operator_id = o.id
       LEFT JOIN operators ao ON m.assigned_to = ao.id
       WHERE m.id = $1`,
      [req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Message not found' });

    const deliveries = await pool.query(
      'SELECT * FROM message_deliveries WHERE message_id = $1 ORDER BY created_at DESC',
      [req.params.id]
    );

    res.json({ message: result.rows[0], deliveries: deliveries.rows });
  } catch (err) {
    next(err);
  }
});

// POST /api/messages — create a new message
router.post('/', async (req, res, next) => {
  try {
    const {
      call_log_id,
      client_id,
      caller_name,
      caller_phone,
      caller_company,
      subject,
      body,
      urgency = 'normal',
      call_type = 'standard',
      is_no_charge = false,
      auto_deliver = false,
      form_data,
    } = req.body;

    if (!client_id) return res.status(400).json({ error: 'client_id is required' });
    if (call_type === 'standard' && !body) {
      return res.status(400).json({ error: 'body is required for standard calls' });
    }

    // Auto no-charge for certain call types
    const noCharge = is_no_charge || call_type === 'sales' || call_type === 'wrong_number';

    const result = await pool.query(
      `INSERT INTO messages
         (call_log_id, client_id, operator_id, caller_name, caller_phone,
          caller_company, subject, body, urgency, call_type, is_no_charge, form_data)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING *`,
      [
        call_log_id, client_id, req.operator.id,
        caller_name, caller_phone, caller_company,
        subject, body || '', urgency,
        call_type, noCharge,
        form_data ? JSON.stringify(form_data) : null,
      ]
    );

    const message = result.rows[0];

    // Broadcast to all connected operators
    broadcast('message:new', { message });
    // Notify portal users for this client
    if (message.client_id) broadcastToPortalClient(message.client_id, 'portal:message:new', { id: message.id, subject: message.subject, created_at: message.created_at });

    // Auto-deliver if requested
    if (auto_deliver) {
      deliverMessage(message.id).catch((err) =>
        console.error('Auto-delivery failed for message', message.id, err.message)
      );
    }

    // Auto-reply email to caller (fire-and-forget)
    if (message.caller_phone || message.caller_name) {
      sendAutoReply(message).catch((err) =>
        console.warn('[auto-reply] failed for message', message.id, err.message)
      );
    }

    res.status(201).json({ message });
  } catch (err) {
    next(err);
  }
});

// PUT /api/messages/:id — update message fields
// Admins/supervisors may edit any message; operators may only edit their own.
router.put('/:id', async (req, res, next) => {
  try {
    const { caller_name, caller_phone, caller_company, subject, body, urgency, status } = req.body;
    const isPrivileged = ['admin', 'supervisor'].includes(req.operator?.role);
    const result = await pool.query(
      `UPDATE messages SET
         caller_name = COALESCE($1, caller_name),
         caller_phone = COALESCE($2, caller_phone),
         caller_company = COALESCE($3, caller_company),
         subject = COALESCE($4, subject),
         body = COALESCE($5, body),
         urgency = COALESCE($6, urgency),
         status = COALESCE($7, status)
       WHERE id = $8
         AND ($9 OR operator_id = $10)
       RETURNING *`,
      [caller_name, caller_phone, caller_company, subject, body, urgency, status,
       req.params.id, isPrivileged, req.operator.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Message not found' });
    res.json({ message: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// POST /api/messages/:id/deliver — trigger delivery for a message
router.post('/:id/deliver', async (req, res, next) => {
  try {
    const check = await pool.query('SELECT id FROM messages WHERE id = $1', [req.params.id]);
    if (!check.rows[0]) return res.status(404).json({ error: 'Message not found' });

    const results = await deliverMessage(req.params.id);
    res.json({ results });
  } catch (err) {
    next(err);
  }
});

// GET /api/messages/:id/deliveries
router.get('/:id/deliveries', async (req, res, next) => {
  try {
    const result = await pool.query(
      'SELECT * FROM message_deliveries WHERE message_id = $1 ORDER BY created_at DESC',
      [req.params.id]
    );
    res.json({ deliveries: result.rows });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/messages/:id/read — mark message as read
router.patch('/:id/read', async (req, res, next) => {
  try {
    const result = await pool.query(
      `UPDATE messages SET read_at = COALESCE(read_at, NOW()) WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Message not found' });
    res.json({ message: result.rows[0] });
  } catch (err) { next(err); }
});

// POST /api/messages/bulk/acknowledge — mark a list of message IDs as acknowledged
router.post('/bulk/acknowledge', async (req, res, next) => {
  try {
    const { ids, client_id } = req.body;
    if (!ids && !client_id) return res.status(400).json({ error: 'ids array or client_id required' });

    let updated;
    if (ids && Array.isArray(ids) && ids.length) {
      const result = await pool.query(
        `UPDATE messages SET status = 'acknowledged', updated_at = NOW()
         WHERE id = ANY($1::uuid[]) AND status != 'acknowledged'
         RETURNING id`,
        [ids]
      );
      updated = result.rowCount;
    } else if (client_id) {
      // Acknowledge all unacknowledged messages for a client
      const result = await pool.query(
        `UPDATE messages SET status = 'acknowledged', updated_at = NOW()
         WHERE client_id = $1 AND status NOT IN ('acknowledged', 'resolved')
         RETURNING id`,
        [client_id]
      );
      updated = result.rowCount;
    } else {
      return res.status(400).json({ error: 'ids must be a non-empty array' });
    }

    broadcast('messages:bulk_acknowledged', { count: updated, by: req.operator.id });
    res.json({ updated });
  } catch (err) { next(err); }
});

// PATCH /api/messages/:id/assign — assign message to an operator (or unassign)
router.patch('/:id/assign', async (req, res, next) => {
  try {
    const { operator_id } = req.body;
    const result = await pool.query(
      `UPDATE messages SET assigned_to = $1, updated_at = NOW() WHERE id = $2
       RETURNING id, assigned_to`,
      [operator_id || null, req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Message not found' });
    broadcast('message:assigned', { id: req.params.id, assigned_to: operator_id || null });
    res.json({ message: result.rows[0] });
  } catch (err) { next(err); }
});

// PATCH /api/messages/:id/notes — set internal operator notes on a message
router.patch('/:id/notes', async (req, res, next) => {
  try {
    const { internal_notes } = req.body;
    if (internal_notes === undefined) return res.status(400).json({ error: 'internal_notes field required' });
    const result = await pool.query(
      `UPDATE messages SET internal_notes = $1, updated_at = NOW() WHERE id = $2 RETURNING id, internal_notes`,
      [internal_notes || null, req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Message not found' });
    res.json({ message: result.rows[0] });
  } catch (err) { next(err); }
});

// PATCH /api/messages/:id/tags — set tags array on a message
router.patch('/:id/tags', async (req, res, next) => {
  try {
    const { tags } = req.body;
    if (!Array.isArray(tags)) return res.status(400).json({ error: 'tags must be an array of strings' });
    const sanitized = tags.map((t) => String(t).trim().toLowerCase().replace(/\s+/g, '-')).filter(Boolean).slice(0, 20);
    const result = await pool.query(
      `UPDATE messages SET tags = $1::text[], updated_at = NOW() WHERE id = $2 RETURNING id, tags`,
      [sanitized, req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Message not found' });
    broadcast('message:tags_updated', { id: req.params.id, tags: result.rows[0].tags });
    res.json({ message: result.rows[0] });
  } catch (err) { next(err); }
});

// GET /api/messages/:id/webhook-log — webhook delivery attempt history (admin/supervisor)
router.get('/:id/webhook-log', requireRole('admin', 'supervisor'), async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT * FROM webhook_delivery_log WHERE message_id = $1 ORDER BY sent_at ASC`,
      [req.params.id]
    );
    res.json({ logs: result.rows });
  } catch (err) { next(err); }
});

// GET /api/messages/:id/replies — get replies for a message
router.get('/:id/replies', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT mr.*, o.full_name AS operator_name,
              cpu.username AS portal_user_name
       FROM message_replies mr
       LEFT JOIN operators o ON mr.operator_id = o.id
       LEFT JOIN client_portal_users cpu ON mr.portal_user_id = cpu.id
       WHERE mr.message_id = $1
       ORDER BY mr.created_at ASC`,
      [req.params.id]
    );
    res.json({ replies: result.rows });
  } catch (err) { next(err); }
});

// POST /api/messages/:id/replies — operator sends a reply to a portal enquiry
router.post('/:id/replies', async (req, res, next) => {
  try {
    const { body } = req.body;
    if (!body?.trim()) return res.status(400).json({ error: 'Reply body is required' });

    // Verify message exists and get client_id
    const msg = await pool.query('SELECT client_id FROM messages WHERE id = $1', [req.params.id]);
    if (!msg.rows[0]) return res.status(404).json({ error: 'Message not found' });

    const result = await pool.query(
      `INSERT INTO message_replies (message_id, operator_id, body)
       VALUES ($1, $2, $3) RETURNING *`,
      [req.params.id, req.operator.id, body.trim()]
    );
    const reply = result.rows[0];

    // Notify portal users for this client
    const { broadcastToPortalClient } = require('../../services/realtime');
    broadcastToPortalClient(msg.rows[0].client_id, 'portal:message:reply', {
      message_id: req.params.id,
      reply: { ...reply, operator_name: req.operator.fullName },
    });

    res.status(201).json({ reply });
  } catch (err) { next(err); }
});

// PATCH /api/messages/:id/flag — toggle flagged status
router.patch('/:id/flag', async (req, res, next) => {
  try {
    const result = await pool.query(
      `UPDATE messages SET is_flagged = NOT is_flagged WHERE id = $1 RETURNING id, is_flagged`,
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Message not found' });
    res.json({ message: result.rows[0] });
  } catch (err) { next(err); }
});

// GET /api/messages/tags — distinct tags in use (for autocomplete)
router.get('/tags/catalog', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT DISTINCT unnest(tags) AS tag FROM messages WHERE cardinality(tags) > 0 ORDER BY tag ASC LIMIT 200`
    );
    res.json({ tags: result.rows.map((r) => r.tag) });
  } catch (err) { next(err); }
});

// POST /api/messages/broadcast — send one message per contact of a client
// Body: { client_id, subject, body, urgency?, contact_ids? }
// If contact_ids omitted, broadcasts to ALL active contacts of the client.
router.post('/broadcast', requireRole('admin', 'supervisor'), async (req, res, next) => {
  try {
    const { client_id, subject, body: msgBody, urgency = 'normal', contact_ids } = req.body;
    if (!client_id || !subject || !msgBody) {
      return res.status(400).json({ error: 'client_id, subject, body required' });
    }
    const broadcastId = require('crypto').randomUUID();

    // Fetch contacts to broadcast to
    let contacts;
    if (contact_ids && contact_ids.length > 0) {
      const r = await pool.query(
        `SELECT id FROM contacts WHERE client_id = $1 AND id = ANY($2::uuid[])`,
        [client_id, contact_ids]
      );
      contacts = r.rows;
    } else {
      const r = await pool.query(
        `SELECT id FROM contacts WHERE client_id = $1`,
        [client_id]
      );
      contacts = r.rows;
    }

    if (!contacts.length) {
      return res.status(400).json({ error: 'No contacts found for broadcast' });
    }

    const created = [];
    for (const contact of contacts) {
      const msg = await pool.query(
        `INSERT INTO messages (client_id, contact_id, subject, body, urgency, status, source, broadcast_id, operator_id)
         VALUES ($1, $2, $3, $4, $5, 'pending', 'broadcast', $6, $7)
         RETURNING *`,
        [client_id, contact.id, subject, msgBody, urgency, broadcastId, req.operator.id]
      );
      const message = msg.rows[0];
      created.push(message);
      // Fire-and-forget delivery
      deliverMessage(message).catch((err) =>
        console.warn('[broadcast] delivery failed for contact', contact.id, err.message)
      );
      broadcast('message:new', { message });
    }

    res.status(201).json({ broadcast_id: broadcastId, count: created.length });
  } catch (err) { next(err); }
});

module.exports = router;
