'use strict';

const router = require('express').Router();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const speakeasy = require('speakeasy');
const QRCode = require('qrcode');
const pool = require('../../config/database');
const { requireAuth } = require('../middleware/auth');
const audit = require('../../services/audit');
const nodemailer = require('nodemailer');

/* ---- Simple in-memory rate limiter for auth endpoints ---- */
const loginAttempts = new Map();
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const MAX_ATTEMPTS = 10;

function rateLimitAuth(req, res, next) {
  const key = req.ip + ':' + (req.body?.username || '');
  const now = Date.now();
  const entry = loginAttempts.get(key);

  if (entry) {
    // Clean expired entries
    if (now - entry.firstAttempt > RATE_LIMIT_WINDOW_MS) {
      loginAttempts.set(key, { count: 1, firstAttempt: now });
      return next();
    }
    if (entry.count >= MAX_ATTEMPTS) {
      const retryAfter = Math.ceil((entry.firstAttempt + RATE_LIMIT_WINDOW_MS - now) / 1000);
      res.setHeader('Retry-After', retryAfter);
      return res.status(429).json({ error: 'Too many login attempts. Please try again later.' });
    }
    entry.count++;
  } else {
    loginAttempts.set(key, { count: 1, firstAttempt: now });
  }

  // Periodic cleanup — every 100 requests, purge expired entries
  if (loginAttempts.size > 1000) {
    for (const [k, v] of loginAttempts) {
      if (now - v.firstAttempt > RATE_LIMIT_WINDOW_MS) loginAttempts.delete(k);
    }
  }

  next();
}

/* ---- Password strength validator ---- */
function validatePassword(password) {
  if (!password || password.length < 12) return 'Password must be at least 12 characters';
  if (!/[A-Z]/.test(password)) return 'Password must include an uppercase letter';
  if (!/[a-z]/.test(password)) return 'Password must include a lowercase letter';
  if (!/[0-9]/.test(password)) return 'Password must include a number';
  if (!/[^A-Za-z0-9]/.test(password)) return 'Password must include a special character';
  return null;
}

/** Read token lifetime from system settings (cached 60 s). Default: 2 h. */
let _tokenLifetimeCache = { value: 2, ts: 0 };
async function getTokenLifetimeHours() {
  if (Date.now() - _tokenLifetimeCache.ts < 60000) return _tokenLifetimeCache.value;
  try {
    const r = await pool.query("SELECT value FROM system_settings WHERE key = 'token_lifetime_hours'");
    const h = parseInt(r.rows[0]?.value, 10);
    _tokenLifetimeCache = { value: (h >= 1 && h <= 24) ? h : 2, ts: Date.now() };
  } catch { /* keep cached value */ }
  return _tokenLifetimeCache.value;
}

/** Check whether 2FA is required globally (system_settings.require_2fa). */
let _require2faCache = { value: false, ts: 0 };
async function isGlobal2FARequired() {
  if (Date.now() - _require2faCache.ts < 60000) return _require2faCache.value;
  try {
    const r = await pool.query("SELECT value FROM system_settings WHERE key = 'require_2fa'");
    _require2faCache = { value: r.rows[0]?.value === 'true', ts: Date.now() };
  } catch { /* keep cached */ }
  return _require2faCache.value;
}

function signOperatorToken(op, lifetimeHours) {
  return jwt.sign(
    { id: op.id, username: op.username, role: op.role },
    process.env.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: `${lifetimeHours}h` }
  );
}

// POST /api/auth/login
router.post('/login', rateLimitAuth, async (req, res, next) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }

    const result = await pool.query(
      'SELECT * FROM operators WHERE username = $1 AND is_active = true',
      [username]
    );
    const operator = result.rows[0];

    // Always run bcrypt even for unknown users (constant-time; prevents timing enumeration)
    const dummyHash = '$2a$12$notarealthashXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
    const pwOk = await bcrypt.compare(password, operator?.password_hash || dummyHash);
    if (!operator || !pwOk) {
      audit.log(req, 'operator.login_failed', {
        resourceType: 'operator',
        details: { username, reason: 'invalid_credentials' },
        actorName: username,
      });
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const require2fa = await isGlobal2FARequired();
    if (require2fa && !operator.totp_enabled) {
      return res.status(403).json({
        error: '2FA is required for all operators. Contact your administrator to set up an authenticator app.',
        requires_2fa_setup: true,
      });
    }

    // 2FA second step
    if (operator.totp_enabled && operator.totp_secret) {
      const tempToken = jwt.sign(
        { id: operator.id, phase: '2fa' },
        process.env.JWT_SECRET,
        { algorithm: 'HS256', expiresIn: '5m' }
      );
      return res.json({ requires_2fa: true, temp_token: tempToken });
    }

    const lifetimeHours = await getTokenLifetimeHours();
    const token = signOperatorToken(operator, lifetimeHours);

    req.operator = operator; // set for audit logging
    audit.log(req, 'operator.login', {
      resourceType: 'operator', resourceId: String(operator.id),
    });

    res.json({
      token,
      expiresInHours: lifetimeHours,
      operator: {
        id: operator.id, username: operator.username,
        fullName: operator.full_name, email: operator.email,
        role: operator.role, totp_enabled: operator.totp_enabled,
      },
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/verify-2fa
router.post('/verify-2fa', rateLimitAuth, async (req, res, next) => {
  try {
    const { temp_token, totp_code } = req.body;
    if (!temp_token || !totp_code) {
      return res.status(400).json({ error: 'temp_token and totp_code required' });
    }

    let payload;
    try {
      payload = jwt.verify(temp_token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    } catch {
      return res.status(401).json({ error: 'Invalid or expired verification token' });
    }
    if (payload.phase !== '2fa') {
      return res.status(400).json({ error: 'Invalid token phase' });
    }

    const result = await pool.query(
      'SELECT * FROM operators WHERE id = $1 AND is_active = true',
      [payload.id]
    );
    const operator = result.rows[0];
    if (!operator || !operator.totp_secret) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const valid = speakeasy.totp.verify({
      secret: operator.totp_secret,
      encoding: 'base32',
      token: totp_code,
      window: 1,
    });

    if (!valid) {
      return res.status(401).json({ error: 'Invalid authentication code' });
    }

    const lifetimeHours = await getTokenLifetimeHours();
    const token = signOperatorToken(operator, lifetimeHours);

    req.operator = operator; // set for audit logging
    audit.log(req, 'operator.login', {
      resourceType: 'operator', resourceId: String(operator.id),
      details: { via: '2fa' },
    });

    res.json({
      token,
      expiresInHours: lifetimeHours,
      operator: {
        id: operator.id,
        username: operator.username,
        fullName: operator.full_name,
        email: operator.email,
        role: operator.role,
        totp_enabled: true,
      },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/auth/me
router.get('/me', requireAuth, (req, res) => {
  res.json({ operator: req.operator });
});

// POST /api/auth/refresh — silently extend an expiring token (no credential re-entry)
// Call this when the client detects the token is within ~5 min of expiry.
router.post('/refresh', requireAuth, async (req, res, next) => {
  try {
    // Re-check DB to ensure account is still active (catches deactivated accounts)
    const result = await pool.query(
      'SELECT id, username, role FROM operators WHERE id = $1 AND is_active = true',
      [req.operator.id]
    );
    if (!result.rows[0]) return res.status(401).json({ error: 'Account is inactive' });

    const lifetimeHours = await getTokenLifetimeHours();
    const token = signOperatorToken(result.rows[0], lifetimeHours);
    res.json({ token, expiresInHours: lifetimeHours });
  } catch (err) { next(err); }
});

// GET /api/auth/2fa/setup — generate TOTP secret + QR code for current user
router.get('/2fa/setup', requireAuth, async (req, res, next) => {
  try {
    const secret = speakeasy.generateSecret({
      name: `SinglePoint Calls (${req.operator.username})`,
      length: 32,
    });

    // Temporarily store the pending secret (not yet confirmed)
    await pool.query(
      'UPDATE operators SET totp_secret = $1, totp_enabled = false WHERE id = $2',
      [secret.base32, req.operator.id]
    );

    const qrDataUrl = await QRCode.toDataURL(secret.otpauth_url);

    res.json({
      secret: secret.base32,
      otpauth_url: secret.otpauth_url,
      qr_code: qrDataUrl,
    });
  } catch (err) { next(err); }
});

// POST /api/auth/2fa/confirm — verify TOTP code and enable 2FA
router.post('/2fa/confirm', requireAuth, async (req, res, next) => {
  try {
    const { totp_code } = req.body;
    if (!totp_code) return res.status(400).json({ error: 'totp_code required' });

    const result = await pool.query('SELECT totp_secret FROM operators WHERE id = $1', [req.operator.id]);
    const secret = result.rows[0]?.totp_secret;
    if (!secret) return res.status(400).json({ error: '2FA setup not started. Call GET /api/auth/2fa/setup first.' });

    const valid = speakeasy.totp.verify({ secret, encoding: 'base32', token: totp_code, window: 1 });
    if (!valid) return res.status(400).json({ error: 'Invalid code. Please try again.' });

    await pool.query('UPDATE operators SET totp_enabled = true WHERE id = $1', [req.operator.id]);
    res.json({ message: '2FA enabled successfully' });
  } catch (err) { next(err); }
});

// DELETE /api/auth/2fa — disable 2FA for current user (requires password)
router.delete('/2fa', requireAuth, async (req, res, next) => {
  try {
    const { password } = req.body;
    if (!password) return res.status(400).json({ error: 'password required to disable 2FA' });

    const result = await pool.query('SELECT password_hash FROM operators WHERE id = $1', [req.operator.id]);
    if (!(await bcrypt.compare(password, result.rows[0]?.password_hash))) {
      return res.status(401).json({ error: 'Incorrect password' });
    }

    await pool.query('UPDATE operators SET totp_secret = NULL, totp_enabled = false WHERE id = $1', [req.operator.id]);
    res.json({ message: '2FA disabled' });
  } catch (err) { next(err); }
});

// POST /api/auth/forgot-password — request operator password reset email
router.post('/forgot-password', rateLimitAuth, async (req, res, next) => {
  try {
    const { username } = req.body;
    // Always return the same response to prevent username enumeration
    const ok = () => res.json({ message: 'If that username exists with an email on file, a reset link has been sent.' });

    if (!username) return ok();

    const result = await pool.query(
      'SELECT id, email, full_name FROM operators WHERE username = $1 AND is_active = true',
      [username]
    );
    const op = result.rows[0];
    if (!op || !op.email) return ok();

    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await pool.query(
      'INSERT INTO operator_reset_tokens (operator_id, token_hash, expires_at) VALUES ($1, $2, $3)',
      [op.id, tokenHash, expiresAt]
    );

    const appUrl = (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '');
    const resetUrl = `${appUrl}/index.html?reset=${rawToken}&user=${encodeURIComponent(username)}`;

    try {
      const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST, port: parseInt(process.env.SMTP_PORT || '587'),
        secure: false,
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      });
      await transporter.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to: op.email,
        subject: 'Password reset — SinglePoint Calls',
        text: `Hi ${op.full_name || username},\n\nClick the link below to reset your password (valid 24 hours):\n\n${resetUrl}\n\nIf you did not request this, please ignore this email.`,
        html: `<p>Hi ${op.full_name || username},</p><p><a href="${resetUrl}">Reset your password</a></p><p>This link expires in 24 hours.</p>`,
      });
    } catch (mailErr) {
      console.error('[Auth] Password reset email failed:', mailErr.message);
    }

    ok();
  } catch (err) { next(err); }
});

// POST /api/auth/reset-password — validate token and set new password
router.post('/reset-password', async (req, res, next) => {
  try {
    const { username, token, new_password } = req.body;
    if (!username || !token || !new_password) {
      return res.status(400).json({ error: 'username, token, and new_password are required' });
    }

    const pwErr = validatePassword(new_password);
    if (pwErr) return res.status(400).json({ error: pwErr });

    const opResult = await pool.query(
      'SELECT id FROM operators WHERE username = $1 AND is_active = true', [username]
    );
    if (!opResult.rows[0]) return res.status(400).json({ error: 'Invalid or expired reset token' });
    const operatorId = opResult.rows[0].id;

    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const tokResult = await pool.query(
      `SELECT id FROM operator_reset_tokens
       WHERE operator_id = $1 AND token_hash = $2
         AND expires_at > NOW() AND used_at IS NULL`,
      [operatorId, tokenHash]
    );
    if (!tokResult.rows[0]) return res.status(400).json({ error: 'Invalid or expired reset token' });

    const passwordHash = await bcrypt.hash(new_password, 12);
    await Promise.all([
      pool.query('UPDATE operators SET password_hash = $1 WHERE id = $2', [passwordHash, operatorId]),
      pool.query('UPDATE operator_reset_tokens SET used_at = NOW() WHERE id = $1', [tokResult.rows[0].id]),
    ]);

    res.json({ message: 'Password has been reset. You can now log in.' });
  } catch (err) { next(err); }
});

module.exports = { router, validatePassword };
