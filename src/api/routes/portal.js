'use strict';

const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const pool = require('../../config/database');
const { broadcast } = require('../../services/realtime');

const UPLOAD_DIR = path.join(__dirname, '..', '..', '..', 'uploads');

/* ---- Shared password validator ---- */
function validatePassword(password) {
  if (!password || password.length < 12) return 'Password must be at least 12 characters';
  if (!/[A-Z]/.test(password)) return 'Password must include an uppercase letter';
  if (!/[a-z]/.test(password)) return 'Password must include a lowercase letter';
  if (!/[0-9]/.test(password)) return 'Password must include a number';
  if (!/[^A-Za-z0-9]/.test(password)) return 'Password must include a special character';
  return null;
}

/* ---- Simple rate limiter for portal login (mirrors operator auth limiter) ---- */
const portalLoginAttempts = new Map();
const PORTAL_RATE_WINDOW_MS = 15 * 60 * 1000;
const PORTAL_MAX_ATTEMPTS = 10;

function rateLimitPortal(req, res, next) {
  const key = req.ip + ':' + (req.body?.username || '');
  const now = Date.now();
  const entry = portalLoginAttempts.get(key);
  if (entry) {
    if (now - entry.firstAttempt > PORTAL_RATE_WINDOW_MS) {
      portalLoginAttempts.set(key, { count: 1, firstAttempt: now });
      return next();
    }
    if (entry.count >= PORTAL_MAX_ATTEMPTS) {
      const retryAfter = Math.ceil((entry.firstAttempt + PORTAL_RATE_WINDOW_MS - now) / 1000);
      res.setHeader('Retry-After', retryAfter);
      return res.status(429).json({ error: 'Too many login attempts. Please try again later.' });
    }
    entry.count++;
  } else {
    portalLoginAttempts.set(key, { count: 1, firstAttempt: now });
  }
  if (portalLoginAttempts.size > 500) {
    for (const [k, v] of portalLoginAttempts) {
      if (now - v.firstAttempt > PORTAL_RATE_WINDOW_MS) portalLoginAttempts.delete(k);
    }
  }
  next();
}

// Portal tokens use their own secret so a leaked operator JWT cannot be used here.
// Set PORTAL_JWT_SECRET in .env; falls back to JWT_SECRET if not configured.
const PORTAL_JWT_SECRET = () => process.env.PORTAL_JWT_SECRET || process.env.JWT_SECRET;

/* ---- Portal auth middleware — accepts JWT or X-Api-Key ---- */
async function requirePortalAuth(req, res, next) {
  // 1. API key path: X-Api-Key header
  const apiKey = req.headers['x-api-key'];
  if (apiKey && apiKey.length >= 8) {
    try {
      const prefix = apiKey.slice(0, 8);
      const rows = await pool.query(
        `SELECT pak.id, pak.key_hash, pak.scopes, pak.expires_at, pak.revoked_at,
                cpu.id AS user_id, cpu.client_id, cpu.username
         FROM portal_api_keys pak
         JOIN client_portal_users cpu ON pak.portal_user_id = cpu.id
         WHERE pak.key_prefix = $1`,
        [prefix]
      );
      for (const row of rows.rows) {
        if (row.revoked_at) continue;
        if (row.expires_at && new Date(row.expires_at) < new Date()) continue;
        const match = await bcrypt.compare(apiKey, row.key_hash);
        if (!match) continue;
        // Valid key — update last_used_at async, no await
        pool.query('UPDATE portal_api_keys SET last_used_at = NOW() WHERE id = $1', [row.id]).catch(() => {});
        req.portalUser = { id: row.user_id, client_id: row.client_id, username: row.username, type: 'portal', scopes: row.scopes };
        return next();
      }
      return res.status(401).json({ error: 'Invalid or revoked API key' });
    } catch (err) {
      return next(err);
    }
  }

  // 2. JWT path: Authorization header or ?token= query param
  const raw = req.query.token ||
    (req.headers.authorization || '').replace(/^Bearer /, '');
  if (!raw) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const payload = jwt.verify(raw, PORTAL_JWT_SECRET(), { algorithms: ['HS256'] });
    if (payload.type !== 'portal') return res.status(403).json({ error: 'Forbidden' });
    req.portalUser = payload;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// POST /api/portal/login
router.post('/login', rateLimitPortal, async (req, res, next) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }

    const result = await pool.query(
      `SELECT cpu.*, c.name AS client_name, c.account_number
       FROM client_portal_users cpu
       JOIN clients c ON cpu.client_id = c.id
       WHERE cpu.username = $1 AND cpu.is_active = true`,
      [username]
    );
    const user = result.rows[0];

    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign(
      { id: user.id, client_id: user.client_id, username: user.username, type: 'portal' },
      PORTAL_JWT_SECRET(),
      { algorithm: 'HS256', expiresIn: '4h' }
    );

    res.json({
      token,
      user: { id: user.id, username: user.username, email: user.email,
              client_id: user.client_id, client_name: user.client_name,
              account_number: user.account_number },
    });
  } catch (err) { next(err); }
});

// GET /api/portal/me
router.get('/me', requirePortalAuth, async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT cpu.id, cpu.username, cpu.email, cpu.client_id, cpu.created_at,
              c.name AS client_name, c.account_number, c.address, c.opening_times, c.timezone
       FROM client_portal_users cpu
       JOIN clients c ON cpu.client_id = c.id
       WHERE cpu.id = $1`,
      [req.portalUser.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'User not found' });
    res.json({ user: result.rows[0] });
  } catch (err) { next(err); }
});

// GET /api/portal/messages/stats — message counts by status for the past 30 days
router.get('/messages/stats', requirePortalAuth, async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE status IN ('pending','delivered'))::int AS pending,
         COUNT(*) FILTER (WHERE status = 'acknowledged')::int AS acknowledged,
         COUNT(*) FILTER (WHERE urgency = 'urgent')::int AS urgent,
         COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days')::int AS last_30_days
       FROM messages
       WHERE client_id = $1`,
      [req.portalUser.client_id]
    );
    res.json({ stats: result.rows[0] });
  } catch (err) { next(err); }
});

// GET /api/portal/messages
router.get('/messages', requirePortalAuth, async (req, res, next) => {
  try {
    const { status, limit = 50, offset = 0 } = req.query;
    let query = `
      SELECT m.*, op.full_name AS operator_name
      FROM messages m
      LEFT JOIN operators op ON m.operator_id = op.id
      WHERE m.client_id = $1
    `;
    const params = [req.portalUser.client_id];
    if (status) { params.push(status); query += ` AND m.status = $${params.length}`; }
    params.push(parseInt(limit)); query += ` ORDER BY m.created_at DESC LIMIT $${params.length}`;
    params.push(parseInt(offset)); query += ` OFFSET $${params.length}`;

    const result = await pool.query(query, params);
    res.json({ messages: result.rows });
  } catch (err) { next(err); }
});

// POST /api/portal/messages — portal user submits an enquiry to operators
router.post('/messages', requirePortalAuth, async (req, res, next) => {
  try {
    const { subject, body, urgency = 'normal', form_data } = req.body;
    if (!body || body.trim().length < 3) {
      return res.status(400).json({ error: 'body is required (min 3 characters)' });
    }
    const validUrgency = ['low', 'normal', 'urgent'];
    if (!validUrgency.includes(urgency)) return res.status(400).json({ error: 'Invalid urgency' });

    const portalUser = req.portalUser;
    const result = await pool.query(
      `INSERT INTO messages
         (client_id, caller_name, caller_phone, subject, body, urgency, status, call_type, source, form_data)
       VALUES ($1,$2,$3,$4,$5,$6,'pending','portal_message','portal',$7)
       RETURNING id, subject, body, urgency, status, created_at`,
      [
        portalUser.client_id,
        portalUser.name || portalUser.email,
        null,
        subject || 'Portal enquiry',
        body.trim(),
        urgency,
        form_data ? JSON.stringify(form_data) : null,
      ]
    );
    const message = result.rows[0];

    // Real-time broadcast to operators
    const { broadcast } = require('../../services/realtime');
    broadcast('message:new', { messageId: message.id, clientId: portalUser.client_id, source: 'portal' });

    res.status(201).json({ message });
  } catch (err) { next(err); }
});

// POST /api/portal/messages/:id/acknowledge — portal user marks their message as read
router.post('/messages/:id/acknowledge', requirePortalAuth, async (req, res, next) => {
  try {
    const result = await pool.query(
      `UPDATE messages
       SET acknowledged_at = COALESCE(acknowledged_at, NOW()), status = 'acknowledged'
       WHERE id = $1 AND client_id = $2
       RETURNING id, acknowledged_at, status`,
      [req.params.id, req.portalUser.client_id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Message not found' });
    res.json({ message: result.rows[0] });
  } catch (err) { next(err); }
});

// GET /api/portal/calls
router.get('/calls', requirePortalAuth, async (req, res, next) => {
  try {
    const { days = 30 } = req.query;
    const [summaryResult, recentResult] = await Promise.all([
      pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE disposition = 'answered') AS answered,
           COUNT(*) FILTER (WHERE disposition = 'no_answer') AS missed,
           COUNT(*) AS total,
           ROUND(COALESCE(SUM(duration_seconds) FILTER (WHERE disposition = 'answered') / 60.0, 0), 1) AS total_minutes
         FROM call_logs
         WHERE client_id = $1 AND call_start >= NOW() - ($2 || ' days')::INTERVAL`,
        [req.portalUser.client_id, days]
      ),
      pool.query(
        `SELECT cl.*, op.full_name AS operator_name
         FROM call_logs cl
         LEFT JOIN operators op ON cl.operator_id = op.id
         WHERE cl.client_id = $1 ORDER BY cl.call_start DESC LIMIT 20`,
        [req.portalUser.client_id]
      ),
    ]);
    res.json({ summary: summaryResult.rows[0], recent: recentResult.rows });
  } catch (err) { next(err); }
});

// GET /api/portal/availability
router.get('/availability', requirePortalAuth, async (req, res, next) => {
  try {
    const result = await pool.query(
      'SELECT * FROM client_availability WHERE client_id = $1',
      [req.portalUser.client_id]
    );
    res.json({ availability: result.rows[0] || { status: 'available', note: null } });
  } catch (err) { next(err); }
});

// PUT /api/portal/availability
router.put('/availability', requirePortalAuth, async (req, res, next) => {
  try {
    const { status, note } = req.body;
    const VALID = ['available', 'out_of_office', 'annual_leave', 'meeting'];
    if (status && !VALID.includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }
    const result = await pool.query(
      `INSERT INTO client_availability (client_id, status, note, updated_at)
       VALUES ($1, COALESCE($2,'available'), $3, NOW())
       ON CONFLICT (client_id) DO UPDATE
         SET status = COALESCE($2, client_availability.status),
             note = $3, updated_at = NOW()
       RETURNING *`,
      [req.portalUser.client_id, status || null, note || null]
    );
    const avail = result.rows[0];
    broadcast('client:availability', { client_id: req.portalUser.client_id, availability: avail });
    res.json({ availability: avail });
  } catch (err) { next(err); }
});

// POST /api/portal/me/password — portal user self-service password change
router.post('/me/password', requirePortalAuth, async (req, res, next) => {
  try {
    const { current_password, new_password } = req.body;
    if (!current_password || !new_password) {
      return res.status(400).json({ error: 'current_password and new_password required' });
    }
    const pwErr = validatePassword(new_password);
    if (pwErr) return res.status(400).json({ error: pwErr });

    const result = await pool.query(
      'SELECT password_hash FROM client_portal_users WHERE id = $1 AND is_active = true',
      [req.portalUser.id]
    );
    if (!result.rows[0] || !(await bcrypt.compare(current_password, result.rows[0].password_hash))) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    const hash = await bcrypt.hash(new_password, 12);
    await pool.query('UPDATE client_portal_users SET password_hash = $1 WHERE id = $2', [hash, req.portalUser.id]);
    res.json({ message: 'Password updated' });
  } catch (err) { next(err); }
});

// POST /api/portal/password-reset/request — send reset link to portal user email
// Rate-limited by the same in-memory map used for login; no auth required.
router.post('/password-reset/request', rateLimitPortal, async (req, res, next) => {
  try {
    const { username } = req.body;
    if (!username) return res.status(400).json({ error: 'username required' });

    // Always return success to avoid user enumeration
    const result = await pool.query(
      'SELECT cpu.*, c.name AS client_name FROM client_portal_users cpu JOIN clients c ON cpu.client_id = c.id WHERE cpu.username = $1 AND cpu.is_active = true',
      [username]
    );
    const user = result.rows[0];

    if (user && user.email) {
      const rawToken = crypto.randomBytes(32).toString('hex');
      const tokenHash = await bcrypt.hash(rawToken, 10);

      await pool.query(
        `INSERT INTO portal_reset_tokens (portal_user_id, token_hash, expires_at)
         VALUES ($1, $2, NOW() + INTERVAL '24 hours')`,
        [user.id, tokenHash]
      );

      const appUrl = (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '');
      const resetUrl = `${appUrl}/portal.html?reset=${rawToken}&user=${encodeURIComponent(username)}`;

      try {
        const transporter = nodemailer.createTransport({
          host: process.env.SMTP_HOST,
          port: parseInt(process.env.SMTP_PORT || '587'),
          secure: process.env.SMTP_SECURE === 'true',
          auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD },
        });
        await transporter.sendMail({
          from: process.env.SMTP_FROM || process.env.SMTP_USER,
          to: user.email,
          subject: 'Portal password reset',
          text: `You requested a password reset for your ${user.client_name} portal account.\n\nClick the link below to set a new password (valid for 24 hours):\n\n${resetUrl}\n\nIf you did not request this, please ignore this email.`,
          html: `<p>You requested a password reset for your <strong>${user.client_name}</strong> portal account.</p><p><a href="${resetUrl}">Reset your password</a></p><p>This link expires in 24 hours. If you did not request this, please ignore this email.</p>`,
        });
      } catch (mailErr) {
        console.error('[Portal] Password reset email failed:', mailErr.message);
        // Don't expose mail errors to the caller
      }
    }

    res.json({ message: 'If that username exists with an email on file, a reset link has been sent.' });
  } catch (err) { next(err); }
});

// POST /api/portal/password-reset/confirm — validate token and set new password
router.post('/password-reset/confirm', async (req, res, next) => {
  try {
    const { username, token, new_password } = req.body;
    if (!username || !token || !new_password) {
      return res.status(400).json({ error: 'username, token, and new_password are required' });
    }
    const pwErr = validatePassword(new_password);
    if (pwErr) return res.status(400).json({ error: pwErr });

    const userResult = await pool.query(
      'SELECT id FROM client_portal_users WHERE username = $1 AND is_active = true',
      [username]
    );
    const user = userResult.rows[0];
    if (!user) return res.status(400).json({ error: 'Invalid or expired reset token' });

    const tokenResult = await pool.query(
      `SELECT id, token_hash FROM portal_reset_tokens
       WHERE portal_user_id = $1 AND used_at IS NULL AND expires_at > NOW()
       ORDER BY created_at DESC LIMIT 10`,
      [user.id]
    );

    let matchedTokenId = null;
    for (const row of tokenResult.rows) {
      if (await bcrypt.compare(token, row.token_hash)) {
        matchedTokenId = row.id;
        break;
      }
    }

    if (!matchedTokenId) {
      return res.status(400).json({ error: 'Invalid or expired reset token' });
    }

    const hash = await bcrypt.hash(new_password, 12);
    await Promise.all([
      pool.query('UPDATE client_portal_users SET password_hash = $1 WHERE id = $2', [hash, user.id]),
      pool.query('UPDATE portal_reset_tokens SET used_at = NOW() WHERE id = $1', [matchedTokenId]),
    ]);

    res.json({ message: 'Password has been reset. You can now log in.' });
  } catch (err) { next(err); }
});

// ── Portal self-service: on-call contacts ────────────────────────────────

// GET /api/portal/contacts — view on-call contacts for this client
router.get('/contacts', requirePortalAuth, async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id, name, role, phone, email, priority, notify_sms, notify_email,
              notify_phone, is_oncall, created_at
       FROM contacts
       WHERE client_id = $1
       ORDER BY priority ASC, name ASC`,
      [req.portalUser.client_id]
    );
    res.json({ contacts: result.rows });
  } catch (err) { next(err); }
});

// PUT /api/portal/contacts/:id — portal user can edit basic contact info + on-call flag
router.put('/contacts/:id', requirePortalAuth, async (req, res, next) => {
  try {
    const { name, phone, email, notify_sms, notify_email, notify_phone, is_oncall } = req.body;
    const result = await pool.query(
      `UPDATE contacts SET
         name         = COALESCE($1, name),
         phone        = COALESCE($2, phone),
         email        = COALESCE($3, email),
         notify_sms   = COALESCE($4, notify_sms),
         notify_email = COALESCE($5, notify_email),
         notify_phone = COALESCE($6, notify_phone),
         is_oncall    = COALESCE($7, is_oncall)
       WHERE id = $8 AND client_id = $9
       RETURNING id, name, role, phone, email, priority, notify_sms, notify_email,
                 notify_phone, is_oncall`,
      [name, phone, email, notify_sms, notify_email, notify_phone, is_oncall,
       req.params.id, req.portalUser.client_id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Contact not found' });
    res.json({ contact: result.rows[0] });
  } catch (err) { next(err); }
});

// ── Portal self-service: appointments ────────────────────────────────────

// GET /api/portal/appointments — view upcoming appointments for this client
router.get('/appointments', requirePortalAuth, async (req, res, next) => {
  try {
    const { from, to, status } = req.query;
    const params = [req.portalUser.client_id];
    let filter = '';
    if (from)   { params.push(from);   filter += ` AND a.starts_at >= $${params.length}`; }
    if (to)     { params.push(to);     filter += ` AND a.starts_at <= $${params.length}`; }
    if (status) { params.push(status); filter += ` AND a.status = $${params.length}`; }

    const result = await pool.query(
      `SELECT a.*, op.full_name AS operator_name
       FROM appointments a
       LEFT JOIN operators op ON a.operator_id = op.id
       WHERE a.client_id = $1 ${filter}
       ORDER BY a.starts_at ASC
       LIMIT 100`,
      params
    );
    res.json({ appointments: result.rows });
  } catch (err) { next(err); }
});

// POST /api/portal/appointments — client books an appointment
router.post('/appointments', requirePortalAuth, async (req, res, next) => {
  try {
    const { title, caller_name, caller_phone, starts_at, duration_minutes = 30, notes } = req.body;
    if (!title || !starts_at) {
      return res.status(400).json({ error: 'title and starts_at are required' });
    }
    const result = await pool.query(
      `INSERT INTO appointments
         (client_id, title, caller_name, caller_phone, starts_at, duration_minutes, notes, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'scheduled')
       RETURNING *`,
      [req.portalUser.client_id, title, caller_name || null, caller_phone || null,
       starts_at, duration_minutes, notes || null]
    );
    res.status(201).json({ appointment: result.rows[0] });
  } catch (err) { next(err); }
});

// ── Portal self-service: knowledge base ──────────────────────────────────

// DELETE /api/portal/appointments/:id — cancel a portal-booked appointment
router.delete('/appointments/:id', requirePortalAuth, async (req, res, next) => {
  try {
    const result = await pool.query(
      `UPDATE appointments SET status = 'cancelled'
       WHERE id = $1 AND client_id = $2 AND status NOT IN ('cancelled','completed')
       RETURNING id, status`,
      [req.params.id, req.portalUser.client_id]
    );
    if (!result.rows.length) {
      return res.status(404).json({ error: 'Appointment not found or already cancelled' });
    }
    const { broadcast } = require('../../services/realtime');
    broadcast('appointment:updated', { appointment: result.rows[0] });
    res.json({ appointment: result.rows[0] });
  } catch (err) { next(err); }
});

// GET /api/portal/knowledge — browse client-specific knowledge articles
router.get('/knowledge', requirePortalAuth, async (req, res, next) => {
  try {
    const { q, category } = req.query;
    const params = [req.portalUser.client_id];
    let filter = '';
    if (q) {
      params.push(q);
      filter += ` AND (ka.title ILIKE '%' || $${params.length} || '%'
                    OR ka.content ILIKE '%' || $${params.length} || '%')`;
    }
    if (category) { params.push(category); filter += ` AND ka.category = $${params.length}`; }

    const result = await pool.query(
      `SELECT ka.id, ka.title, ka.category, ka.tags, ka.is_public, ka.created_at, ka.updated_at
       FROM knowledge_articles ka
       WHERE (ka.client_id = $1 OR ka.client_id IS NULL) AND ka.is_public = true
       ${filter}
       ORDER BY ka.category, ka.title
       LIMIT 100`,
      params
    );
    res.json({ articles: result.rows });
  } catch (err) { next(err); }
});

// GET /api/portal/knowledge/:id — read article body
router.get('/knowledge/:id', requirePortalAuth, async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT * FROM knowledge_articles
       WHERE id = $1 AND (client_id = $2 OR client_id IS NULL) AND is_public = true`,
      [req.params.id, req.portalUser.client_id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Article not found' });
    res.json({ article: result.rows[0] });
  } catch (err) { next(err); }
});

// ---- Portal user management (requires operator JWT, not portal JWT) ----
const { requireAuth, requireRole } = require('../middleware/auth');

// GET /api/portal/clients/:clientId/users
router.get('/clients/:clientId/users', requireAuth, requireRole('admin', 'supervisor'), async (req, res, next) => {
  try {
    const result = await pool.query(
      'SELECT id, username, email, is_active, created_at FROM client_portal_users WHERE client_id = $1 ORDER BY username',
      [req.params.clientId]
    );
    res.json({ users: result.rows });
  } catch (err) { next(err); }
});

// POST /api/portal/clients/:clientId/users
router.post('/clients/:clientId/users', requireAuth, requireRole('admin', 'supervisor'), async (req, res, next) => {
  try {
    const { username, password, email } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'username and password required' });
    const pwErr = validatePassword(password);
    if (pwErr) return res.status(400).json({ error: pwErr });
    const hash = await bcrypt.hash(password, 12);
    const result = await pool.query(
      `INSERT INTO client_portal_users (client_id, username, password_hash, email)
       VALUES ($1,$2,$3,$4) RETURNING id, username, email, is_active, created_at`,
      [req.params.clientId, username, hash, email || null]
    );
    res.status(201).json({ user: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Username already exists' });
    next(err);
  }
});

// PUT /api/portal/clients/:clientId/users/:userId
router.put('/clients/:clientId/users/:userId', requireAuth, requireRole('admin', 'supervisor'), async (req, res, next) => {
  try {
    const { email, is_active, password } = req.body;
    let hash;
    if (password) {
      const pwErr = validatePassword(password);
      if (pwErr) return res.status(400).json({ error: pwErr });
      hash = await bcrypt.hash(password, 12);
    }
    const result = await pool.query(
      `UPDATE client_portal_users SET
         email = COALESCE($1, email),
         is_active = COALESCE($2, is_active),
         password_hash = COALESCE($3, password_hash)
       WHERE id = $4 AND client_id = $5
       RETURNING id, username, email, is_active`,
      [email, is_active, hash, req.params.userId, req.params.clientId]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'User not found' });
    res.json({ user: result.rows[0] });
  } catch (err) { next(err); }
});

// DELETE /api/portal/clients/:clientId/users/:userId
router.delete('/clients/:clientId/users/:userId', requireAuth, requireRole('admin'), async (req, res, next) => {
  try {
    await pool.query('DELETE FROM client_portal_users WHERE id = $1 AND client_id = $2',
      [req.params.userId, req.params.clientId]);
    res.json({ message: 'User deleted' });
  } catch (err) { next(err); }
});

// GET /api/portal/appointments/ical — iCal feed for the portal user's client
router.get('/appointments/ical', requirePortalAuth, async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT a.*, c.name AS client_name
       FROM appointments a LEFT JOIN clients c ON a.client_id = c.id
       WHERE a.client_id = $1 AND a.appointment_at >= NOW() - INTERVAL '30 days'
       ORDER BY a.appointment_at ASC LIMIT 500`,
      [req.portalUser.client_id]
    );
    const stamp = fmtIcs(new Date());
    const events = result.rows.map(a => {
      const start = a.appointment_at ? fmtIcs(new Date(a.appointment_at)) : stamp;
      const end   = a.appointment_at
        ? fmtIcs(new Date(new Date(a.appointment_at).getTime() + (a.duration_minutes || 30) * 60000))
        : stamp;
      return [
        'BEGIN:VEVENT',
        `UID:${a.id}@answering-service`,
        `DTSTAMP:${stamp}`,
        `DTSTART:${start}`,
        `DTEND:${end}`,
        `SUMMARY:${escIcs((a.service_type || 'Appointment') + (a.client_name ? ` — ${a.client_name}` : ''))}`,
        a.caller_name  ? `ORGANIZER;CN=${escIcs(a.caller_name)}:mailto:noreply@answering-service` : '',
        a.notes        ? `DESCRIPTION:${escIcs(a.notes)}` : '',
        `STATUS:${a.status === 'confirmed' ? 'CONFIRMED' : a.status === 'cancelled' ? 'CANCELLED' : 'TENTATIVE'}`,
        'END:VEVENT',
      ].filter(Boolean).join('\r\n');
    });
    const ics = ['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//SinglePoint Calls//Answering Service//EN',
      'CALSCALE:GREGORIAN','METHOD:PUBLISH',...events,'END:VCALENDAR'].join('\r\n');
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="appointments.ics"');
    res.send(ics);
  } catch (err) { next(err); }
});

// GET /api/portal/files — list files shared with this client
router.get('/files', requirePortalAuth, async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT cf.id, cf.original_name, cf.mime_type, cf.size_bytes, cf.description, cf.created_at,
              o.full_name AS uploaded_by_name
       FROM client_files cf
       LEFT JOIN operators o ON cf.uploaded_by = o.id
       WHERE cf.client_id = $1
       ORDER BY cf.created_at DESC`,
      [req.portalUser.client_id]
    );
    res.json({ files: result.rows });
  } catch (err) { next(err); }
});

// GET /api/portal/files/:fileId/download — download a file (client-scoped)
router.get('/files/:fileId/download', requirePortalAuth, async (req, res, next) => {
  try {
    const result = await pool.query(
      'SELECT * FROM client_files WHERE id = $1 AND client_id = $2',
      [req.params.fileId, req.portalUser.client_id]
    );
    const file = result.rows[0];
    if (!file) return res.status(404).json({ error: 'File not found' });

    const filePath = path.resolve(UPLOAD_DIR, path.basename(file.filename));
    if (!filePath.startsWith(path.resolve(UPLOAD_DIR))) {
      return res.status(400).json({ error: 'Invalid file path' });
    }
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File missing from disk' });

    res.download(filePath, file.original_name);
  } catch (err) { next(err); }
});

// GET /api/portal/data-export — GDPR Subject Access Request: download all data for this client
router.get('/data-export', requirePortalAuth, async (req, res, next) => {
  try {
    const clientId = req.portalUser.client_id;
    const [client, contacts, messages, calls, appointments] = await Promise.all([
      pool.query('SELECT id,name,account_number,timezone,is_active,created_at FROM clients WHERE id=$1', [clientId]),
      pool.query('SELECT id,name,email,phone,mobile,role,priority,created_at FROM contacts WHERE client_id=$1', [clientId]),
      pool.query('SELECT id,caller_name,caller_phone,caller_company,subject,body,urgency,status,created_at FROM messages WHERE client_id=$1 ORDER BY created_at DESC LIMIT 1000', [clientId]),
      pool.query('SELECT id,caller_id_num,caller_id_name,did,call_start,call_end,duration_seconds,disposition FROM call_logs WHERE client_id=$1 ORDER BY call_start DESC LIMIT 1000', [clientId]),
      pool.query('SELECT id,caller_name,caller_phone,caller_email,appointment_at,service_type,status,notes FROM appointments WHERE client_id=$1 ORDER BY appointment_at DESC LIMIT 500', [clientId]),
    ]);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="data-export.json"');
    res.json({
      exported_at: new Date().toISOString(),
      client: client.rows[0] || null,
      contacts: contacts.rows,
      messages: messages.rows,
      call_logs: calls.rows,
      appointments: appointments.rows,
    });
  } catch (err) { next(err); }
});

function fmtIcs(d) {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}
function escIcs(s) {
  return String(s).replace(/[\\,;]/g, c => '\\' + c).replace(/\n/g, '\\n');
}

module.exports = router;
