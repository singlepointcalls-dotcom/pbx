'use strict';

/**
 * Customer Satisfaction (CSAT) surveys.
 *
 * Flow:
 *  1. After a call ends, ari.js calls POST /api/csat/send/:callLogId (internal).
 *  2. If the call has a caller phone, a Twilio SMS is sent with a short link.
 *  3. Caller responds via POST /api/csat/respond?token=<uuid>&rating=4 (public).
 *  4. Admins/supervisors view results at GET /api/csat/responses.
 */

const router = require('express').Router();
const pool = require('../../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');

// ── Internal helper — called from ari.js after call ends ──────────────────

async function sendCsatSurvey(callLogId) {
  // Look up call details
  const callRes = await pool.query(
    `SELECT cl.id, cl.client_id, cl.caller_id_num,
            c.name AS client_name, c.csat_enabled
     FROM call_logs cl
     JOIN clients c ON cl.client_id = c.id
     WHERE cl.id = $1`,
    [callLogId]
  );
  const call = callRes.rows[0];
  if (!call || !call.csat_enabled) return null;

  const phone = call.caller_id_num;
  if (!phone || phone.length < 5) return null;

  // Avoid duplicate surveys for same call
  const existing = await pool.query(
    'SELECT id FROM csat_surveys WHERE call_log_id = $1',
    [callLogId]
  );
  if (existing.rows.length) return null;

  const surveyRes = await pool.query(
    `INSERT INTO csat_surveys (call_log_id, client_id, phone)
     VALUES ($1, $2, $3) RETURNING id, token`,
    [callLogId, call.client_id, phone]
  );
  const survey = surveyRes.rows[0];

  // Send SMS via Twilio
  const twilioSid = process.env.TWILIO_ACCOUNT_SID;
  const twilioToken = process.env.TWILIO_AUTH_TOKEN;
  const twilioFrom = process.env.TWILIO_FROM_NUMBER;
  const appUrl = (process.env.APP_URL || 'https://app.example.com').replace(/\/$/, '');

  if (twilioSid && twilioToken && twilioFrom) {
    try {
      const twilio = require('twilio')(twilioSid, twilioToken);
      const rateUrl = `${appUrl}/api/csat/respond?token=${survey.token}`;
      await twilio.messages.create({
        from: twilioFrom,
        to: phone,
        body: `How was your experience with ${call.client_name}? Rate 1-5: ${rateUrl}&rating=5 (or reply 1-5)`,
      });
    } catch (err) {
      console.warn('[CSAT] SMS send failed:', err.message);
    }
  }

  return survey;
}

// ── Public respond endpoint — no auth required ─────────────────────────────

// GET /api/csat/respond?token=<uuid>&rating=<1-5>[&comment=text]
router.get('/respond', async (req, res, next) => {
  try {
    const { token, rating, comment } = req.query;
    if (!token) return res.status(400).send('Missing token');
    const r = parseInt(rating);
    if (!r || r < 1 || r > 5) return res.status(400).send('Rating must be 1-5');

    const result = await pool.query(
      `UPDATE csat_surveys
       SET rating = $1, comment = $2, responded_at = NOW()
       WHERE token = $3 AND responded_at IS NULL
       RETURNING id`,
      [r, comment || null, token]
    );
    if (!result.rows.length) {
      return res.status(410).send('Survey already completed or not found');
    }
    res.send('<html><body style="font-family:sans-serif;text-align:center;padding:40px"><h2>Thank you for your feedback!</h2><p>Your response has been recorded.</p></body></html>');
  } catch (err) { next(err); }
});

// POST /api/csat/respond — JSON version (for SMS reply webhook or direct API)
router.post('/respond', async (req, res, next) => {
  try {
    const { token, rating, comment } = req.body;
    if (!token) return res.status(400).json({ error: 'token required' });
    const r = parseInt(rating);
    if (!r || r < 1 || r > 5) return res.status(400).json({ error: 'rating must be 1-5' });

    const result = await pool.query(
      `UPDATE csat_surveys
       SET rating = $1, comment = $2, responded_at = NOW()
       WHERE token = $3 AND responded_at IS NULL
       RETURNING id`,
      [r, comment || null, token]
    );
    if (!result.rows.length) return res.status(410).json({ error: 'Survey already completed or not found' });
    res.json({ message: 'Thank you for your feedback' });
  } catch (err) { next(err); }
});

// ── Authenticated routes below ─────────────────────────────────────────────

router.use(requireAuth);

// POST /api/csat/send/:callLogId — manually trigger CSAT survey for a call
router.post('/send/:callLogId', requireRole('admin', 'supervisor'), async (req, res, next) => {
  try {
    const survey = await sendCsatSurvey(req.params.callLogId);
    if (!survey) return res.status(409).json({ error: 'Survey not sent — call not found, CSAT disabled for client, or already sent' });
    res.status(201).json({ survey });
  } catch (err) { next(err); }
});

// GET /api/csat/responses — all responses (admin/supervisor)
router.get('/responses', requireRole('admin', 'supervisor'), async (req, res, next) => {
  try {
    const { client_id, limit: lim = '50', offset: off = '0' } = req.query;
    const limit = Math.min(parseInt(lim), 200);
    const offset = parseInt(off);

    const params = [limit, offset];
    let where = '';
    if (client_id) {
      params.push(client_id);
      where = `WHERE cs.client_id = $${params.length}`;
    }

    const result = await pool.query(
      `SELECT cs.id, cs.token, cs.phone, cs.sent_at, cs.responded_at,
              cs.rating, cs.comment,
              c.name AS client_name, cl.caller_id_name
       FROM csat_surveys cs
       LEFT JOIN clients c ON cs.client_id = c.id
       LEFT JOIN call_logs cl ON cs.call_log_id = cl.id
       ${where}
       ORDER BY cs.sent_at DESC
       LIMIT $1 OFFSET $2`,
      params
    );

    const stats = await pool.query(
      `SELECT COUNT(*) FILTER (WHERE responded_at IS NOT NULL) AS responded,
              COUNT(*) AS total,
              ROUND(AVG(rating) FILTER (WHERE rating IS NOT NULL), 2) AS avg_rating
       FROM csat_surveys cs ${where}`,
      client_id ? [client_id] : []
    );

    res.json({ responses: result.rows, stats: stats.rows[0] });
  } catch (err) { next(err); }
});

// GET /api/csat/stats — summary by client for dashboard
router.get('/stats', requireRole('admin', 'supervisor'), async (req, res, next) => {
  try {
    const days = parseInt(req.query.days || '30');
    const result = await pool.query(
      `SELECT c.id, c.name AS client_name,
              COUNT(cs.id)                                           AS surveys_sent,
              COUNT(cs.id) FILTER (WHERE cs.responded_at IS NOT NULL) AS responded,
              ROUND(AVG(cs.rating) FILTER (WHERE cs.rating IS NOT NULL), 2) AS avg_rating,
              COUNT(cs.id) FILTER (WHERE cs.rating >= 4)            AS promoters,
              COUNT(cs.id) FILTER (WHERE cs.rating <= 2)            AS detractors
       FROM clients c
       LEFT JOIN csat_surveys cs
         ON cs.client_id = c.id AND cs.sent_at >= NOW() - ($1 || ' days')::INTERVAL
       WHERE c.is_active = true
       GROUP BY c.id, c.name
       ORDER BY avg_rating DESC NULLS LAST`,
      [days]
    );
    res.json({ stats: result.rows, days });
  } catch (err) { next(err); }
});

module.exports = { router, sendCsatSurvey };
