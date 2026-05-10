'use strict';

/**
 * WhatsApp Business Cloud API (Meta direct — no Twilio required).
 *
 * Required env vars:
 *   WHATSAPP_PHONE_NUMBER_ID   — from Meta Business Manager
 *   WHATSAPP_ACCESS_TOKEN      — permanent system user token
 *   WHATSAPP_VERIFY_TOKEN      — webhook verification secret (you choose)
 *
 * Optional:
 *   WHATSAPP_BUSINESS_ACCOUNT_ID
 *
 * Webhook URL to set in Meta: https://<your-domain>/api/whatsapp/webhook
 */

const router = require('express').Router();
const pool = require('../../config/database');
const axios = require('axios');
const crypto = require('crypto');
const { requireAuth } = require('../middleware/auth');
const { broadcast } = require('../../services/realtime');

const GRAPH_URL = 'https://graph.facebook.com/v19.0';

function verifyMetaSignature(req) {
  const appSecret = process.env.WHATSAPP_APP_SECRET;
  if (!appSecret) return true; // skip if not configured
  const signature = req.headers['x-hub-signature-256'] || '';
  const expected = 'sha256=' + crypto
    .createHmac('sha256', appSecret)
    .update(JSON.stringify(req.body))
    .digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

// ── GET /api/whatsapp/webhook — Meta webhook verification challenge ─────────
router.get('/webhook', (req, res) => {
  const mode  = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  res.status(403).send('Forbidden');
});

// ── POST /api/whatsapp/webhook — receive inbound WhatsApp messages ─────────
router.post('/webhook', async (req, res, next) => {
  try {
    if (!verifyMetaSignature(req)) return res.status(403).send('Forbidden');

    const entry = req.body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;

    if (!value?.messages?.length) return res.sendStatus(200);

    for (const msg of value.messages) {
      if (msg.type !== 'text') continue; // handle text for now

      const from = msg.from;  // MSISDN format e.g. 447700900000
      const body = msg.text?.body || '';
      const waMessageId = msg.id;

      // Look up client by WhatsApp number (stored in clients.whatsapp_number)
      const clientResult = await pool.query(
        `SELECT id FROM clients WHERE whatsapp_number = $1 AND is_active = true LIMIT 1`,
        ['+' + from]
      );
      const clientId = clientResult.rows[0]?.id || null;

      // Store in sms_messages table — reuse the two-way SMS inbox
      const saved = await pool.query(
        `INSERT INTO sms_messages
           (client_id, direction, from_number, to_number, body, provider, provider_message_id, status)
         VALUES ($1, 'inbound', $2, $3, $4, 'whatsapp_cloud', $5, 'received')
         ON CONFLICT (provider, provider_message_id) DO NOTHING
         RETURNING *`,
        [clientId, '+' + from, value.metadata?.display_phone_number || 'whatsapp', body, waMessageId]
      );

      if (saved.rows[0]) {
        broadcast('whatsapp:inbound', { message: saved.rows[0], client_id: clientId });
      }

      // Mark as read with Meta
      const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
      const token = process.env.WHATSAPP_ACCESS_TOKEN;
      if (phoneNumberId && token) {
        axios.post(`${GRAPH_URL}/${phoneNumberId}/messages`, {
          messaging_product: 'whatsapp',
          status: 'read',
          message_id: waMessageId,
        }, { headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
      }
    }

    res.sendStatus(200);
  } catch (err) { next(err); }
});

// ── Authenticated routes ───────────────────────────────────────────────────
router.use(requireAuth);

// POST /api/whatsapp/send — send an outbound WhatsApp message
router.post('/send', async (req, res, next) => {
  try {
    const { to, body, client_id } = req.body;
    if (!to || !body) return res.status(400).json({ error: 'to and body are required' });

    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
    const token = process.env.WHATSAPP_ACCESS_TOKEN;
    if (!phoneNumberId || !token) {
      return res.status(503).json({ error: 'WhatsApp Cloud API not configured (WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_ACCESS_TOKEN)' });
    }

    // Normalise: strip leading + for Meta API
    const toNorm = to.replace(/^\+/, '');

    const metaResp = await axios.post(
      `${GRAPH_URL}/${phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: toNorm,
        type: 'text',
        text: { preview_url: false, body },
      },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 15000 }
    );

    const waMessageId = metaResp.data?.messages?.[0]?.id || null;

    const result = await pool.query(
      `INSERT INTO sms_messages
         (client_id, direction, from_number, to_number, body, provider, provider_message_id, status, operator_id)
       VALUES ($1, 'outbound', $2, $3, $4, 'whatsapp_cloud', $5, 'sent', $6)
       RETURNING *`,
      [client_id || null, phoneNumberId, to, body, waMessageId, req.operator.id]
    );

    broadcast('whatsapp:outbound', { message: result.rows[0] });
    res.status(201).json({ message: result.rows[0] });
  } catch (err) {
    if (err.response?.data) {
      return res.status(502).json({ error: 'WhatsApp API error', detail: err.response.data });
    }
    next(err);
  }
});

// GET /api/whatsapp/threads — list WhatsApp conversations
router.get('/threads', async (req, res, next) => {
  try {
    const { client_id } = req.query;
    const params = ["whatsapp_cloud"];
    let filter = '';
    if (client_id) { params.push(client_id); filter = `AND client_id = $${params.length}`; }

    const result = await pool.query(
      `SELECT
         from_number,
         client_id,
         MAX(c.name)       AS client_name,
         COUNT(*)          AS message_count,
         MAX(s.created_at) AS last_message_at,
         COUNT(*) FILTER (WHERE status = 'received') AS unread_count
       FROM sms_messages s
       LEFT JOIN clients c ON s.client_id = c.id
       WHERE provider = $1 AND direction = 'inbound' ${filter}
       GROUP BY from_number, client_id
       ORDER BY last_message_at DESC`,
      params
    );
    res.json({ threads: result.rows });
  } catch (err) { next(err); }
});

// GET /api/whatsapp/thread/:number — messages in a conversation
router.get('/thread/:number', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT s.*, c.name AS client_name
       FROM sms_messages s
       LEFT JOIN clients c ON s.client_id = c.id
       WHERE s.provider = 'whatsapp_cloud'
         AND (s.from_number = $1 OR s.to_number = $1)
       ORDER BY s.created_at ASC
       LIMIT 200`,
      [req.params.number]
    );
    // Mark inbound messages as read
    await pool.query(
      `UPDATE sms_messages SET status = 'read'
       WHERE provider = 'whatsapp_cloud' AND from_number = $1 AND status = 'received'`,
      [req.params.number]
    );
    res.json({ messages: result.rows });
  } catch (err) { next(err); }
});

module.exports = router;
