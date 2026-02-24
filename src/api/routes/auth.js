'use strict';

const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const speakeasy = require('speakeasy');
const QRCode = require('qrcode');
const pool = require('../../config/database');
const { requireAuth } = require('../middleware/auth');

/* ---- Password strength validator ---- */
function validatePassword(password) {
  if (!password || password.length < 12) return 'Password must be at least 12 characters';
  if (!/[A-Z]/.test(password)) return 'Password must include an uppercase letter';
  if (!/[a-z]/.test(password)) return 'Password must include a lowercase letter';
  if (!/[0-9]/.test(password)) return 'Password must include a number';
  if (!/[^A-Za-z0-9]/.test(password)) return 'Password must include a special character';
  return null;
}

// POST /api/auth/login
router.post('/login', async (req, res, next) => {
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

    if (!operator || !(await bcrypt.compare(password, operator.password_hash))) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // If 2FA is enabled, return a short-lived partial token
    if (operator.totp_enabled && operator.totp_secret) {
      const tempToken = jwt.sign(
        { id: operator.id, phase: '2fa' },
        process.env.JWT_SECRET,
        { expiresIn: '5m' }
      );
      return res.json({ requires_2fa: true, temp_token: tempToken });
    }

    const token = jwt.sign(
      { id: operator.id, username: operator.username, role: operator.role },
      process.env.JWT_SECRET,
      { expiresIn: '12h' }
    );

    res.json({
      token,
      operator: {
        id: operator.id,
        username: operator.username,
        fullName: operator.full_name,
        email: operator.email,
        role: operator.role,
        totp_enabled: operator.totp_enabled,
      },
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/verify-2fa
router.post('/verify-2fa', async (req, res, next) => {
  try {
    const { temp_token, totp_code } = req.body;
    if (!temp_token || !totp_code) {
      return res.status(400).json({ error: 'temp_token and totp_code required' });
    }

    let payload;
    try {
      payload = jwt.verify(temp_token, process.env.JWT_SECRET);
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

    const token = jwt.sign(
      { id: operator.id, username: operator.username, role: operator.role },
      process.env.JWT_SECRET,
      { expiresIn: '12h' }
    );

    res.json({
      token,
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

module.exports = { router, validatePassword };
