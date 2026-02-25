'use strict';

const router = require('express').Router();
const pool = require('../../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');

// All client routes require authentication
router.use(requireAuth);

// GET /api/clients
router.get('/', async (req, res, next) => {
  try {
    const { search, active } = req.query;
    let query = 'SELECT * FROM clients WHERE 1=1';
    const params = [];

    if (active !== undefined) {
      params.push(active === 'true');
      query += ` AND is_active = $${params.length}`;
    }
    if (search) {
      params.push(`%${search}%`);
      query += ` AND (name ILIKE $${params.length} OR account_number ILIKE $${params.length})`;
    }
    query += ' ORDER BY name ASC';

    const result = await pool.query(query, params);
    res.json({ clients: result.rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/clients/:id
router.get('/:id', async (req, res, next) => {
  try {
    const result = await pool.query('SELECT * FROM clients WHERE id = $1', [req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ error: 'Client not found' });
    res.json({ client: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

/**
 * Check whether the current moment falls within a client's configured opening_times.
 * opening_times is a JSONB object keyed by lowercase day name, e.g.:
 *   { "monday": { "open": "09:00", "close": "17:30" }, "tuesday": { ... }, ... }
 * Days absent from the object (or with { "closed": true }) are treated as closed.
 * An empty object means "always open" (no hours configured).
 */
function isWithinBusinessHours(openingTimes, timezone) {
  if (!openingTimes || typeof openingTimes !== 'object' || Object.keys(openingTimes).length === 0) {
    return true; // no hours configured → always considered open
  }

  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone || 'UTC',
    weekday: 'long',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);

  const dayName = parts.find((p) => p.type === 'weekday').value.toLowerCase();
  const hour = parseInt(parts.find((p) => p.type === 'hour').value, 10);
  const minute = parseInt(parts.find((p) => p.type === 'minute').value, 10);
  const currentMinutes = hour * 60 + minute;

  const daySchedule = openingTimes[dayName];
  if (!daySchedule || daySchedule.closed) return false;

  const [openH, openM] = (daySchedule.open || '00:00').split(':').map(Number);
  const [closeH, closeM] = (daySchedule.close || '23:59').split(':').map(Number);

  return currentMinutes >= openH * 60 + openM && currentMinutes < closeH * 60 + closeM;
}

// GET /api/clients/:id/screenpop — full client dossier for operator screen pop
router.get('/:id/screenpop', async (req, res, next) => {
  try {
    const [clientResult, contactsResult, availResult, deptResult] = await Promise.all([
      pool.query('SELECT * FROM clients WHERE id = $1', [req.params.id]),
      pool.query(
        `SELECT c.*, d.name AS department_name
         FROM contacts c
         LEFT JOIN departments d ON c.department_id = d.id
         WHERE c.client_id = $1 AND c.is_active = true
         ORDER BY c.priority ASC, c.name ASC`,
        [req.params.id]
      ),
      pool.query('SELECT * FROM client_availability WHERE client_id = $1', [req.params.id]),
      pool.query('SELECT * FROM departments WHERE client_id = $1 ORDER BY name ASC', [req.params.id]),
    ]);
    if (!clientResult.rows[0]) return res.status(404).json({ error: 'Client not found' });

    const client = clientResult.rows[0];
    const manualAvail = availResult.rows[0] || null;
    const withinHours = isWithinBusinessHours(client.opening_times, client.timezone);

    res.json({
      client,
      contacts: contactsResult.rows,
      departments: deptResult.rows,
      availability: {
        status: manualAvail?.status || (withinHours ? 'available' : 'closed'),
        note: manualAvail?.note || null,
        is_open: withinHours,
        updated_at: manualAvail?.updated_at || null,
      },
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/clients
router.post('/', requireRole('admin', 'supervisor'), async (req, res, next) => {
  try {
    const {
      name, account_number, dids = [], script, greeting,
      timezone = 'Europe/London', notes, address,
      opening_times = {}, info_sheets = [], custom_form = [],
      delivery_actions = { phone_call: true, email: true, sms: false },
      smtp_host, smtp_port, smtp_user, smtp_pass, smtp_from,
      web_links = [], outbound_caller_id, email_template, private_notes,
      whatsapp_number, telegram_chat_id, slack_webhook, teams_webhook,
      escalation_rules = [], sla_answer_seconds = 30,
      data_retention_months = 12,
    } = req.body;

    const VALID_RETENTION = [3, 5, 9, 12];
    if (!VALID_RETENTION.includes(parseInt(data_retention_months))) {
      return res.status(400).json({ error: 'data_retention_months must be one of 3, 5, 9, 12' });
    }

    if (!name || !account_number) {
      return res.status(400).json({ error: 'name and account_number are required' });
    }

    const result = await pool.query(
      `INSERT INTO clients
         (name, account_number, dids, script, greeting, timezone, notes,
          address, opening_times, info_sheets, custom_form, delivery_actions,
          smtp_host, smtp_port, smtp_user, smtp_pass, smtp_from, web_links,
          outbound_caller_id, email_template, private_notes,
          whatsapp_number, telegram_chat_id, slack_webhook, teams_webhook,
          escalation_rules, sla_answer_seconds, data_retention_months)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28)
       RETURNING *`,
      [
        name, account_number, dids, script, greeting, timezone, notes,
        address,
        JSON.stringify(opening_times),
        JSON.stringify(info_sheets),
        JSON.stringify(custom_form),
        JSON.stringify(delivery_actions),
        smtp_host || null, smtp_port || null, smtp_user || null,
        smtp_pass || null, smtp_from || null,
        JSON.stringify(web_links),
        outbound_caller_id || null, email_template || null, private_notes || null,
        whatsapp_number || null, telegram_chat_id || null,
        slack_webhook || null, teams_webhook || null,
        JSON.stringify(escalation_rules),
        sla_answer_seconds,
        parseInt(data_retention_months),
      ]
    );
    res.status(201).json({ client: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Account number already exists' });
    next(err);
  }
});

// PUT /api/clients/:id
router.put('/:id', requireRole('admin', 'supervisor'), async (req, res, next) => {
  try {
    const {
      name, dids, script, greeting, timezone, is_active, notes, address,
      opening_times, info_sheets, custom_form, delivery_actions,
      smtp_host, smtp_port, smtp_user, smtp_pass, smtp_from,
      web_links, outbound_caller_id, email_template, private_notes,
      whatsapp_number, telegram_chat_id, slack_webhook, teams_webhook,
      escalation_rules, sla_answer_seconds, data_retention_months,
    } = req.body;

    if (data_retention_months !== undefined) {
      const VALID_RETENTION = [3, 5, 9, 12];
      if (!VALID_RETENTION.includes(parseInt(data_retention_months))) {
        return res.status(400).json({ error: 'data_retention_months must be one of 3, 5, 9, 12' });
      }
    }

    const result = await pool.query(
      `UPDATE clients SET
         name             = COALESCE($1, name),
         dids             = COALESCE($2, dids),
         script           = COALESCE($3, script),
         greeting         = COALESCE($4, greeting),
         timezone         = COALESCE($5, timezone),
         is_active        = COALESCE($6, is_active),
         notes            = COALESCE($7, notes),
         address          = COALESCE($8, address),
         opening_times    = COALESCE($9, opening_times),
         info_sheets      = COALESCE($10, info_sheets),
         custom_form      = COALESCE($11, custom_form),
         delivery_actions = COALESCE($12, delivery_actions),
         smtp_host        = COALESCE($13, smtp_host),
         smtp_port        = COALESCE($14, smtp_port),
         smtp_user        = COALESCE($15, smtp_user),
         smtp_pass        = COALESCE($16, smtp_pass),
         smtp_from           = COALESCE($17, smtp_from),
         web_links           = COALESCE($18, web_links),
         outbound_caller_id  = COALESCE($19, outbound_caller_id),
         email_template      = COALESCE($20, email_template),
         private_notes       = COALESCE($21, private_notes),
         whatsapp_number     = COALESCE($23, whatsapp_number),
         telegram_chat_id    = COALESCE($24, telegram_chat_id),
         slack_webhook       = COALESCE($25, slack_webhook),
         teams_webhook       = COALESCE($26, teams_webhook),
         escalation_rules       = COALESCE($27, escalation_rules),
         sla_answer_seconds     = COALESCE($28, sla_answer_seconds),
         data_retention_months  = COALESCE($29, data_retention_months)
       WHERE id = $22
       RETURNING *`,
      [
        name, dids, script, greeting, timezone, is_active, notes, address,
        opening_times !== undefined ? JSON.stringify(opening_times) : null,
        info_sheets   !== undefined ? JSON.stringify(info_sheets)   : null,
        custom_form   !== undefined ? JSON.stringify(custom_form)   : null,
        delivery_actions !== undefined ? JSON.stringify(delivery_actions) : null,
        smtp_host !== undefined ? smtp_host : null,
        smtp_port !== undefined ? smtp_port : null,
        smtp_user !== undefined ? smtp_user : null,
        smtp_pass !== undefined ? smtp_pass : null,
        smtp_from !== undefined ? smtp_from : null,
        web_links !== undefined ? JSON.stringify(web_links) : null,
        outbound_caller_id !== undefined ? (outbound_caller_id || null) : null,
        email_template     !== undefined ? (email_template || null)     : null,
        private_notes      !== undefined ? (private_notes || null)      : null,
        req.params.id,
        whatsapp_number  !== undefined ? (whatsapp_number || null)  : null,
        telegram_chat_id !== undefined ? (telegram_chat_id || null) : null,
        slack_webhook    !== undefined ? (slack_webhook || null)    : null,
        teams_webhook    !== undefined ? (teams_webhook || null)    : null,
        escalation_rules !== undefined ? JSON.stringify(escalation_rules) : null,
        sla_answer_seconds !== undefined ? sla_answer_seconds : null,
        data_retention_months !== undefined ? parseInt(data_retention_months) : null,
      ]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Client not found' });
    res.json({ client: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/clients/:id (deactivate)
router.delete('/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query(
      'UPDATE clients SET is_active = false WHERE id = $1 RETURNING id',
      [req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Client not found' });
    res.json({ message: 'Client deactivated' });
  } catch (err) {
    next(err);
  }
});

// GET /api/clients/by-did/:did — used by ARI to look up client from inbound DID
router.get('/by-did/:did', async (req, res, next) => {
  try {
    const result = await pool.query(
      'SELECT * FROM clients WHERE $1 = ANY(dids) AND is_active = true',
      [req.params.did]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'No client for this DID' });
    res.json({ client: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

router._isWithinBusinessHours = isWithinBusinessHours;
module.exports = router;
