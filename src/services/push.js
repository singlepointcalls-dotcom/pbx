'use strict';

/**
 * Web Push service — wraps the web-push library.
 *
 * VAPID keys must be generated once and stored in env vars:
 *   VAPID_PUBLIC_KEY   Base64url-encoded 65-byte uncompressed EC public key
 *   VAPID_PRIVATE_KEY  Base64url-encoded 32-byte EC private key
 *   VAPID_SUBJECT      mailto: or https: contact for push service
 *
 * Generate once with:
 *   node -e "const wp=require('web-push'); const k=wp.generateVAPIDKeys();
 *             console.log('PUBLIC:',k.publicKey);
 *             console.log('PRIVATE:',k.privateKey);"
 */

const webpush = require('web-push');
const pool    = require('../config/database');

let vapidConfigured = false;

function init() {
  const pub  = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  const subj = process.env.VAPID_SUBJECT || 'mailto:admin@singlepointcalls.co.uk';

  if (!pub || !priv) {
    console.warn('[Push] VAPID keys not set — Web Push disabled. ' +
      'Set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY in .env to enable push notifications.');
    return;
  }

  webpush.setVapidDetails(subj, pub, priv);
  vapidConfigured = true;
  console.log('[Push] Web Push configured');
}

function getVapidPublicKey() {
  return process.env.VAPID_PUBLIC_KEY || null;
}

/**
 * Send a push notification to all subscriptions belonging to a given operator
 * or portal user.
 *
 * @param {'operator'|'portal'} subscriberType
 * @param {string} subscriberId  UUID
 * @param {{ title, body, url, tag, requireInteraction }} payload
 */
async function sendPush(subscriberType, subscriberId, payload) {
  if (!vapidConfigured) return;

  const col = subscriberType === 'portal' ? 'portal_user_id' : 'operator_id';

  let rows;
  try {
    const result = await pool.query(
      `SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE ${col} = $1`,
      [subscriberId]
    );
    rows = result.rows;
  } catch (err) {
    console.error('[Push] DB lookup failed:', err.message);
    return;
  }

  const message = JSON.stringify({
    title: payload.title || 'SinglePoint Calls',
    body:  payload.body  || '',
    url:   payload.url   || '/',
    tag:   payload.tag   || 'spc',
    requireInteraction: payload.requireInteraction || false,
  });

  for (const sub of rows) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        message,
        { TTL: 86400 } // retain for up to 24 h if device is offline
      );
      // Update last_used_at for staleness tracking
      pool.query('UPDATE push_subscriptions SET last_used_at = NOW() WHERE id = $1', [sub.id])
        .catch(() => {}); // fire-and-forget, non-critical
    } catch (err) {
      if (err.statusCode === 410 || err.statusCode === 404) {
        // Subscription is expired/invalid — remove it (GDPR: no longer needed)
        pool.query('DELETE FROM push_subscriptions WHERE id = $1', [sub.id])
          .catch(() => {});
      } else {
        console.error(`[Push] Failed to send to subscription ${sub.id}:`, err.message);
      }
    }
  }
}

/**
 * Broadcast a push to ALL connected operators (e.g. new call ringing).
 */
async function broadcastOperatorPush(payload) {
  if (!vapidConfigured) return;
  try {
    const result = await pool.query(
      `SELECT id FROM operators WHERE is_active = true AND current_status != 'offline'`
    );
    await Promise.all(result.rows.map((op) => sendPush('operator', op.id, payload)));
  } catch (err) {
    console.error('[Push] broadcastOperatorPush failed:', err.message);
  }
}

/**
 * Send a push to all portal users of a given client.
 */
async function sendClientPortalPush(clientId, payload) {
  if (!vapidConfigured) return;
  try {
    const result = await pool.query(
      'SELECT id FROM client_portal_users WHERE client_id = $1 AND is_active = true',
      [clientId]
    );
    await Promise.all(result.rows.map((u) => sendPush('portal', u.id, payload)));
  } catch (err) {
    console.error('[Push] sendClientPortalPush failed:', err.message);
  }
}

module.exports = { init, getVapidPublicKey, sendPush, broadcastOperatorPush, sendClientPortalPush };
