'use strict';

const router = require('express').Router();
const pool = require('../../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const { deliverMessage } = require('../../services/delivery');
const { broadcast } = require('../../services/realtime');

router.use(requireAuth);

// GET /api/messages
router.get('/', async (req, res, next) => {
  try {
    const { client_id, status, urgency, limit = 50, offset = 0 } = req.query;
    let query = `
      SELECT m.*, c.name AS client_name, o.full_name AS operator_name
      FROM messages m
      LEFT JOIN clients c ON m.client_id = c.id
      LEFT JOIN operators o ON m.operator_id = o.id
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

    // Count uses the same filters captured before adding LIMIT/OFFSET
    const filterParams = params.slice();
    const countQuery = query.replace(
      'SELECT m.*, c.name AS client_name, o.full_name AS operator_name',
      'SELECT COUNT(*)'
    );

    // CSV export
    if (req.query.format === 'csv') {
      const csvResult = await pool.query(query + ' ORDER BY m.created_at DESC', params);
      const cols = ['id','client_name','operator_name','caller_name','caller_phone','caller_company','subject','body','urgency','status','created_at'];
      const header = cols.join(',');
      const rows = csvResult.rows.map((r) =>
        cols.map((c) => `"${String(r[c] ?? '').replace(/"/g, '""')}"`).join(',')
      );
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="messages.csv"');
      return res.send([header, ...rows].join('\r\n'));
    }

    params.push(parseInt(limit), parseInt(offset));
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
      `SELECT m.*, c.name AS client_name, o.full_name AS operator_name
       FROM messages m
       LEFT JOIN clients c ON m.client_id = c.id
       LEFT JOIN operators o ON m.operator_id = o.id
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
          caller_company, subject, body, urgency, call_type, is_no_charge)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [
        call_log_id, client_id, req.operator.id,
        caller_name, caller_phone, caller_company,
        subject, body || '', urgency,
        call_type, noCharge,
      ]
    );

    const message = result.rows[0];

    // Broadcast to all connected operators
    broadcast('message:new', { message });

    // Auto-deliver if requested
    if (auto_deliver) {
      deliverMessage(message.id).catch((err) =>
        console.error('Auto-delivery failed for message', message.id, err.message)
      );
    }

    res.status(201).json({ message });
  } catch (err) {
    next(err);
  }
});

// PUT /api/messages/:id — update message fields
router.put('/:id', async (req, res, next) => {
  try {
    const { caller_name, caller_phone, caller_company, subject, body, urgency, status } = req.body;
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
       RETURNING *`,
      [caller_name, caller_phone, caller_company, subject, body, urgency, status, req.params.id]
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

module.exports = router;
