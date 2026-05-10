'use strict';

/**
 * SLA Pre-breach alerting service.
 *
 * Checks every 5 minutes for messages that are:
 * - Not yet acknowledged
 * - 80%+ through their SLA window (based on client.sla_minutes or 60 min default)
 * - Not already alerted
 *
 * Sends: email to admins/supervisors + Slack/Teams webhooks per affected client.
 */

const pool = require('../config/database');
const nodemailer = require('nodemailer');
const { isPrivateUrl } = require('./delivery');

const CHECK_INTERVAL_MS = 5 * 60 * 1000;
const SLA_WARN_PCT = 0.80; // alert at 80% of SLA elapsed

async function runSlaAlertCheck() {
  try {
    // Find messages approaching SLA breach with no pre-breach alert sent
    const result = await pool.query(`
      SELECT m.id, m.subject, m.urgency, m.created_at,
             c.name AS client_name, c.slack_webhook, c.teams_webhook,
             COALESCE(c.sla_minutes, 60) AS sla_minutes,
             EXTRACT(EPOCH FROM (NOW() - m.created_at)) / 60 AS age_minutes
      FROM messages m
      JOIN clients c ON m.client_id = c.id
      WHERE m.acknowledged_at IS NULL
        AND m.status IN ('pending', 'delivered')
        AND NOT EXISTS (
          SELECT 1 FROM sla_alerts sa
          WHERE sa.message_id = m.id AND sa.alert_type = 'pre_breach'
        )
        AND EXTRACT(EPOCH FROM (NOW() - m.created_at)) / 60
            >= COALESCE(c.sla_minutes, 60) * $1
        AND EXTRACT(EPOCH FROM (NOW() - m.created_at)) / 60
            < COALESCE(c.sla_minutes, 60)
    `, [SLA_WARN_PCT]);

    if (!result.rows.length) return;

    // Get admin/supervisor emails
    const supervisorResult = await pool.query(
      `SELECT email FROM operators WHERE role IN ('admin','supervisor') AND is_active = true AND email IS NOT NULL`
    );
    const recipients = supervisorResult.rows.map((r) => r.email).filter(Boolean);
    if (!recipients.length) return;

    // Log alerts first to prevent duplicate sends
    const alertIds = result.rows.map((r) => r.id);
    await pool.query(
      `INSERT INTO sla_alerts (message_id, alert_type)
       SELECT unnest($1::uuid[]), 'pre_breach'
       ON CONFLICT DO NOTHING`,
      [alertIds]
    );

    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '587'),
      secure: process.env.SMTP_SECURE === 'true',
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    });

    const msgList = result.rows.map((m) => {
      const sla = m.sla_minutes || 60;
      const pct = Math.round((m.age_minutes / sla) * 100);
      return `• ${m.client_name}: "${m.subject || '(no subject)'}" — ${Math.round(m.age_minutes)}/${sla} min (${pct}% of SLA)`;
    }).join('\n');

    await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER || 'alerts@answering-service.local',
      to: recipients.join(', '),
      subject: `⚠️ SLA Warning: ${result.rows.length} message(s) approaching breach`,
      text: `The following messages are approaching their SLA deadline and have not been acknowledged:\n\n${msgList}\n\nPlease action these messages promptly.`,
    });

    console.log(`[SLA Alerts] Sent pre-breach warning for ${result.rows.length} message(s) to ${recipients.length} supervisor(s)`);

    // Push to client Slack/Teams webhooks
    const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
    for (const msg of result.rows) {
      const sla = msg.sla_minutes || 60;
      const pct = Math.round((msg.age_minutes / sla) * 100);
      const text = `⚠️ SLA Warning [${msg.client_name}]: "${msg.subject || '(no subject)'}" — ${Math.round(msg.age_minutes)}/${sla} min (${pct}% elapsed)`;

      if (msg.slack_webhook && !isPrivateUrl(msg.slack_webhook)) {
        fetch(msg.slack_webhook, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text }),
        }).catch((e) => console.warn('[SLA Alerts] Slack push failed:', e.message));
      }

      if (msg.teams_webhook && !isPrivateUrl(msg.teams_webhook)) {
        fetch(msg.teams_webhook, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            '@type': 'MessageCard', '@context': 'http://schema.org/extensions',
            summary: text, themeColor: 'FF8C00', text,
          }),
        }).catch((e) => console.warn('[SLA Alerts] Teams push failed:', e.message));
      }
    }
  } catch (err) {
    console.error('[SLA Alerts] Check failed:', err.message);
  }
}

function startSlaAlertService() {
  console.log('[SLA Alerts] Started — checking every 5 minutes');
  setTimeout(runSlaAlertCheck, 15000); // initial check 15s after start
  setInterval(runSlaAlertCheck, CHECK_INTERVAL_MS);
}

module.exports = { startSlaAlertService };
