'use strict';

/**
 * Public callback widget — no authentication required.
 * Clients are identified by a per-client widget_token.
 *
 * GET  /api/widget/:token/embed.js     — return embeddable JS snippet
 * POST /api/widget/:token/callback     — submit a callback request
 * POST /api/widget/:token/regenerate   — regenerate token (auth required)
 */

const router = require('express').Router();
const pool   = require('../../config/database');
const { broadcast } = require('../../services/realtime');
const { requireAuth, requireRole } = require('../middleware/auth');

/* ---- Helpers ---- */

async function resolveClient(token) {
  const r = await pool.query(
    `SELECT id, name, timezone FROM clients WHERE widget_token = $1 AND is_active = true`,
    [token]
  );
  return r.rows[0] || null;
}

/* ---- GET /api/widget/:token/embed.js — serve embeddable snippet ---- */
router.get('/:token/embed.js', async (req, res, next) => {
  try {
    const client = await resolveClient(req.params.token);
    if (!client) return res.status(404).type('js').send('// Widget token not found');

    const origin = `${req.protocol}://${req.get('host')}`;
    const token  = req.params.token;

    const script = `
(function() {
  var _spToken = '${token}';
  var _spApi   = '${origin}/api/widget/' + _spToken + '/callback';
  var _spName  = '${client.name.replace(/'/g, "\\'")}';

  var btn = document.createElement('button');
  btn.id = '_sp_cb_btn';
  btn.textContent = 'Request Callback';
  btn.style.cssText = 'position:fixed;bottom:24px;right:24px;z-index:9999;padding:12px 20px;background:#2563eb;color:#fff;border:none;border-radius:24px;font-size:14px;cursor:pointer;box-shadow:0 4px 12px rgba(0,0,0,0.2)';

  var form = document.createElement('div');
  form.id = '_sp_cb_form';
  form.style.cssText = 'display:none;position:fixed;bottom:80px;right:24px;z-index:9999;background:#fff;border-radius:12px;padding:20px;width:280px;box-shadow:0 8px 24px rgba(0,0,0,0.15);font-family:sans-serif';
  form.innerHTML = '<h4 style="margin:0 0 12px;font-size:15px">Request a Callback</h4>'
    + '<p style="font-size:12px;color:#666;margin:0 0 12px">Leave your number and we\\'ll call you back.</p>'
    + '<input id="_sp_cb_name"  placeholder="Your name"  style="width:100%;box-sizing:border-box;padding:8px;margin-bottom:8px;border:1px solid #ddd;border-radius:6px;font-size:13px">'
    + '<input id="_sp_cb_phone" placeholder="Phone number" style="width:100%;box-sizing:border-box;padding:8px;margin-bottom:8px;border:1px solid #ddd;border-radius:6px;font-size:13px">'
    + '<textarea id="_sp_cb_notes" placeholder="Notes (optional)" rows="2" style="width:100%;box-sizing:border-box;padding:8px;margin-bottom:12px;border:1px solid #ddd;border-radius:6px;font-size:13px;resize:none"></textarea>'
    + '<button id="_sp_cb_submit" style="width:100%;padding:10px;background:#2563eb;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:14px">Request Callback</button>'
    + '<div id="_sp_cb_msg" style="margin-top:8px;font-size:12px;text-align:center"></div>'
    + '<button id="_sp_cb_close" style="position:absolute;top:10px;right:12px;background:none;border:none;font-size:18px;cursor:pointer;color:#999">&times;</button>';

  document.body.appendChild(btn);
  document.body.appendChild(form);

  btn.onclick = function() { form.style.display = form.style.display === 'none' ? 'block' : 'none'; };
  document.getElementById('_sp_cb_close').onclick = function() { form.style.display = 'none'; };

  document.getElementById('_sp_cb_submit').onclick = function() {
    var name  = document.getElementById('_sp_cb_name').value.trim();
    var phone = document.getElementById('_sp_cb_phone').value.trim();
    var notes = document.getElementById('_sp_cb_notes').value.trim();
    var msg   = document.getElementById('_sp_cb_msg');
    if (!name || !phone) { msg.style.color = 'red'; msg.textContent = 'Name and phone are required.'; return; }
    var btn2 = document.getElementById('_sp_cb_submit');
    btn2.disabled = true; btn2.textContent = 'Sending…';
    fetch(_spApi, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ caller_name: name, caller_phone: phone, notes: notes })
    }).then(function(r) { return r.json(); }).then(function(d) {
      if (d.id) {
        msg.style.color = 'green'; msg.textContent = 'Thanks! We will call you back shortly.';
        document.getElementById('_sp_cb_name').value = '';
        document.getElementById('_sp_cb_phone').value = '';
        document.getElementById('_sp_cb_notes').value = '';
        btn2.textContent = 'Request Callback'; btn2.disabled = false;
      } else {
        msg.style.color = 'red'; msg.textContent = d.error || 'An error occurred.';
        btn2.textContent = 'Request Callback'; btn2.disabled = false;
      }
    }).catch(function() {
      msg.style.color = 'red'; msg.textContent = 'Network error. Please try again.';
      btn2.textContent = 'Request Callback'; btn2.disabled = false;
    });
  };
})();
`;

    res.type('application/javascript').send(script);
  } catch (err) { next(err); }
});

/* ---- POST /api/widget/:token/callback — submit callback request ---- */
router.post('/:token/callback', async (req, res, next) => {
  try {
    const client = await resolveClient(req.params.token);
    if (!client) return res.status(404).json({ error: 'Widget token not found' });

    const { caller_name, caller_phone, notes } = req.body;
    if (!caller_name || !caller_phone) {
      return res.status(400).json({ error: 'caller_name and caller_phone are required' });
    }

    const result = await pool.query(
      `INSERT INTO callback_records (client_id, caller_name, phone_number, caller_phone, notes, status, source)
       VALUES ($1, $2, $3, $3, $4, 'pending', 'widget')
       RETURNING *`,
      [client.id, caller_name.trim(), caller_phone.trim(), notes?.trim() || null]
    );

    broadcast('callback:new', { record: result.rows[0] });
    res.status(201).json({ id: result.rows[0].id });
  } catch (err) { next(err); }
});

/* ---- POST /api/widget/:clientId/token — generate/regenerate widget token (admin) ---- */
router.post('/clients/:clientId/token', requireAuth, requireRole('admin'), async (req, res, next) => {
  try {
    const token = require('crypto').randomBytes(32).toString('hex');
    const result = await pool.query(
      `UPDATE clients SET widget_token = $1 WHERE id = $2 RETURNING id, widget_token`,
      [token, req.params.clientId]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Client not found' });
    res.json({ widget_token: result.rows[0].widget_token });
  } catch (err) { next(err); }
});

module.exports = router;
