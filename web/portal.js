'use strict';

const Portal = (() => {
  let token = localStorage.getItem('portal_token');
  let currentUser = null;
  let msgOffset = 0;
  const MSG_LIMIT = 25;

  const el = (id) => document.getElementById(id);
  const escHtml = (s) => {
    if (!s) return '';
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  };

  async function api(method, path, body) {
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    if (token) opts.headers['Authorization'] = `Bearer ${token}`;
    if (body)  opts.body = JSON.stringify(body);
    const res = await fetch(`/api${path}`, opts);
    if (res.status === 401) { logout(); return null; }
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || 'Request failed');
    }
    return res.json();
  }

  function relTime(isoStr) {
    if (!isoStr) return '';
    const diff = (Date.now() - new Date(isoStr).getTime()) / 1000;
    if (diff < 60)    return 'just now';
    if (diff < 3600)  return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return new Date(isoStr).toLocaleDateString('en-GB');
  }

  function formatDate(isoStr) {
    if (!isoStr) return '—';
    return new Date(isoStr).toLocaleString('en-GB', {
      day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit'
    });
  }

  function fmtMins(secs) {
    const m = Math.floor((secs || 0) / 60);
    const s = (secs || 0) % 60;
    return `${m}m ${s}s`;
  }

  /* ---- Auth ---- */
  async function init() {
    el('portal-login-form').addEventListener('submit', handleLogin);
    if (token) {
      try {
        const data = await api('GET', '/portal/me');
        if (data) { currentUser = data.user; showApp(); return; }
      } catch {}
    }
    showLogin();
  }

  async function handleLogin(e) {
    e.preventDefault();
    const errEl = el('p-login-error');
    errEl.classList.add('hidden');
    try {
      const data = await fetch('/api/portal/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: el('p-username').value, password: el('p-password').value }),
      }).then((r) => r.json());
      if (!data.token) throw new Error(data.error || 'Login failed');
      token = data.token;
      currentUser = data.user;
      localStorage.setItem('portal_token', token);
      showApp();
    } catch (err) {
      errEl.textContent = err.message;
      errEl.classList.remove('hidden');
    }
  }

  function logout() {
    token = null; currentUser = null;
    localStorage.removeItem('portal_token');
    showLogin();
  }

  function showLogin() {
    el('portal-login').classList.add('active');
    el('portal-app').classList.remove('active');
  }

  function showApp() {
    el('portal-login').classList.remove('active');
    el('portal-app').classList.add('active');
    el('p-username-display').textContent = currentUser.username;
    el('p-company-name').textContent = currentUser.client_name || 'Client Portal';
    nav('dashboard');
  }

  /* ---- Navigation ---- */
  function nav(section) {
    document.querySelectorAll('.p-section').forEach((s) => s.classList.remove('active'));
    document.querySelectorAll('.p-nav-btn').forEach((b) => b.classList.remove('active'));
    const sEl = el(`p-${section}`);
    if (sEl) sEl.classList.add('active');
    const btn = document.querySelector(`.p-nav-btn[onclick="Portal.nav('${section}')"]`);
    if (btn) btn.classList.add('active');

    if (section === 'dashboard') loadDashboard();
    else if (section === 'messages') { msgOffset = 0; loadMessages(); }
    else if (section === 'calls') loadCalls();
    else if (section === 'billing') loadBilling();
    else if (section === 'availability') loadAvailability();
  }

  /* ---- Dashboard ---- */
  async function loadDashboard() {
    // Client info card
    const info = el('p-client-info');
    if (info && currentUser) {
      info.innerHTML = `
        <div class="p-client-name">${escHtml(currentUser.client_name)}</div>
        <div class="p-client-acct">Account: ${escHtml(currentUser.account_number)}</div>
      `;
    }

    // Stats
    try {
      const [callData, msgData] = await Promise.all([
        api('GET', '/portal/calls?days=30'),
        api('GET', '/portal/messages?limit=5'),
      ]);
      if (callData) {
        const s = callData.summary;
        el('p-stats').innerHTML = [
          { label: 'Total Calls (30d)', value: s.total,   color: 'blue' },
          { label: 'Answered',          value: s.answered, color: 'green' },
          { label: 'Missed',            value: s.missed,   color: 'red' },
          { label: 'Minutes (30d)',      value: s.total_minutes, color: 'orange' },
        ].map((c) => `
          <div class="p-stat-card p-stat-${c.color}">
            <div class="p-stat-value">${c.value ?? 0}</div>
            <div class="p-stat-label">${c.label}</div>
          </div>
        `).join('');
      }
      if (msgData) {
        renderMsgList(el('p-dash-messages'), msgData.messages, 5);
      }
    } catch (err) {
      el('p-stats').innerHTML = `<p class="p-empty">Error: ${escHtml(err.message)}</p>`;
    }
  }

  /* ---- Messages ---- */
  async function loadMessages() {
    const status = el('p-msg-filter')?.value;
    let path = `/portal/messages?limit=${MSG_LIMIT}&offset=${msgOffset}`;
    if (status) path += `&status=${status}`;
    try {
      const data = await api('GET', path);
      if (!data) return;
      renderMsgList(el('p-messages-list'), data.messages);
      el('p-msg-page-info').textContent = `Page ${Math.floor(msgOffset / MSG_LIMIT) + 1}`;
      el('p-msg-prev').disabled = msgOffset === 0;
      el('p-msg-next').disabled = data.messages.length < MSG_LIMIT;
    } catch (err) {
      el('p-messages-list').innerHTML = `<p class="p-empty">Error: ${escHtml(err.message)}</p>`;
    }
  }

  function msgPage(dir) {
    msgOffset = Math.max(0, msgOffset + dir * MSG_LIMIT);
    loadMessages();
  }

  function renderMsgList(container, messages, limit) {
    if (!container) return;
    const items = limit ? messages.slice(0, limit) : messages;
    if (!items.length) {
      container.innerHTML = '<p class="p-empty">No messages</p>';
      return;
    }
    const urgencyColors = { low: 'grey', normal: 'blue', high: 'red' };
    container.innerHTML = items.map((m) => `
      <div class="p-msg-item">
        <div class="p-msg-header">
          <span class="p-msg-caller">${escHtml(m.caller_name || m.caller_phone || 'Unknown caller')}</span>
          <span class="p-msg-urgency p-urg-${urgencyColors[m.urgency] || 'blue'}">${m.urgency}</span>
          <span class="p-msg-status p-status-${m.status}">${m.status}</span>
        </div>
        ${m.subject ? `<div class="p-msg-subject">${escHtml(m.subject)}</div>` : ''}
        <div class="p-msg-body">${escHtml(m.body)}</div>
        <div class="p-msg-meta">
          ${m.operator_name ? `<span>Taken by ${escHtml(m.operator_name)}</span>` : ''}
          <span>${relTime(m.created_at)}</span>
        </div>
      </div>
    `).join('');
  }

  /* ---- Calls ---- */
  async function loadCalls() {
    const days = el('p-call-days')?.value || 30;
    try {
      const data = await api('GET', `/portal/calls?days=${days}`);
      if (!data) return;
      const s = data.summary;
      el('p-call-stats').innerHTML = [
        { label: 'Total Calls',   value: s.total,          color: 'blue' },
        { label: 'Answered',      value: s.answered,       color: 'green' },
        { label: 'Missed',        value: s.missed,          color: 'red' },
        { label: 'Total Minutes', value: s.total_minutes,  color: 'orange' },
      ].map((c) => `
        <div class="p-stat-card p-stat-${c.color}">
          <div class="p-stat-value">${c.value ?? 0}</div>
          <div class="p-stat-label">${c.label}</div>
        </div>
      `).join('');

      el('p-calls-tbody').innerHTML = data.recent.length
        ? data.recent.map((c) => `
          <tr>
            <td>${formatDate(c.call_start)}</td>
            <td>${escHtml(c.caller_id_name || c.caller_id_num || '—')}<br/><small style="color:#999">${escHtml(c.caller_id_num || '')}</small></td>
            <td>${c.duration_seconds ? fmtMins(c.duration_seconds) : '—'}</td>
            <td>${escHtml(c.operator_name || '—')}</td>
            <td><span class="p-pill p-pill-${c.disposition === 'answered' ? 'green' : 'red'}">${c.disposition || '—'}</span></td>
          </tr>
        `).join('')
        : '<tr><td colspan="5" class="p-empty">No calls in this period</td></tr>';
    } catch (err) {
      el('p-calls-tbody').innerHTML = `<tr><td colspan="5" class="p-empty">Error: ${escHtml(err.message)}</td></tr>`;
    }
  }

  /* ---- Billing ---- */
  async function loadBilling() {
    try {
      const data = await api('GET', '/billing/portal/reports');
      if (!data) return;

      const plan = data.plan;
      el('p-plan-card').innerHTML = plan ? `
        <div class="p-plan-name">${escHtml(plan.plan_name)}</div>
        <div class="p-plan-details">
          <span>&#163;${parseFloat(plan.monthly_fee).toFixed(2)}/month</span>
          <span>${plan.included_calls} calls included</span>
          <span>${plan.included_minutes} minutes included</span>
          <span>${plan.currency}</span>
        </div>
      ` : '<p class="p-empty">No billing plan configured — contact your account manager.</p>';

      const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      el('p-billing-tbody').innerHTML = data.reports.length
        ? data.reports.map((r) => `
          <tr>
            <td><strong>${months[r.month-1]} ${r.year}</strong></td>
            <td>${r.total_calls} <small style="color:#999">(${r.answered_calls} ans, ${r.missed_calls} missed)</small></td>
            <td>${r.total_minutes}m</td>
            <td>${r.total_messages}</td>
            <td><strong>${plan?.currency || 'GBP'} ${parseFloat(r.amount_due).toFixed(2)}</strong></td>
            <td><button class="p-btn p-btn-sm" onclick="Portal.downloadReport('${r.id}')">&#11015; View</button></td>
          </tr>
        `).join('')
        : '<tr><td colspan="6" class="p-empty">No reports yet</td></tr>';
    } catch (err) {
      el('p-billing-tbody').innerHTML = `<tr><td colspan="6" class="p-empty">Error: ${escHtml(err.message)}</td></tr>`;
    }
  }

  function downloadReport(reportId) {
    alert('PDF export coming soon. Please contact your account manager for a full invoice.');
  }

  /* ---- Availability ---- */
  async function loadAvailability() {
    try {
      const data = await api('GET', '/portal/availability');
      if (!data) return;
      const avail = data.availability;
      document.querySelectorAll('input[name="p-avail"]').forEach((r) => {
        r.checked = r.value === avail.status;
      });
      document.querySelectorAll('.p-avail-card').forEach((c) => c.classList.remove('p-avail-active'));
      const active = el(`pa-${avail.status}`);
      if (active) active.classList.add('p-avail-active');
      if (avail.note) el('p-avail-note').value = avail.note;
    } catch {}
  }

  async function setAvailability(status) {
    document.querySelectorAll('.p-avail-card').forEach((c) => c.classList.remove('p-avail-active'));
    const active = el(`pa-${status}`);
    if (active) active.classList.add('p-avail-active');
    try {
      await api('PUT', '/portal/availability', { status, note: el('p-avail-note').value });
    } catch (err) { alert(`Failed to update: ${err.message}`); }
  }

  async function saveAvailNote() {
    const status = document.querySelector('input[name="p-avail"]:checked')?.value || 'available';
    try {
      await api('PUT', '/portal/availability', { status, note: el('p-avail-note').value });
      alert('Note saved');
    } catch (err) { alert(`Failed: ${err.message}`); }
  }

  document.addEventListener('DOMContentLoaded', init);

  return { nav, logout, loadMessages, msgPage, loadCalls, loadBilling, loadAvailability, setAvailability, saveAvailNote, downloadReport };
})();
