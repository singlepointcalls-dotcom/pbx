'use strict';

/**
 * Appointment Reminder Service
 *
 * Polls every 5 minutes for upcoming appointments that:
 *   - Are scheduled 24 hours from now (±5 min window) — sends 24 h reminder
 *   - Are scheduled 1 hour from now (±5 min window) — sends 1 h reminder
 *   - Have a caller_email set
 *   - Have NOT already had that reminder sent (reminder_sent_at NULL or < threshold)
 *
 * Uses the global SMTP transport (same as delivery.js sendMail).
 * Updates reminder_sent_at after sending to prevent duplicates.
 */

const pool   = require('../config/database');
const nodemailer = require('nodemailer');

const POLL_INTERVAL_MS = 5 * 60_000;

function makeTransport() {
  return nodemailer.createTransport({
    host:   process.env.SMTP_HOST,
    port:   parseInt(process.env.SMTP_PORT || '587', 10),
    secure: process.env.SMTP_SECURE === 'true',
    auth:   process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
}

async function sendReminderEmail(appt, hoursAhead) {
  if (!process.env.SMTP_HOST) return; // SMTP not configured
  const transport = makeTransport();
  const when = new Date(appt.appointment_at).toLocaleString('en-GB', {
    dateStyle: 'full', timeStyle: 'short', timeZone: appt.timezone || 'Europe/London',
  });
  await transport.sendMail({
    from:    process.env.SMTP_FROM || process.env.SMTP_USER || 'noreply@answering-service',
    to:      appt.caller_email,
    subject: `Appointment reminder: ${appt.service_type || 'Appointment'} in ${hoursAhead} hour${hoursAhead > 1 ? 's' : ''}`,
    text: [
      `Hi ${appt.caller_name || 'there'},`,
      ``,
      `This is a reminder that you have an appointment${appt.client_name ? ` with ${appt.client_name}` : ''} scheduled for:`,
      ``,
      `  ${when}`,
      appt.service_type ? `  Service: ${appt.service_type}` : '',
      appt.notes        ? `  Notes: ${appt.notes}` : '',
      ``,
      `If you need to reschedule, please contact us directly.`,
    ].filter((l) => l !== null).join('\n'),
  });
}

async function runReminderTick() {
  // 24-hour reminders
  try {
    const rows24h = await pool.query(`
      SELECT a.*, c.name AS client_name, c.timezone
        FROM appointments a
        LEFT JOIN clients c ON a.client_id = c.id
       WHERE a.caller_email IS NOT NULL
         AND a.status NOT IN ('cancelled','completed')
         AND a.appointment_at BETWEEN NOW() + INTERVAL '23 hours 55 minutes'
                                   AND NOW() + INTERVAL '24 hours 5 minutes'
         AND (a.reminder_sent_at IS NULL OR a.reminder_sent_at < NOW() - INTERVAL '23 hours')
    `);
    for (const appt of rows24h.rows) {
      try {
        await sendReminderEmail(appt, 24);
        await pool.query(
          'UPDATE appointments SET reminder_sent_at = NOW() WHERE id = $1',
          [appt.id]
        );
      } catch (err) {
        console.warn(`[AppointmentReminders] 24h email failed for ${appt.id}: ${err.message}`);
      }
    }
  } catch (err) {
    console.error('[AppointmentReminders] 24h query error:', err.message);
  }

  // 1-hour reminders
  try {
    const rows1h = await pool.query(`
      SELECT a.*, c.name AS client_name, c.timezone
        FROM appointments a
        LEFT JOIN clients c ON a.client_id = c.id
       WHERE a.caller_email IS NOT NULL
         AND a.status NOT IN ('cancelled','completed')
         AND a.appointment_at BETWEEN NOW() + INTERVAL '55 minutes'
                                   AND NOW() + INTERVAL '65 minutes'
         AND (a.reminder_sent_at IS NULL OR a.reminder_sent_at < NOW() - INTERVAL '55 minutes')
    `);
    for (const appt of rows1h.rows) {
      try {
        await sendReminderEmail(appt, 1);
        await pool.query(
          'UPDATE appointments SET reminder_sent_at = NOW() WHERE id = $1',
          [appt.id]
        );
      } catch (err) {
        console.warn(`[AppointmentReminders] 1h email failed for ${appt.id}: ${err.message}`);
      }
    }
  } catch (err) {
    console.error('[AppointmentReminders] 1h query error:', err.message);
  }
}

function startAppointmentReminders() {
  console.log('[AppointmentReminders] Started — polling every 5 min');
  setInterval(() => runReminderTick().catch((err) =>
    console.error('[AppointmentReminders] Tick error:', err.message)
  ), POLL_INTERVAL_MS);
  setTimeout(() => runReminderTick().catch(() => {}), 10_000);
}

module.exports = { startAppointmentReminders };
