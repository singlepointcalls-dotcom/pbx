'use strict';

/**
 * Inbound email → message conversion.
 *
 * Supports webhook formats from:
 *   - Mailgun  (POST /api/email/inbound/mailgun)
 *   - SendGrid (POST /api/email/inbound/sendgrid)
 *   - Postmark (POST /api/email/inbound/postmark)
 *   - Generic  (POST /api/email/inbound — JSON {from, to, subject, text})
 *
 * Match client by the To address (must be a DID-linked inbound email address
 * configured in clients.inbound_email).  Falls back to matching by account number
 * in the To local-part (e.g. DEMO001@answers.spcalls.co.uk).
 */

const router = require('express').Router();
const pool = require('../../config/database');
const crypto = require('crypto');
const { broadcast } = require('../../services/realtime');
const ai = require('../../services/ai');

async function processInboundEmail({ from, to, subject, text, provider, providerId, rawHeaders }) {
  // Look up client by inbound email address or account number in local-part
  const toLocal = (to.split('@')[0] || '').toUpperCase();

  let clientResult = await pool.query(
    `SELECT id, name FROM clients
     WHERE (inbound_email = $1 OR UPPER(account_number) = $2) AND is_active = true
     LIMIT 1`,
    [to.toLowerCase(), toLocal]
  );
  const client = clientResult.rows[0] || null;

  // AI entity extraction — try to pull caller name/phone from email
  let callerName = from.replace(/<.*>/, '').trim().replace(/"/g, '') || null;
  let callerPhone = null;
  if (text) {
    const entities = await ai.extractEntities(text).catch(() => null);
    if (entities) {
      callerName = entities.name || callerName;
      callerPhone = entities.phone || null;
    }
  }

  // AI urgency classification
  let urgency = 'normal';
  if (text) {
    const classification = await ai.classifyMessage({ subject, body: text }).catch(() => null);
    if (classification?.urgency) urgency = classification.urgency;
  }

  // Log the inbound email
  const emailLog = await pool.query(
    `INSERT INTO inbound_emails
       (client_id, from_address, to_address, subject, body_text, provider, provider_id, raw_headers, processed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [client?.id || null, from, to, subject || null, text || null,
     provider, providerId || null, rawHeaders ? JSON.stringify(rawHeaders) : null]
  );

  if (!client) return { status: 'no_client', emailLogId: emailLog.rows[0]?.id };

  // Create a message
  const msgResult = await pool.query(
    `INSERT INTO messages
       (client_id, caller_name, caller_phone, subject, body, urgency, status, call_type)
     VALUES ($1,$2,$3,$4,$5,$6,'pending','email_inbound')
     RETURNING id`,
    [client.id, callerName, callerPhone, subject || 'Email enquiry', text || '(no body)', urgency]
  );
  const messageId = msgResult.rows[0].id;

  // Link email log to message
  await pool.query('UPDATE inbound_emails SET message_id = $1 WHERE id = $2',
    [messageId, emailLog.rows[0]?.id]);

  broadcast('message:new', { messageId, clientId: client.id, source: 'email' });

  return { status: 'created', messageId, clientId: client.id };
}

// ── Mailgun ────────────────────────────────────────────────────────────────
function verifyMailgunSignature(req) {
  const signingKey = process.env.MAILGUN_WEBHOOK_SIGNING_KEY;
  if (!signingKey) return true;
  const { timestamp, token, signature } = req.body;
  if (!timestamp || !token || !signature) return false;
  const value = timestamp + token;
  const expected = crypto.createHmac('sha256', signingKey).update(value).digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected)); }
  catch { return false; }
}

router.post('/mailgun', async (req, res, next) => {
  try {
    if (!verifyMailgunSignature(req)) return res.status(403).send('Forbidden');
    const { sender, recipient, subject, 'body-plain': text, 'Message-Id': msgId } = req.body;
    await processInboundEmail({
      from: sender || '', to: recipient || '',
      subject, text, provider: 'mailgun', providerId: msgId,
    });
    res.sendStatus(200);
  } catch (err) { next(err); }
});

// ── SendGrid ───────────────────────────────────────────────────────────────
router.post('/sendgrid', async (req, res, next) => {
  try {
    // SendGrid sends an array of envelope objects
    const emails = Array.isArray(req.body) ? req.body : [req.body];
    for (const item of emails) {
      const envelope = typeof item.envelope === 'string' ? JSON.parse(item.envelope) : item.envelope || {};
      await processInboundEmail({
        from: envelope.from || item.from || '',
        to: (envelope.to || [])[0] || item.to || '',
        subject: item.subject || '',
        text: item.text || '',
        provider: 'sendgrid',
        providerId: item.headers?.['Message-ID'] || null,
      });
    }
    res.sendStatus(200);
  } catch (err) { next(err); }
});

// ── Postmark ───────────────────────────────────────────────────────────────
router.post('/postmark', async (req, res, next) => {
  try {
    const { From, To, Subject, TextBody, MessageID } = req.body;
    await processInboundEmail({
      from: From || '', to: To || '',
      subject: Subject || '', text: TextBody || '',
      provider: 'postmark', providerId: MessageID,
    });
    res.sendStatus(200);
  } catch (err) { next(err); }
});

// ── Generic JSON (for custom setups / testing) ─────────────────────────────
router.post('/', async (req, res, next) => {
  try {
    const { from, to, subject, text } = req.body;
    if (!from || !to) return res.status(400).json({ error: 'from and to are required' });
    const result = await processInboundEmail({ from, to, subject, text, provider: 'generic' });
    res.status(result.messageId ? 201 : 200).json(result);
  } catch (err) { next(err); }
});

module.exports = router;
