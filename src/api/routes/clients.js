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

// GET /api/clients/:id/screenpop — full client dossier for operator screen pop
router.get('/:id/screenpop', async (req, res, next) => {
  try {
    const [clientResult, contactsResult, availResult] = await Promise.all([
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
    ]);
    if (!clientResult.rows[0]) return res.status(404).json({ error: 'Client not found' });
    res.json({
      client: clientResult.rows[0],
      contacts: contactsResult.rows,
      availability: availResult.rows[0] || { status: 'available', note: null },
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
      web_links = [],
    } = req.body;

    if (!name || !account_number) {
      return res.status(400).json({ error: 'name and account_number are required' });
    }

    const result = await pool.query(
      `INSERT INTO clients
         (name, account_number, dids, script, greeting, timezone, notes,
          address, opening_times, info_sheets, custom_form, delivery_actions,
          smtp_host, smtp_port, smtp_user, smtp_pass, smtp_from, web_links)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
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
      web_links,
    } = req.body;

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
         smtp_from        = COALESCE($17, smtp_from),
         web_links        = COALESCE($18, web_links)
       WHERE id = $19
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
        req.params.id,
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

module.exports = router;
