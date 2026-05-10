'use strict';

const router = require('express').Router();
const pool = require('../../config/database');
const axios = require('axios');
const crypto = require('crypto');
const { requireAuth } = require('../middleware/auth');
const { broadcast } = require('../../services/realtime');

// ── Twilio signature verification for inbound webhook ─────────────────────
function verifyTwilioSignature(req) {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) return true; // skip if not configured (dev mode)

  const signature = req.headers['x-twilio-signature'] || '';
  const url = (process.env.APP_URL || '') + req.originalUrl;

  const params = req.body || {};
  const sortedKeys = Object.keys(params).sort();
  let str = url;
  for (const key of sortedKeys) str += key + params[key];

  const expected = crypto.createHmac('sha1', authToken).update(str).digest('base64');
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

// ── Public: Twilio inbound SMS webhook ────────────────────────────────────
// Twilio POSTs application/x-www-form-urlencoded
router.post('/webhook/twilio', async (req, res, next) => {
  try {
    if (!verifyTwilioSignature(req)) {
      return res.status(403).send('Forbidden');
    }

    const { From, To, Body, MessageSid } = req.body;
    if (!From || !To || !Body) return res.status(400).send('Bad Request');

    // Look up client by the To number (should match one of their DIDs or outbound CID)
    const clientResult = await pool.query(
      `SELECT id FROM clients
       WHERE ($1 = ANY(dids) OR outbound_caller_id = $1) AND is_active = true
       LIMIT 1`,
      [To]
    );
    const clientId = clientResult.rows[0]?.id || null;

    const result = await pool.query(
      `INSERT INTO sms_messages
         (client_id, direction, from_number, to_number, body, provider, provider_message_id, status)
       VALUES ($1, 'inbound', $2, $3, $4, 'twilio', $5, 'received')
       ON CONFLICT (provider, provider_message_id) DO NOTHING
       RETURNING *`,
      [clientId, From, To, Body, MessageSid]
    );

    if (result.rows[0]) {
      broadcast('sms:inbound', { sms: result.rows[0], client_id: clientId });
    }

    // Twilio expects an empty TwiML response
    res.set('Content-Type', 'text/xml').send('<Response></Response>');
  } catch (err) { next(err); }
});

// ── All routes below require operator auth ─────────────────────────────────
router.use(requireAuth);

// GET /api/sms — inbox (all inbound messages, optionally filtered)
router.get('/', async (req, res, next) => {
  try {
    const { client_id, from_number, status, limit = 50, offset = 0 } = req.query;
    const params = [];
    let where = "WHERE s.direction = 'inbound'";

    if (client_id)   { params.push(client_id);   where += ` AND s.client_id = $${params.length}`; }
    if (from_number) { params.push(from_number); where += ` AND s.from_number = $${params.length}`; }
    if (status)      { params.push(status);      where += ` AND s.status = $${params.length}`; }

    params.push(parseInt(limit));
    params.push(parseInt(offset));

    const result = await pool.query(
      `SELECT s.*, c.name AS client_name, o.full_name AS operator_name
       FROM sms_messages s
       LEFT JOIN clients c ON s.client_id = c.id
       LEFT JOIN operators o ON s.operator_id = o.id
       ${where}
       ORDER BY s.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM sms_messages s ${where}`,
      params.slice(0, -2)
    );

    res.json({ sms: result.rows, total: parseInt(countResult.rows[0].count) });
  } catch (err) { next(err); }
});

// GET /api/sms/threads — unique conversations grouped by from_number
router.get('/threads', async (req, res, next) => {
  try {
    const { client_id } = req.query;
    const params = [];
    let clientFilter = '';
    if (client_id) { params.push(client_id); clientFilter = `AND client_id = $${params.length}`; }

    const result = await pool.query(
      `SELECT
         from_number,
         client_id,
         MAX(c.name)        AS client_name,
         COUNT(*)           AS message_count,
         MAX(s.created_at)  AS last_message_at,
         (SELECT body FROM sms_messages WHERE from_number = s.from_number
            AND direction = 'inbound' ORDER BY created_at DESC LIMIT 1) AS last_body,
         COUNT(*) FILTER (WHERE status = 'received') AS unread_count
       FROM sms_messages s
       LEFT JOIN clients c ON s.client_id = c.id
       WHERE direction = 'inbound' ${clientFilter}
       GROUP BY from_number, client_id
       ORDER BY last_message_at DESC`,
      params
    );
    res.json({ threads: result.rows });
  } catch (err) { next(err); }
});

// GET /api/sms/thread/:number — full conversation thread with a number
router.get('/thread/:number', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT s.*, o.full_name AS operator_name
       FROM sms_messages s
       LEFT JOIN operators o ON s.operator_id = o.id
       WHERE s.from_number = $1 OR s.to_number = $1
       ORDER BY s.created_at ASC`,
      [req.params.number]
    );
    // Mark inbound messages from this number as read
    await pool.query(
      `UPDATE sms_messages SET status = 'read'
       WHERE from_number = $1 AND direction = 'inbound' AND status = 'received'`,
      [req.params.number]
    );
    res.json({ messages: result.rows });
  } catch (err) { next(err); }
});

// POST /api/sms/reply — send an outbound SMS reply
router.post('/reply', async (req, res, next) => {
  try {
    const { to, body, client_id } = req.body;
    if (!to || !body) return res.status(400).json({ error: 'to and body are required' });
    if (body.length > 1600) return res.status(400).json({ error: 'body too long (max 1600 chars)' });

    let providerMessageId = null;
    let provider = 'twilio';

    if (process.env.WEBEX_INTERACT_API_KEY) {
      provider = 'webexinteract';
      const senderId = process.env.WEBEX_INTERACT_SENDER_ID;
      const resp = await axios.post(
        'https://api.webexinteract.com/v1/sms',
        { from: senderId, to: [{ phone: [to] }], message_body: body },
        { headers: { 'X-AUTH-KEY': process.env.WEBEX_INTERACT_API_KEY, 'Content-Type': 'application/json' }, timeout: 10000 }
      );
      providerMessageId = resp.data?.message_id || null;
    } else {
      const accountSid = process.env.TWILIO_ACCOUNT_SID;
      const authToken = process.env.TWILIO_AUTH_TOKEN;
      const from = process.env.TWILIO_FROM_NUMBER;
      if (!accountSid || !authToken || !from) {
        return res.status(503).json({ error: 'SMS provider not configured' });
      }
      const resp = await axios.post(
        `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
        new URLSearchParams({ From: from, To: to, Body: body }),
        { auth: { username: accountSid, password: authToken }, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
      );
      providerMessageId = resp.data?.sid || null;
    }

    const from = process.env.TWILIO_FROM_NUMBER || process.env.WEBEX_INTERACT_SENDER_ID || 'system';

    const result = await pool.query(
      `INSERT INTO sms_messages
         (client_id, direction, from_number, to_number, body, provider, provider_message_id, status, operator_id)
       VALUES ($1, 'outbound', $2, $3, $4, $5, $6, 'sent', $7)
       RETURNING *`,
      [client_id || null, from, to, body, provider, providerMessageId, req.operator.id]
    );

    broadcast('sms:outbound', { sms: result.rows[0] });
    res.status(201).json({ sms: result.rows[0] });
  } catch (err) { next(err); }
});

// POST /api/sms/bulk — send SMS to multiple recipients
router.post('/bulk', async (req, res, next) => {
  try {
    const { client_id, contact_ids, recipients, body } = req.body;
    if (!body || body.trim().length === 0) return res.status(400).json({ error: 'body is required' });
    if (body.length > 1600) return res.status(400).json({ error: 'body too long (max 1600 chars)' });

    let targets = []; // [{phone, name}]

    if (contact_ids && Array.isArray(contact_ids) && contact_ids.length > 0) {
      const r = await pool.query(
        `SELECT name, phone FROM contacts WHERE id = ANY($1::uuid[]) AND phone IS NOT NULL AND phone != ''`,
        [contact_ids]
      );
      targets = r.rows.map(c => ({ phone: c.phone, name: c.name }));
    } else if (recipients && Array.isArray(recipients)) {
      targets = recipients.filter(r => r.phone).map(r => ({ phone: r.phone, name: r.name || r.phone }));
    }

    if (targets.length === 0) return res.status(400).json({ error: 'No valid recipients' });
    if (targets.length > 200) return res.status(400).json({ error: 'Max 200 recipients per bulk send' });

    const useWebex = !!process.env.WEBEX_INTERACT_API_KEY;
    const provider = useWebex ? 'webexinteract' : 'twilio';
    const from = process.env.TWILIO_FROM_NUMBER || process.env.WEBEX_INTERACT_SENDER_ID || 'system';

    if (!useWebex) {
      const { TWILIO_ACCOUNT_SID: sid, TWILIO_AUTH_TOKEN: token, TWILIO_FROM_NUMBER: twFrom } = process.env;
      if (!sid || !token || !twFrom) return res.status(503).json({ error: 'SMS provider not configured' });
    }

    const results = { sent: 0, failed: 0, errors: [] };

    for (const target of targets) {
      try {
        let providerMessageId = null;
        if (useWebex) {
          const resp = await axios.post(
            'https://api.webexinteract.com/v1/sms',
            { from: process.env.WEBEX_INTERACT_SENDER_ID, to: [{ phone: [target.phone] }], message_body: body },
            { headers: { 'X-AUTH-KEY': process.env.WEBEX_INTERACT_API_KEY, 'Content-Type': 'application/json' }, timeout: 10000 }
          );
          providerMessageId = resp.data?.message_id || null;
        } else {
          const resp = await axios.post(
            `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Messages.json`,
            new URLSearchParams({ From: from, To: target.phone, Body: body }),
            { auth: { username: process.env.TWILIO_ACCOUNT_SID, password: process.env.TWILIO_AUTH_TOKEN }, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
          );
          providerMessageId = resp.data?.sid || null;
        }

        await pool.query(
          `INSERT INTO sms_messages
             (client_id, direction, from_number, to_number, body, provider, provider_message_id, status, operator_id)
           VALUES ($1, 'outbound', $2, $3, $4, $5, $6, 'sent', $7)`,
          [client_id || null, from, target.phone, body, provider, providerMessageId, req.operator.id]
        );
        results.sent++;
      } catch (err) {
        results.failed++;
        results.errors.push({ phone: target.phone, error: err.response?.data?.message || err.message });
      }
      // 150ms inter-message delay to avoid provider rate limits
      await new Promise(r => setTimeout(r, 150));
    }

    broadcast('sms:bulk_sent', { client_id, sent: results.sent, failed: results.failed, operator_id: req.operator.id });
    res.json({ ...results, total: targets.length });
  } catch (err) { next(err); }
});

module.exports = router;
