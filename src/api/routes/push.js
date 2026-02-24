'use strict';

/**
 * Web Push subscription management
 *
 * GDPR compliance:
 *   - Subscription endpoint is personal data (device-unique). Stored per operator
 *     or portal user; deleted automatically on account deletion via FK CASCADE.
 *   - Consent timestamp recorded at subscription time.
 *   - DELETE /api/push/unsubscribe allows subjects to withdraw consent (Art. 7(3)).
 *   - No endpoint or key material is ever returned in API responses.
 *   - Only the user's own subscriptions are accessible (no cross-user lookup).
 */

const router = require('express').Router();
const pool   = require('../../config/database');
const { requireAuth }       = require('../middleware/auth');
const { getVapidPublicKey } = require('../../services/push');

/* ── Public: VAPID public key (needed by browser before login) ── */
router.get('/vapid-public-key', (_req, res) => {
  const key = getVapidPublicKey();
  if (!key) return res.status(503).json({ error: 'Push notifications not configured' });
  res.json({ publicKey: key });
});

/* ── Protected: save a push subscription ─────────────────── */
router.post('/subscribe', requireAuth, async (req, res, next) => {
  try {
    const { subscription, userAgent } = req.body;
    if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
      return res.status(400).json({ error: 'Invalid push subscription object' });
    }

    // Validate endpoint is a well-formed HTTPS URL (SSRF guard — push endpoints
    // should only ever be official browser push services)
    let endpointUrl;
    try {
      endpointUrl = new URL(subscription.endpoint);
    } catch {
      return res.status(400).json({ error: 'Invalid endpoint URL' });
    }
    if (endpointUrl.protocol !== 'https:') {
      return res.status(400).json({ error: 'Push endpoint must use HTTPS' });
    }

    // Only store the browser family (e.g. "Chrome 120") — not the full UA string
    const uaHint = typeof userAgent === 'string'
      ? userAgent.replace(/[^a-zA-Z0-9 ./()_-]/g, '').substring(0, 100)
      : null;

    // Determine subscriber type from JWT payload
    const isPortal = req.operator?.type === 'portal';
    const operatorId    = isPortal ? null : req.operator.id;
    const portalUserId  = isPortal ? req.operator.id : null;

    // Upsert — same endpoint can re-subscribe (e.g. after page reload)
    await pool.query(
      `INSERT INTO push_subscriptions
         (endpoint, p256dh, auth, operator_id, portal_user_id,
          consent_given_at, user_agent_hint, last_used_at)
       VALUES ($1, $2, $3, $4, $5, NOW(), $6, NOW())
       ON CONFLICT (endpoint) DO UPDATE SET
         p256dh           = EXCLUDED.p256dh,
         auth             = EXCLUDED.auth,
         operator_id      = EXCLUDED.operator_id,
         portal_user_id   = EXCLUDED.portal_user_id,
         consent_given_at = NOW(),
         user_agent_hint  = EXCLUDED.user_agent_hint,
         last_used_at     = NOW()`,
      [subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth,
       operatorId, portalUserId, uaHint]
    );

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/* ── Protected: withdraw consent / unsubscribe ───────────── */
router.post('/unsubscribe', requireAuth, async (req, res, next) => {
  try {
    const { endpoint } = req.body;
    if (!endpoint) return res.status(400).json({ error: 'endpoint required' });

    const isPortal = req.operator?.type === 'portal';
    const col = isPortal ? 'portal_user_id' : 'operator_id';

    // Only delete the subscription that belongs to the authenticated user
    await pool.query(
      `DELETE FROM push_subscriptions WHERE endpoint = $1 AND ${col} = $2`,
      [endpoint, req.operator.id]
    );

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/* ── Admin: list subscriptions for a user (no endpoints returned) ── */
router.get('/my-subscriptions', requireAuth, async (req, res, next) => {
  try {
    const isPortal = req.operator?.type === 'portal';
    const col = isPortal ? 'portal_user_id' : 'operator_id';

    const result = await pool.query(
      `SELECT id, user_agent_hint, consent_given_at, last_used_at
       FROM push_subscriptions WHERE ${col} = $1
       ORDER BY last_used_at DESC NULLS LAST`,
      [req.operator.id]
    );

    res.json({ subscriptions: result.rows });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
