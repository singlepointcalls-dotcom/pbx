'use strict';

/**
 * Report scheduler — runs every 15 minutes, emails due scheduled reports.
 *
 * For each due report_schedule row:
 *  1. Generate the report data (SQL query matching report_type).
 *  2. Convert to CSV.
 *  3. Email to all recipients as an attachment.
 *  4. Update last_sent_at and compute next_run_at.
 */

const pool = require('../config/database');
const nodemailer = require('nodemailer');

function toCsv(rows) {
  if (!rows.length) return 'No data';
  const headers = Object.keys(rows[0]);
  const escape = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  return [headers.join(','), ...rows.map((r) => headers.map((h) => escape(r[h])).join(','))].join('\r\n');
}

function nextRunAt(frequency) {
  const d = new Date();
  if (frequency === 'daily') d.setDate(d.getDate() + 1);
  else if (frequency === 'weekly') d.setDate(d.getDate() + 7);
  else d.setMonth(d.getMonth() + 1);
  d.setHours(8, 0, 0, 0);
  return d;
}

async function generateReportData(reportType, clientId) {
  const where = clientId ? `AND client_id = '${clientId}'` : '';
  const clientWhere = clientId ? `AND cl.client_id = '${clientId}'` : '';

  if (reportType === 'calls') {
    const r = await pool.query(`
      SELECT DATE(call_start) AS date,
             COUNT(*) AS total_calls,
             COUNT(*) FILTER (WHERE disposition = 'answered') AS answered,
             COUNT(*) FILTER (WHERE disposition = 'no_answer') AS missed,
             ROUND(AVG(duration_seconds) FILTER (WHERE duration_seconds IS NOT NULL)) AS avg_duration_s
      FROM call_logs
      WHERE call_start >= NOW() - INTERVAL '30 days' ${clientWhere}
      GROUP BY DATE(call_start) ORDER BY date DESC
    `);
    return r.rows;
  }

  if (reportType === 'messages') {
    const r = await pool.query(`
      SELECT DATE(created_at) AS date,
             COUNT(*) AS total,
             COUNT(*) FILTER (WHERE status = 'pending') AS pending,
             COUNT(*) FILTER (WHERE status = 'delivered') AS delivered,
             COUNT(*) FILTER (WHERE urgency = 'urgent') AS urgent
      FROM messages
      WHERE created_at >= NOW() - INTERVAL '30 days' ${where ? where.replace('client_id', 'client_id') : ''}
      GROUP BY DATE(created_at) ORDER BY date DESC
    `);
    return r.rows;
  }

  if (reportType === 'performance') {
    const r = await pool.query(`
      SELECT o.full_name, o.username,
             COUNT(cl.id) FILTER (WHERE cl.call_answered IS NOT NULL) AS calls_answered,
             COUNT(cl.id) FILTER (WHERE cl.call_answered IS NULL AND cl.call_end IS NOT NULL) AS calls_missed,
             ROUND(AVG(cl.duration_seconds)) AS avg_duration_s,
             ROUND(AVG(q.overall)) AS avg_qa_score
      FROM operators o
      LEFT JOIN call_logs cl ON cl.operator_id = o.id AND cl.call_start >= NOW() - INTERVAL '30 days'
      LEFT JOIN call_qa_scores q ON q.call_log_id = cl.id
      WHERE o.is_active = true
      GROUP BY o.id, o.full_name, o.username ORDER BY calls_answered DESC
    `);
    return r.rows;
  }

  if (reportType === 'sla') {
    const r = await pool.query(`
      SELECT c.name AS client,
             COUNT(m.id) AS total_messages,
             COUNT(m.id) FILTER (WHERE m.acknowledged_at IS NOT NULL
               AND EXTRACT(EPOCH FROM (m.acknowledged_at - m.created_at)) / 60 <= COALESCE(c.sla_minutes, 60)) AS within_sla,
             COUNT(m.id) FILTER (WHERE m.acknowledged_at IS NULL) AS unacknowledged,
             ROUND(AVG(EXTRACT(EPOCH FROM (m.acknowledged_at - m.created_at)) / 60)
               FILTER (WHERE m.acknowledged_at IS NOT NULL)) AS avg_response_minutes
      FROM clients c
      LEFT JOIN messages m ON m.client_id = c.id AND m.created_at >= NOW() - INTERVAL '30 days'
      WHERE c.is_active = true
      GROUP BY c.id, c.name ORDER BY within_sla ASC
    `);
    return r.rows;
  }

  return [];
}

async function runDueReports() {
  let due;
  try {
    const result = await pool.query(
      `SELECT * FROM report_schedules
       WHERE is_active = true AND next_run_at <= NOW()
       ORDER BY next_run_at ASC
       LIMIT 20`
    );
    due = result.rows;
  } catch (err) {
    console.error('[ReportScheduler] DB error fetching due reports:', err.message);
    return;
  }

  if (!due.length) return;

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_SECURE === 'true',
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });

  for (const schedule of due) {
    try {
      const rows = await generateReportData(schedule.report_type, schedule.client_id);
      const csv = toCsv(rows);
      const dateStr = new Date().toISOString().slice(0, 10);
      const filename = `${schedule.report_type}-report-${dateStr}.csv`;

      await transporter.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER || 'reports@answering-service.local',
        to: schedule.recipients.join(', '),
        subject: `Scheduled ${schedule.report_type} report — ${dateStr}`,
        text: `Please find the ${schedule.frequency} ${schedule.report_type} report attached.`,
        attachments: [{ filename, content: csv, contentType: 'text/csv' }],
      });

      await pool.query(
        `UPDATE report_schedules SET last_sent_at = NOW(), next_run_at = $1 WHERE id = $2`,
        [nextRunAt(schedule.frequency), schedule.id]
      );

      console.log(`[ReportScheduler] Sent ${schedule.report_type} report to ${schedule.recipients.join(', ')}`);
    } catch (err) {
      console.error(`[ReportScheduler] Failed to send schedule ${schedule.id}:`, err.message);
      // Advance next_run_at anyway to prevent retry storm
      await pool.query(
        `UPDATE report_schedules SET next_run_at = $1 WHERE id = $2`,
        [nextRunAt(schedule.frequency), schedule.id]
      ).catch(() => {});
    }
  }
}

function startReportScheduler() {
  // Run immediately on startup to catch any missed reports, then every 15 minutes
  runDueReports().catch(() => {});
  setInterval(() => runDueReports().catch(() => {}), 15 * 60 * 1000);
  console.log('[ReportScheduler] Started — checking every 15 minutes');
}

module.exports = { startReportScheduler };
