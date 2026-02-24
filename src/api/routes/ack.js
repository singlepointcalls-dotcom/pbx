'use strict';

const router = require('express').Router();
const pool = require('../../config/database');

function ackPage(title, heading, body, statusColour) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: Arial, Helvetica, sans-serif;
      background: #f5f7fa;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 24px;
    }
    .card {
      background: #ffffff;
      border-radius: 10px;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.10);
      max-width: 480px;
      width: 100%;
      padding: 48px 40px;
      text-align: center;
    }
    .icon {
      font-size: 56px;
      line-height: 1;
      margin-bottom: 20px;
    }
    .heading {
      font-size: 24px;
      font-weight: 700;
      color: ${statusColour};
      margin-bottom: 12px;
    }
    .message {
      font-size: 15px;
      color: #555;
      line-height: 1.6;
    }
    .timestamp {
      display: inline-block;
      margin-top: 20px;
      padding: 8px 16px;
      background: #f0f4ff;
      border-radius: 6px;
      font-size: 13px;
      color: #888;
    }
    .footer {
      margin-top: 36px;
      font-size: 11px;
      color: #bbb;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">${heading.icon}</div>
    <div class="heading">${heading.text}</div>
    <div class="message">${body.message}</div>
    ${body.timestamp ? `<div class="timestamp">${body.timestamp}</div>` : ''}
    <div class="footer">SinglePoint Calls Answering Service</div>
  </div>
</body>
</html>`;
}

// GET /ack/:token — public acknowledgement link (no auth required)
router.get('/:token', async (req, res, next) => {
  try {
    const result = await pool.query(
      'SELECT id, acknowledged_at FROM messages WHERE ack_token = $1',
      [req.params.token]
    );

    if (!result.rows[0]) {
      const html = ackPage(
        'Unknown Token',
        { icon: '&#10060;', text: 'Link Not Found' },
        { message: 'This acknowledgement link is invalid or has expired.', timestamp: null },
        '#cc3300'
      );
      return res.status(404).type('html').send(html);
    }

    const row = result.rows[0];

    if (row.acknowledged_at) {
      const ackedAt = new Date(row.acknowledged_at).toLocaleString('en-GB', {
        timeZone: 'Europe/London',
        dateStyle: 'long',
        timeStyle: 'short',
      });
      const html = ackPage(
        'Already Acknowledged',
        { icon: '&#8987;', text: 'Already Acknowledged' },
        {
          message: 'This message was already acknowledged.',
          timestamp: `Acknowledged on ${ackedAt}`,
        },
        '#888888'
      );
      return res.status(200).type('html').send(html);
    }

    // Mark as acknowledged
    await pool.query(
      `UPDATE messages SET acknowledged_at = NOW(), status = 'read' WHERE id = $1`,
      [row.id]
    );

    const now = new Date().toLocaleString('en-GB', {
      timeZone: 'Europe/London',
      dateStyle: 'long',
      timeStyle: 'short',
    });

    const html = ackPage(
      'Message Acknowledged',
      { icon: '&#x2705;', text: 'Message Acknowledged' },
      {
        message: 'Thank you &mdash; your message has been acknowledged.',
        timestamp: `Acknowledged on ${now}`,
      },
      '#2a7a2a'
    );
    return res.status(200).type('html').send(html);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
