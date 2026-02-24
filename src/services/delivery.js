'use strict';

/**
 * Message Delivery Service
 *
 * Delivers messages to client contacts via channels selected in client.delivery_actions:
 *   - phone_call  (creates a record prompting the operator to call)
 *   - email       (SMTP — global SinglePoint or per-client override)
 *   - sms         (Twilio)
 *   - webhook     (HTTP POST to client-configured URL)
 *   - inapp       (always stored; no external delivery needed)
 */

const nodemailer = require('nodemailer');
const axios = require('axios');
const pool = require('../config/database');

// Global transporter (SinglePoint SMTP) — lazily created
let globalTransporter = null;

function getGlobalTransporter() {
  if (!globalTransporter) {
    globalTransporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '587'),
      secure: process.env.SMTP_SECURE === 'true',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASSWORD,
      },
    });
  }
  return globalTransporter;
}

/**
 * Return a nodemailer transporter for a client, falling back to the global one.
 * Per-client credentials are stored encrypted-at-rest in the DB (operator responsibility).
 */
function getClientTransporter(client) {
  if (client.smtp_host) {
    return nodemailer.createTransport({
      host: client.smtp_host,
      port: client.smtp_port || 587,
      secure: client.smtp_port === 465,
      auth: {
        user: client.smtp_user,
        pass: client.smtp_pass,
      },
    });
  }
  return getGlobalTransporter();
}

/**
 * Deliver a message to all active contacts for the client.
 * Respects client.delivery_actions to decide which channels to use.
 */
async function deliverMessage(messageId) {
  const msgResult = await pool.query(
    `SELECT m.*, c.name AS client_name,
            c.delivery_actions, c.smtp_host, c.smtp_port,
            c.smtp_user, c.smtp_pass, c.smtp_from
     FROM messages m
     JOIN clients c ON m.client_id = c.id
     WHERE m.id = $1`,
    [messageId]
  );
  const message = msgResult.rows[0];
  if (!message) throw new Error(`Message ${messageId} not found`);

  // Parse delivery_actions — default to email on if missing
  const da = message.delivery_actions || { phone_call: true, email: true, sms: false };

  // Get active contacts for this client
  const contactResult = await pool.query(
    `SELECT * FROM contacts WHERE client_id = $1 AND is_active = true ORDER BY priority ASC`,
    [message.client_id]
  );
  const contacts = contactResult.rows;

  // Get webhooks for this client
  const webhookResult = await pool.query(
    'SELECT * FROM client_webhooks WHERE client_id = $1 AND is_active = true',
    [message.client_id]
  );
  const webhooks = webhookResult.rows;

  const deliveryResults = [];

  // Phone-call action: create a record so operators know to call this contact
  if (da.phone_call) {
    for (const contact of contacts.filter((c) => c.call_action !== 'message' || da.phone_call)) {
      const deliveryId = await createDeliveryRecord(messageId, contact.id, 'phone_call', contact.phone);
      await updateDelivery(deliveryId, 'sent');
      deliveryResults.push({ channel: 'phone_call', destination: contact.phone, status: 'sent' });
    }
  }

  // SMS deliveries (only if client allows sms and contact opts in)
  if (da.sms) {
    for (const contact of contacts.filter((c) => c.notify_sms && c.sms_number)) {
      const deliveryId = await createDeliveryRecord(messageId, contact.id, 'sms', contact.sms_number);
      try {
        await sendSms(contact.sms_number, message);
        await updateDelivery(deliveryId, 'sent');
        deliveryResults.push({ channel: 'sms', destination: contact.sms_number, status: 'sent' });
      } catch (err) {
        await updateDelivery(deliveryId, 'failed', err.message);
        deliveryResults.push({ channel: 'sms', destination: contact.sms_number, status: 'failed', error: err.message });
      }
    }
  }

  // Email deliveries (only if client allows email and contact opts in)
  if (da.email) {
    for (const contact of contacts.filter((c) => c.notify_email && c.email)) {
      const deliveryId = await createDeliveryRecord(messageId, contact.id, 'email', contact.email);
      try {
        await sendEmail(contact.email, message);
        await updateDelivery(deliveryId, 'sent');
        deliveryResults.push({ channel: 'email', destination: contact.email, status: 'sent' });
      } catch (err) {
        await updateDelivery(deliveryId, 'failed', err.message);
        deliveryResults.push({ channel: 'email', destination: contact.email, status: 'failed', error: err.message });
      }
    }
  }

  // Webhook deliveries (always honoured when configured)
  for (const webhook of webhooks) {
    const deliveryId = await createDeliveryRecord(messageId, null, 'webhook', webhook.url);
    try {
      await sendWebhook(webhook, message);
      await updateDelivery(deliveryId, 'sent');
      deliveryResults.push({ channel: 'webhook', destination: webhook.url, status: 'sent' });
    } catch (err) {
      await updateDelivery(deliveryId, 'failed', err.message);
      deliveryResults.push({ channel: 'webhook', destination: webhook.url, status: 'failed', error: err.message });
    }
  }

  // In-app: always record as sent
  const inappDeliveryId = await createDeliveryRecord(messageId, null, 'inapp', null);
  await updateDelivery(inappDeliveryId, 'sent');
  deliveryResults.push({ channel: 'inapp', status: 'sent' });

  // Update message status — only external channels (email/sms/webhook) count towards failure
  const externalResults = deliveryResults.filter((r) => ['email', 'sms', 'webhook'].includes(r.channel));
  const allFailed = externalResults.length > 0 && externalResults.every((r) => r.status === 'failed');
  const newStatus = allFailed ? 'failed' : 'delivered';

  await pool.query('UPDATE messages SET status = $1 WHERE id = $2', [newStatus, messageId]);

  return deliveryResults;
}

async function sendSms(toNumber, message) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM_NUMBER;

  if (!accountSid || !authToken || !from) {
    throw new Error('Twilio credentials not configured (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER)');
  }

  const priorityPrefix = message.urgency === 'high' ? 'HIGH PRIORITY: ' : '';
  const body = [
    `${priorityPrefix}Message for ${message.client_name}`,
    `From: ${message.caller_name || message.caller_phone || 'Unknown'}`,
    message.subject ? `Re: ${message.subject}` : null,
    message.body,
  ].filter(Boolean).join('\n');

  await axios.post(
    `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
    new URLSearchParams({ From: from, To: toNumber, Body: body }),
    {
      auth: { username: accountSid, password: authToken },
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    }
  );
}

async function sendEmail(toAddress, message) {
  const transport = getClientTransporter(message);
  const fromAddress = message.smtp_from || process.env.SMTP_FROM;

  const priorityLabel = message.urgency === 'high' ? '[HIGH PRIORITY] ' : '';
  const subject = `${priorityLabel}Message for ${message.client_name}: ${message.subject || 'New Message'}`;

  const priorityLine = message.urgency === 'high'
    ? 'PRIORITY: HIGH\n'
    : message.urgency === 'low'
      ? 'PRIORITY: LOW\n'
      : 'PRIORITY: NORMAL\n';

  const text = `
MESSAGE FOR: ${message.client_name}
${priorityLine}DATE: ${new Date(message.created_at).toLocaleString('en-GB', { timeZone: 'Europe/London' })}

FROM: ${message.caller_name || 'Unknown'} ${message.caller_phone ? `<${message.caller_phone}>` : ''}${message.caller_company ? ` — ${message.caller_company}` : ''}

MESSAGE:
${message.body}

---
Sent by SinglePoint Calls Answering Service
  `.trim();

  await transport.sendMail({
    from: fromAddress,
    to: toAddress,
    subject,
    text,
  });
}

async function sendWebhook(webhook, message) {
  const payload = {
    event: 'message.created',
    timestamp: new Date().toISOString(),
    message: {
      id: message.id,
      client_id: message.client_id,
      client_name: message.client_name,
      caller_name: message.caller_name,
      caller_phone: message.caller_phone,
      caller_company: message.caller_company,
      subject: message.subject,
      body: message.body,
      urgency: message.urgency,
      created_at: message.created_at,
    },
  };

  const headers = { 'Content-Type': 'application/json' };

  if (webhook.secret) {
    const crypto = require('crypto');
    const sig = crypto
      .createHmac('sha256', webhook.secret)
      .update(JSON.stringify(payload))
      .digest('hex');
    headers['X-Answering-Service-Signature'] = `sha256=${sig}`;
  }

  const maxRetries = parseInt(process.env.WEBHOOK_RETRY_ATTEMPTS || '3');
  const timeout = parseInt(process.env.WEBHOOK_TIMEOUT_MS || '5000');

  let lastErr;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await axios.post(webhook.url, payload, { headers, timeout });
      return;
    } catch (err) {
      lastErr = err;
      if (attempt < maxRetries) await sleep(attempt * 1000);
    }
  }
  throw new Error(`Webhook failed after ${maxRetries} attempts: ${lastErr.message}`);
}

async function createDeliveryRecord(messageId, contactId, channel, destination) {
  const result = await pool.query(
    `INSERT INTO message_deliveries (message_id, contact_id, channel, destination, status, attempts)
     VALUES ($1, $2, $3, $4, 'pending', 1)
     RETURNING id`,
    [messageId, contactId, channel, destination]
  );
  return result.rows[0].id;
}

async function updateDelivery(deliveryId, status, errorMessage = null) {
  await pool.query(
    `UPDATE message_deliveries
     SET status = $1, error_message = $2,
         sent_at = CASE WHEN $1 = 'sent' THEN NOW() ELSE sent_at END
     WHERE id = $3`,
    [status, errorMessage, deliveryId]
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { deliverMessage };
