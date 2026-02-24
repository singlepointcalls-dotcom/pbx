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
/* ---- HTML email default template ---- */
const DEFAULT_HTML_TEMPLATE = `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:0;background:#f5f7fa;font-family:Arial,sans-serif">
<div style="max-width:600px;margin:24px auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08)">
<div style="background:#1a2a4a;color:#fff;padding:16px 24px;font-size:15px;font-weight:700">SinglePoint Calls<span style="margin-left:10px;opacity:.6;font-size:12px;font-weight:400">Answering Service</span></div>
<div style="padding:24px">
<div style="font-size:12px;color:#888;margin-bottom:4px">Message for</div>
<div style="font-size:20px;font-weight:700;color:#1a2a4a;margin-bottom:18px">{{client_name}}</div>
<table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:18px">
<tr><td style="padding:6px 0;border-bottom:1px solid #f0f0f0;color:#888;width:110px">Date</td><td style="padding:6px 0;border-bottom:1px solid #f0f0f0">{{date}}</td></tr>
<tr><td style="padding:6px 0;border-bottom:1px solid #f0f0f0;color:#888">Priority</td><td style="padding:6px 0;border-bottom:1px solid #f0f0f0"><strong>{{urgency}}</strong></td></tr>
<tr><td style="padding:6px 0;border-bottom:1px solid #f0f0f0;color:#888">From</td><td style="padding:6px 0;border-bottom:1px solid #f0f0f0">{{caller_name}} {{caller_phone}} {{caller_company}}</td></tr>
<tr><td style="padding:6px 0;border-bottom:1px solid #f0f0f0;color:#888">Taken by</td><td style="padding:6px 0;border-bottom:1px solid #f0f0f0">{{operator_name}}</td></tr>
{{subject_row}}
</table>
<div style="background:#f5f7fa;border-left:4px solid #4f7aff;padding:16px;border-radius:4px;white-space:pre-wrap;font-size:14px;line-height:1.6">{{body}}</div>
</div>
<div style="padding:14px 24px;border-top:1px solid #eee;font-size:11px;color:#aaa;text-align:center">Sent by SinglePoint Calls Answering Service</div>
</div></body></html>`;

function renderTemplate(tmpl, vars) {
  return tmpl.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] !== undefined ? vars[key] : '');
}

function buildEmailVars(message) {
  const dateStr = new Date(message.created_at).toLocaleString('en-GB', { timeZone: 'Europe/London' });
  return {
    client_name:    message.client_name || '',
    caller_name:    message.caller_name || 'Unknown',
    caller_phone:   message.caller_phone ? `<${message.caller_phone}>` : '',
    caller_company: message.caller_company ? `— ${message.caller_company}` : '',
    subject:        message.subject || '',
    body:           message.body || '',
    urgency:        (message.urgency || 'normal').toUpperCase(),
    date:           dateStr,
    operator_name:  message.operator_name || '',
    subject_row:    message.subject
      ? `<tr><td style="padding:6px 0;border-bottom:1px solid #f0f0f0;color:#888">Subject</td><td style="padding:6px 0;border-bottom:1px solid #f0f0f0">${message.subject}</td></tr>`
      : '',
  };
}

async function deliverMessage(messageId) {
  const msgResult = await pool.query(
    `SELECT m.*, c.name AS client_name, o.full_name AS operator_name,
            c.delivery_actions, c.smtp_host, c.smtp_port,
            c.smtp_user, c.smtp_pass, c.smtp_from, c.email_template
     FROM messages m
     JOIN clients c ON m.client_id = c.id
     LEFT JOIN operators o ON m.operator_id = o.id
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

  const urgencyLabel = (message.urgency || 'normal').toUpperCase();
  const isHigh = message.urgency === 'urgent' || message.urgency === 'emergency';
  const priorityTag = isHigh ? `[${urgencyLabel}] ` : '';
  const subject = `${priorityTag}Message for ${message.client_name}: ${message.subject || 'New Message'}`;

  // Render email body from template
  const vars = buildEmailVars(message);
  const template = message.email_template || DEFAULT_HTML_TEMPLATE;
  const html = renderTemplate(template, vars);

  // Plain-text fallback
  const text = `MESSAGE FOR: ${message.client_name}\nPRIORITY: ${urgencyLabel}\nDATE: ${vars.date}\n\nFROM: ${message.caller_name || 'Unknown'} ${message.caller_phone ? `<${message.caller_phone}>` : ''}${message.caller_company ? ` — ${message.caller_company}` : ''}\n\nMESSAGE:\n${message.body}\n\n---\nSent by SinglePoint Calls Answering Service`;

  await transport.sendMail({ from: fromAddress, to: toAddress, subject, text, html });
}

/**
 * Send a quick email or SMS directly to a single contact (from screen pop).
 */
async function sendQuickNotify(contact, channel, subject, body) {
  if (channel === 'email') {
    if (!contact.email) throw new Error('Contact has no email address');
    const transport = getClientTransporter(contact);
    const from = contact.smtp_from || process.env.SMTP_FROM;
    await transport.sendMail({
      from,
      to: contact.email,
      subject: subject || `Message from ${contact.client_name || 'SinglePoint Calls'}`,
      text: body,
    });
  } else if (channel === 'sms') {
    const to = contact.sms_number || contact.phone;
    if (!to) throw new Error('Contact has no SMS/phone number');
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const from = process.env.TWILIO_FROM_NUMBER;
    if (!accountSid || !authToken || !from) throw new Error('Twilio not configured');
    await axios.post(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
      new URLSearchParams({ From: from, To: to, Body: body }),
      { auth: { username: accountSid, password: authToken }, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
  } else {
    throw new Error(`Unsupported channel: ${channel}`);
  }
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

module.exports = { deliverMessage, sendQuickNotify };
