'use strict';

/**
 * Public widget endpoints — no authentication required.
 * Clients are identified by a per-client widget_token.
 *
 * GET  /api/widget/:token/embed.js      — callback widget JS snippet
 * POST /api/widget/:token/callback      — submit a callback request
 * GET  /api/widget/:token/intake.js     — dynamic intake form JS snippet
 * POST /api/widget/:token/intake        — submit an intake form
 * GET  /api/widget/:token/intake-data   — returns form schema JSON (for SPAs)
 * POST /api/widget/clients/:id/token    — regenerate widget token (admin)
 */

const router  = require('express').Router();
const pool    = require('../../config/database');
const { broadcast } = require('../../services/realtime');
const { requireAuth, requireRole } = require('../middleware/auth');
const { rateLimit } = require('express-rate-limit');

const intakeLimit = rateLimit({
  windowMs: 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `${req.params.token}:${req.ip}`,
});

/* ---- Helpers ---- */

async function resolveClient(token, withForm = false) {
  const cols = withForm ? 'id, name, timezone, custom_form' : 'id, name, timezone';
  const r = await pool.query(
    `SELECT ${cols} FROM clients WHERE widget_token = $1 AND is_active = true`,
    [token]
  );
  return r.rows[0] || null;
}

function escJs(str) {
  return String(str ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n');
}

function buildIntakeFormHtml(fields) {
  if (!Array.isArray(fields) || !fields.length) return '<p style="color:#999;font-size:13px">No form fields configured for this client.</p>';
  return fields.map((f) => {
    const label = `<label style="display:block;font-size:13px;font-weight:600;margin-bottom:4px">${escJs(f.label || f.id)}${f.required ? ' <span style="color:red">*</span>' : ''}</label>`;
    const style = 'width:100%;box-sizing:border-box;padding:8px;margin-bottom:12px;border:1px solid #ddd;border-radius:6px;font-size:13px';
    let input = '';
    if (f.type === 'textarea') {
      input = `<textarea id="_sp_if_${f.id}" name="${f.id}" rows="3" ${f.required ? 'required' : ''} style="${style};resize:vertical"></textarea>`;
    } else if (f.type === 'select') {
      const opts = (f.options || []).map((o) => `<option value="${escJs(o)}">${escJs(o)}</option>`).join('');
      input = `<select id="_sp_if_${f.id}" name="${f.id}" ${f.required ? 'required' : ''} style="${style}"><option value="">Select…</option>${opts}</select>`;
    } else if (f.type === 'checkbox') {
      input = `<label style="display:flex;align-items:center;gap:8px;margin-bottom:12px"><input type="checkbox" id="_sp_if_${f.id}" name="${f.id}" style="width:16px;height:16px"> <span style="font-size:13px">${escJs(f.label || f.id)}</span></label>`;
    } else {
      input = `<input type="${f.type || 'text'}" id="_sp_if_${f.id}" name="${f.id}" ${f.required ? 'required' : ''} style="${style}">`;
    }
    const showWhen = f.show_when?.field ? `data-show-when-field="${f.show_when.field}" data-show-when-value="${escJs(f.show_when.value || '')}"` : '';
    return `<div class="_sp_field" id="_sp_wrap_${f.id}" ${showWhen}>${f.type !== 'checkbox' ? label : ''}${input}</div>`;
  }).join('');
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

/* ---- GET /api/widget/:token/intake-data — return form schema as JSON ---- */
router.get('/:token/intake-data', async (req, res, next) => {
  try {
    const client = await resolveClient(req.params.token, true);
    if (!client) return res.status(404).json({ error: 'Widget token not found' });
    res.json({ client_name: client.name, fields: client.custom_form || [] });
  } catch (err) { next(err); }
});

/* ---- GET /api/widget/:token/intake.js — embeddable dynamic intake form ---- */
router.get('/:token/intake.js', async (req, res, next) => {
  try {
    const client = await resolveClient(req.params.token, true);
    if (!client) return res.status(404).type('js').send('// Widget token not found');

    const origin  = `${req.protocol}://${req.get('host')}`;
    const token   = req.params.token;
    const apiUrl  = `${origin}/api/widget/${token}/intake`;
    const fields  = client.custom_form || [];
    const formHtml = buildIntakeFormHtml(fields).replace(/`/g, '\\`');

    const script = `
(function() {
  var _spApi  = '${apiUrl}';
  var _spClientName = '${escJs(client.name)}';
  var _spFields = ${JSON.stringify(fields)};

  var style = document.createElement('style');
  style.textContent = '._sp_if_panel{display:none;position:fixed;bottom:80px;right:24px;z-index:9999;background:#fff;border-radius:12px;padding:20px;width:320px;max-height:80vh;overflow-y:auto;box-shadow:0 8px 24px rgba(0,0,0,0.15);font-family:sans-serif}._sp_if_btn{position:fixed;bottom:24px;right:24px;z-index:9999;padding:12px 20px;background:#0f766e;color:#fff;border:none;border-radius:24px;font-size:14px;cursor:pointer;box-shadow:0 4px 12px rgba(0,0,0,0.2)}';
  document.head.appendChild(style);

  var btn = document.createElement('button');
  btn.className = '_sp_if_btn';
  btn.textContent = 'Send a Message';

  var panel = document.createElement('div');
  panel.className = '_sp_if_panel';
  panel.id = '_sp_if_panel';
  panel.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px"><h4 style="margin:0;font-size:15px">Message ' + _spClientName + '</h4><button id="_sp_if_close" style="background:none;border:none;font-size:20px;cursor:pointer;color:#999">&times;</button></div>'
    + '<form id="_sp_if_form">'
    + '<input type="text" id="_sp_if_caller_name" placeholder="Your name *" required style="width:100%;box-sizing:border-box;padding:8px;margin-bottom:8px;border:1px solid #ddd;border-radius:6px;font-size:13px">'
    + '<input type="tel" id="_sp_if_caller_phone" placeholder="Phone number *" required style="width:100%;box-sizing:border-box;padding:8px;margin-bottom:8px;border:1px solid #ddd;border-radius:6px;font-size:13px">'
    + \`${formHtml}\`
    + '<button type="submit" id="_sp_if_submit" style="width:100%;padding:10px;background:#0f766e;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:14px">Submit</button>'
    + '<div id="_sp_if_msg" style="margin-top:8px;font-size:12px;text-align:center"></div>'
    + '</form>';

  document.body.appendChild(btn);
  document.body.appendChild(panel);

  btn.onclick = function() { panel.style.display = panel.style.display === 'block' ? 'none' : 'block'; };
  document.getElementById('_sp_if_close').onclick = function() { panel.style.display = 'none'; };

  function updateVisibility() {
    _spFields.forEach(function(f) {
      if (!f.show_when || !f.show_when.field) return;
      var wrap = document.getElementById('_sp_wrap_' + f.id);
      if (!wrap) return;
      var ctrl = document.getElementById('_sp_if_' + f.show_when.field);
      if (!ctrl) return;
      var val = ctrl.type === 'checkbox' ? (ctrl.checked ? 'true' : 'false') : ctrl.value;
      wrap.style.display = val === f.show_when.value ? 'block' : 'none';
    });
  }
  panel.addEventListener('change', updateVisibility);
  panel.addEventListener('input', updateVisibility);
  updateVisibility();

  document.getElementById('_sp_if_form').onsubmit = function(e) {
    e.preventDefault();
    var name  = document.getElementById('_sp_if_caller_name').value.trim();
    var phone = document.getElementById('_sp_if_caller_phone').value.trim();
    if (!name || !phone) return;
    var formData = { caller_name: name, caller_phone: phone, fields: {} };
    _spFields.forEach(function(f) {
      var el = document.getElementById('_sp_if_' + f.id);
      if (!el) return;
      formData.fields[f.id] = el.type === 'checkbox' ? el.checked : el.value;
    });
    var sub = document.getElementById('_sp_if_submit');
    sub.disabled = true; sub.textContent = 'Sending…';
    fetch(_spApi, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(formData)
    }).then(function(r) { return r.json(); }).then(function(d) {
      var msg = document.getElementById('_sp_if_msg');
      if (d.id) {
        msg.style.color = 'green'; msg.textContent = 'Thank you! Your message has been received.';
        document.getElementById('_sp_if_form').reset();
        updateVisibility();
      } else {
        msg.style.color = 'red'; msg.textContent = d.error || 'An error occurred.';
      }
      sub.disabled = false; sub.textContent = 'Submit';
    }).catch(function() {
      document.getElementById('_sp_if_msg').style.color = 'red';
      document.getElementById('_sp_if_msg').textContent = 'Network error. Please try again.';
      sub.disabled = false; sub.textContent = 'Submit';
    });
  };
})();
`;
    res.type('application/javascript').send(script);
  } catch (err) { next(err); }
});

/* ---- POST /api/widget/:token/intake — submit intake form, create message ---- */
router.post('/:token/intake', intakeLimit, async (req, res, next) => {
  try {
    const client = await resolveClient(req.params.token, true);
    if (!client) return res.status(404).json({ error: 'Widget token not found' });

    const { caller_name, caller_phone, fields = {} } = req.body;
    if (!caller_name || !caller_phone) {
      return res.status(400).json({ error: 'caller_name and caller_phone are required' });
    }

    const formFields = Array.isArray(client.custom_form) ? client.custom_form : [];

    const formLines = formFields.map((f) => {
      const val = fields[f.id];
      if (val === undefined || val === null || val === '') return null;
      return `${f.label || f.id}: ${val}`;
    }).filter(Boolean);

    const body = [`Name: ${caller_name}`, `Phone: ${caller_phone}`, ...formLines].join('\n');

    const msgResult = await pool.query(
      `INSERT INTO messages (client_id, caller_id_name, caller_id_num, body, source, status)
       VALUES ($1, $2, $3, $4, 'intake_form', 'new')
       RETURNING *`,
      [client.id, caller_name.trim(), caller_phone.trim(), body]
    );
    const message = msgResult.rows[0];

    await pool.query(
      `INSERT INTO intake_form_submissions (client_id, message_id, form_data, submitter_ip)
       VALUES ($1, $2, $3, $4)`,
      [client.id, message.id, JSON.stringify({ caller_name, caller_phone, ...fields }), req.ip]
    );

    broadcast('message:new', { message });
    res.status(201).json({ id: message.id });
  } catch (err) { next(err); }
});

/* ---- GET /api/widget/submissions — list intake form submissions (admin) ---- */
router.get('/submissions', requireAuth, async (req, res, next) => {
  try {
    const { client_id, limit = 50, offset = 0 } = req.query;
    const params = [];
    const conditions = [];
    if (client_id) {
      params.push(client_id);
      conditions.push(`s.client_id = $${params.length}`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(Number(limit), Number(offset));
    const result = await pool.query(
      `SELECT s.*, c.name AS client_name,
              m.caller_id_name, m.caller_id_num, m.status AS message_status
         FROM intake_form_submissions s
         LEFT JOIN clients c ON c.id = s.client_id
         LEFT JOIN messages m ON m.id = s.message_id
       ${where}
       ORDER BY s.submitted_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    res.json({ submissions: result.rows });
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
