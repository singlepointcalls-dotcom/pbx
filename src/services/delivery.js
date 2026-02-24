'use strict';

/**
 * Message Delivery Service
 *
 * Delivers messages to client contacts via:
 *   - Email (SMTP via nodemailer)
 *   - Webhook (HTTP POST to client-configured URL)
 *   - In-app (always stored; no external delivery needed)
 */

const nodemailer = require('nodemailer');
const axios = require('axios');
const pool = require('../config/database');

// Lazily created SMTP transporter
let transporter = null;

function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '587'),
      secure: process.env.SMTP_SECURE === 'true',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASSWORD,
      },
    });
  }
  return transporter;
}

/**
 * Deliver a message to all active contacts for the client.
 * Creates delivery records and attempts each channel.
 */
async function deliverMessage(messageId) {
  const msgResult = await pool.query(
    `SELECT m.*, c.name AS client_name
     FROM messages m
     JOIN clients c ON m.client_id = c.id
     WHERE m.id = $1`,
    [messageId]
  );
  const message = msgResult.rows[0];
  if (!message) throw new Error(`Message ${messageId} not found`);

  // Get active contacts for this client who want notifications
  const contactResult = await pool.query(
    `SELECT * FROM contacts
     WHERE client_id = $1 AND is_active = true
     ORDER BY priority ASC`,
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

  // Email deliveries
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

  // Webhook deliveries
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

  // Update message status
  // Only consider external channels (email/webhook) when deciding failed vs delivered.
  // [].every() returns true (vacuous truth), so guard with a length check to avoid
  // marking in-app-only deliveries as failed.
  const externalResults = deliveryResults.filter((r) => r.channel !== 'inapp');
  const allFailed = externalResults.length > 0 && externalResults.every((r) => r.status === 'failed');
  const newStatus = allFailed ? 'failed' : 'delivered';

  await pool.query('UPDATE messages SET status = $1 WHERE id = $2', [newStatus, messageId]);

  return deliveryResults;
}

async function sendEmail(toAddress, message) {
  const transport = getTransporter();
  const urgencyLabel = message.urgency === 'emergency' ? '[EMERGENCY] ' : message.urgency === 'urgent' ? '[URGENT] ' : '';
  const subject = `${urgencyLabel}Message for ${message.client_name}: ${message.subject || 'New Message'}`;

  const text = `
MESSAGE FOR: ${message.client_name}
URGENCY: ${message.urgency.toUpperCase()}
DATE: ${new Date(message.created_at).toLocaleString()}

FROM: ${message.caller_name || 'Unknown'} ${message.caller_phone ? `<${message.caller_phone}>` : ''}${message.caller_company ? ` — ${message.caller_company}` : ''}

MESSAGE:
${message.body}

---
Sent by Answering Service
  `.trim();

  await transport.sendMail({
    from: process.env.SMTP_FROM,
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

  // Sign payload if secret is configured
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
      if (attempt < maxRetries) {
        await sleep(attempt * 1000);
      }
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
    `UPDATE message_deliveries SET status = $1, error_message = $2, sent_at = CASE WHEN $1 = 'sent' THEN NOW() ELSE sent_at END
     WHERE id = $3`,
    [status, errorMessage, deliveryId]
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { deliverMessage };
