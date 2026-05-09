'use strict';

/**
 * Portal API key management.
 *
 * Two layers of routes:
 *   - /api/portal/api-keys/*  — managed by portal users (JWT-authed)
 *   - exported requireApiKey middleware — validates Bearer tokens for other routes
 *
 * Key format on issue: `spcalls_live_<32 base64url chars>` (returned ONCE).
 * Stored: bcrypt hash of plaintext.  Comparison: bcrypt.compare(presented, hash).
 */

const router = require('express').Router();
const pool = require('../../config/database');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

// ── Portal JWT auth (mirrors portal.js inline middleware) ──────────────────
function requirePortalAuth(req, res, next) {
  try {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const decoded = jwt.verify(token, process.env.PORTAL_JWT_SECRET || process.env.JWT_SECRET, { algorithms: ['HS256'] });
    if (decoded.type !== 'portal') return res.status(401).json({ error: 'Invalid token type' });
    req.portalUser = decoded;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or missing token' });
  }
}

const VALID_SCOPES = ['messages:read', 'messages:write', 'appointments:read', 'appointments:write', 'contacts:read'];

// Generate a secure key
function generateKey() {
  const raw = crypto.randomBytes(24).toString('base64url'); // 32 chars
  return `spcalls_live_${raw}`;
}

// GET /api/portal/api-keys — list current user's keys (no plaintext)
router.get('/', requirePortalAuth, async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id, name, key_prefix, scopes, last_used_at, expires_at, revoked_at, created_at
       FROM portal_api_keys
       WHERE portal_user_id = $1
       ORDER BY created_at DESC`,
      [req.portalUser.id]
    );
    res.json({ keys: result.rows });
  } catch (err) { next(err); }
});

// POST /api/portal/api-keys — issue a new key
router.post('/', requirePortalAuth, async (req, res, next) => {
  try {
    const { name, scopes = ['messages:read'], expires_in_days } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });

    const invalidScopes = scopes.filter((s) => !VALID_SCOPES.includes(s));
    if (invalidScopes.length) {
      return res.status(400).json({ error: `Invalid scopes: ${invalidScopes.join(', ')}` });
    }

    const plaintext = generateKey();
    const hash = await bcrypt.hash(plaintext, 10);
    const prefix = plaintext.slice(0, 18); // spcalls_live_xxxxx

    const expiresAt = expires_in_days ? new Date(Date.now() + expires_in_days * 86400 * 1000) : null;

    const result = await pool.query(
      `INSERT INTO portal_api_keys (portal_user_id, name, key_hash, key_prefix, scopes, expires_at)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6)
       RETURNING id, name, key_prefix, scopes, expires_at, created_at`,
      [req.portalUser.id, name, hash, prefix, JSON.stringify(scopes), expiresAt]
    );

    res.status(201).json({
      key: plaintext,
      info: result.rows[0],
      warning: 'Store this key now — it cannot be retrieved later.',
    });
  } catch (err) { next(err); }
});

// DELETE /api/portal/api-keys/:id — revoke
router.delete('/:id', requirePortalAuth, async (req, res, next) => {
  try {
    const result = await pool.query(
      `UPDATE portal_api_keys SET revoked_at = NOW()
       WHERE id = $1 AND portal_user_id = $2 AND revoked_at IS NULL
       RETURNING id`,
      [req.params.id, req.portalUser.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Key not found or already revoked' });
    res.json({ message: 'Key revoked' });
  } catch (err) { next(err); }
});

// ── Exported middleware for use by other routes ───────────────────────────
async function requireApiKey(requiredScope) {
  return async (req, res, next) => {
    try {
      const auth = req.headers.authorization || '';
      if (!auth.startsWith('Bearer spcalls_')) {
        return res.status(401).json({ error: 'API key required' });
      }
      const presented = auth.replace(/^Bearer\s+/i, '');
      const prefix = presented.slice(0, 18);

      const candidates = await pool.query(
        `SELECT k.*, u.client_id, u.email
         FROM portal_api_keys k
         JOIN client_portal_users u ON k.portal_user_id = u.id
         WHERE k.key_prefix = $1 AND k.revoked_at IS NULL
           AND (k.expires_at IS NULL OR k.expires_at > NOW())`,
        [prefix]
      );

      let matched = null;
      for (const cand of candidates.rows) {
        if (await bcrypt.compare(presented, cand.key_hash)) { matched = cand; break; }
      }
      if (!matched) return res.status(401).json({ error: 'Invalid API key' });

      const scopes = matched.scopes || [];
      if (requiredScope && !scopes.includes(requiredScope)) {
        return res.status(403).json({ error: `Missing scope: ${requiredScope}` });
      }

      // Update last_used (fire-and-forget)
      pool.query('UPDATE portal_api_keys SET last_used_at = NOW() WHERE id = $1', [matched.id]).catch(() => {});

      req.apiKey = { id: matched.id, scopes, client_id: matched.client_id, portal_user_id: matched.portal_user_id };
      next();
    } catch (err) { next(err); }
  };
}

router.requireApiKey = requireApiKey;
module.exports = router;
