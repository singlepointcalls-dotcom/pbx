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
    // Handle password-reset link: /portal.html?reset=TOKEN&user=USERNAME
    const params = new URLSearchParams(location.search);
    const resetToken    = params.get('reset');
    const resetUsername = params.get('user');
    if (resetToken && resetUsername) {
      el('portal-login-form').style.display = 'none';
      el('portal-reset').style.display = 'block';
      el('portal-reset').dataset.token    = resetToken;
      el('portal-reset').dataset.username = resetUsername;
      return;
    }
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
    disconnectRealtime();
    token = null; currentUser = null;
    localStorage.removeItem('portal_token');
    showLogin();
  }

  function showLogin() {
    el('portal-login').classList.add('active');
    el('portal-app').classList.remove('active');
    el('portal-login-form').style.display = 'block';
    el('portal-forgot').style.display = 'none';
    el('portal-reset').style.display  = 'none';
  }

  function showForgot(e) {
    if (e) e.preventDefault();
    el('portal-login-form').style.display = 'none';
    el('portal-forgot').style.display = 'block';
    el('portal-reset').style.display  = 'none';
    setTimeout(() => { const u = el('p-forgot-username'); if (u) u.focus(); }, 80);
  }

  async function doForgot() {
    const username = (el('p-forgot-username')?.value || '').trim();
    const errEl = el('p-forgot-error');
    const okEl  = el('p-forgot-ok');
    errEl.textContent = '';
    okEl.style.display = 'none';
    if (!username) { errEl.textContent = 'Enter your username'; return; }
    try {
      await fetch('/api/portal/password-reset/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username }),
      });
      okEl.textContent = 'If that username exists with an email on file, a reset link has been sent.';
      okEl.style.display = 'block';
    } catch (err) { errEl.textContent = err.message; }
  }

  async function doReset() {
    const resetEl = el('portal-reset');
    const token_  = resetEl?.dataset.token    || '';
    const username = resetEl?.dataset.username || '';
    const newPw   = el('p-reset-password')?.value || '';
    const errEl   = el('p-reset-error');
    const okEl    = el('p-reset-ok');
    errEl.textContent = '';
    okEl.style.display = 'none';
    if (!newPw) { errEl.textContent = 'Enter a new password'; return; }
    try {
      const r = await fetch('/api/portal/password-reset/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, token: token_, new_password: newPw }),
      }).then((res) => res.json());
      if (r.error) throw new Error(r.error);
      okEl.textContent = 'Password updated! Redirecting to login…';
      okEl.style.display = 'block';
      setTimeout(() => {
        history.replaceState(null, '', location.pathname);
        showLogin();
      }, 2000);
    } catch (err) { errEl.textContent = err.message; }
  }

  /* ---- Real-time Socket.io connection ---- */
  let _socket = null;
  let _liveToastTimer = null;
  let _unreadCount = 0;

  function connectRealtime() {
    if (typeof io === 'undefined') return;
    if (_socket) { _socket.disconnect(); _socket = null; }
    _socket = io({ auth: { token } });
    _socket.on('connect', () => {});
    _socket.on('disconnect', () => {});

    // New message created for this client by an operator
    _socket.on('message:new', (data) => {
      const msg = data.message;
      if (msg && msg.client_id && currentUser && msg.client_id === currentUser.client_id) {
        _unreadCount++;
        showLiveToast(`&#128220; New message from ${msg.caller_name || msg.caller_phone || 'a caller'}`, () => {
          nav('messages');
        });
      }
    });

    // Operator reply to portal enquiry
    _socket.on('portal:message:reply', (data) => {
      const { message_id } = data;
      showLiveToast(`&#128140; Our team replied to your enquiry`, () => {
        nav('messages');
        setTimeout(() => {
          const replyContainer = document.getElementById(`msg-replies-${message_id}`);
          if (replyContainer && replyContainer.style.display !== 'none') {
            toggleMsgReplies(message_id);
          }
        }, 500);
      });
    });

    // Portal-targeted new message event (more specific)
    _socket.on('portal:message:new', (data) => {
      _unreadCount++;
      showLiveToast(`&#128220; New message received`, () => { nav('messages'); });
      // If messages section is open, refresh it
      const msgSection = el('p-messages');
      if (msgSection && msgSection.classList.contains('active')) loadMessages();
    });

    // Appointment updated
    _socket.on('appointment:updated', () => {
      const apptSection = el('p-appointments');
      if (apptSection && apptSection.classList.contains('active')) loadAppointments();
    });
  }

  function disconnectRealtime() {
    if (_socket) { _socket.disconnect(); _socket = null; }
  }

  function showLiveToast(html, onClick) {
    const toast = el('p-live-toast');
    if (!toast) return;
    if (_liveToastTimer) { clearTimeout(_liveToastTimer); _liveToastTimer = null; }
    toast.innerHTML = html + ' <span style="opacity:0.6;font-size:0.78rem;float:right;margin-left:8px">✕</span>';
    toast.style.display = 'block';
    if (onClick) toast.onclick = () => { dismissLiveToast(); onClick(); };
    _liveToastTimer = setTimeout(dismissLiveToast, 6000);
  }

  function dismissLiveToast() {
    const toast = el('p-live-toast');
    if (toast) toast.style.display = 'none';
    if (_liveToastTimer) { clearTimeout(_liveToastTimer); _liveToastTimer = null; }
  }

  function showApp() {
    el('portal-login').classList.remove('active');
    el('portal-app').classList.add('active');
    el('p-username-display').textContent = currentUser.username;
    el('p-company-name').textContent = currentUser.client_name || 'Client Portal';

    // Apply client branding
    if (currentUser.logo_url) {
      const logo = el('p-client-logo');
      if (logo) { logo.src = currentUser.logo_url; logo.style.display = 'inline-block'; }
    }
    if (currentUser.brand_color) {
      const topbar = el('p-topbar');
      if (topbar) topbar.style.setProperty('--p-brand', currentUser.brand_color);
      document.documentElement.style.setProperty('--p-primary', currentUser.brand_color);
    }

    nav('dashboard');
    initPush();
    connectRealtime();
  }

  /* ---- Navigation ---- */
  function nav(section) {
    document.querySelectorAll('.p-section').forEach((s) => s.classList.remove('active'));
    document.querySelectorAll('.p-nav-btn').forEach((b) => b.classList.remove('active'));
    const sEl = el(`p-${section}`);
    if (sEl) sEl.classList.add('active');
    const btn = document.querySelector(`.p-nav-btn[onclick="Portal.nav('${section}')"]`);
    if (btn) btn.classList.add('active');
    // Close mobile nav drawer if open
    closeMobileNav();

    if (section === 'dashboard') loadDashboard();
    else if (section === 'messages') { msgOffset = 0; loadMessages(); }
    else if (section === 'calls') loadCalls();
    else if (section === 'contacts') loadContacts();
    else if (section === 'appointments') loadAppointments();
    else if (section === 'knowledge') loadKnowledge();
    else if (section === 'files') loadFiles();
    else if (section === 'billing') loadBilling();
    else if (section === 'availability') loadAvailability();
    else if (section === 'account') loadAccount();
  }

  /* ---- Mobile nav toggle ---- */
  function toggleMobileNav() {
    const nav = el('p-topbar-nav');
    if (nav) nav.classList.toggle('open');
  }

  function closeMobileNav() {
    const nav = el('p-topbar-nav');
    if (nav) nav.classList.remove('open');
  }

  // Close mobile nav on outside tap
  document.addEventListener('click', (e) => {
    const nav  = el('p-topbar-nav');
    const btn  = el('p-hamburger');
    if (nav && nav.classList.contains('open') && !nav.contains(e.target) && e.target !== btn) {
      nav.classList.remove('open');
    }
  }, true);

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
      const [msgData, stats] = await Promise.all([
        api('GET', '/portal/messages?limit=5'),
        api('GET', '/portal/stats').catch(() => null),
      ]);
      const statCards = [];
      if (stats) {
        const s = stats.calls;
        const m = stats.messages;
        const sat = stats.satisfaction;
        statCards.push(
          { label: 'Calls (30d)',       value: s.calls_30d,            color: 'blue' },
          { label: 'Answered',          value: s.answered_calls,        color: 'green' },
          { label: 'Missed',            value: s.missed_calls,          color: 'red' },
          { label: 'Avg Duration',      value: s.avg_duration_seconds ? `${Math.round(s.avg_duration_seconds / 60)}m` : '—', color: 'orange' },
          { label: 'Messages (30d)',    value: m.messages_30d,          color: 'blue' },
          { label: 'Pending',           value: m.pending_messages,      color: 'orange' },
          { label: 'Acknowledged',      value: m.acknowledged_messages, color: 'green' },
          { label: 'Avg Response',      value: m.avg_response_seconds ? `${Math.round(m.avg_response_seconds / 60)}m` : '—', color: 'purple' },
        );
        if (sat.rated_count > 0) {
          statCards.push({ label: `Satisfaction (${sat.rated_count} rated)`, value: `${(sat.avg_rating || 0).toFixed(1)} ★`, color: 'yellow' });
        }
      }
      el('p-stats').innerHTML = statCards.length
        ? statCards.map((c) => `
          <div class="p-stat-card p-stat-${c.color}">
            <div class="p-stat-value">${c.value ?? 0}</div>
            <div class="p-stat-label">${c.label}</div>
          </div>`).join('')
        : '<p class="p-empty">No stats available</p>';
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
    const q = el('p-msg-search')?.value.trim();
    let path = `/portal/messages?limit=${MSG_LIMIT}&offset=${msgOffset}`;
    if (status) path += `&status=${status}`;
    if (q) path += `&q=${encodeURIComponent(q)}`;
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

  let _msgSearchTimer = null;
  function onMsgSearch() {
    clearTimeout(_msgSearchTimer);
    _msgSearchTimer = setTimeout(() => { msgOffset = 0; loadMessages(); }, 300);
  }

  function msgPage(dir) {
    msgOffset = Math.max(0, msgOffset + dir * MSG_LIMIT);
    loadMessages();
  }

  function openComposeMessage() {
    const overlay = el('p-compose-overlay');
    if (overlay) overlay.style.display = 'flex';
    el('p-compose-subject').value = '';
    el('p-compose-body').value = '';
    el('p-compose-urgency').value = 'normal';
  }

  function closeComposeMessage() {
    const overlay = el('p-compose-overlay');
    if (overlay) overlay.style.display = 'none';
  }

  async function sendPortalMessage() {
    const subject     = el('p-compose-subject')?.value.trim();
    const body        = el('p-compose-body')?.value.trim();
    const urgency     = el('p-compose-urgency')?.value || 'normal';
    const callerName  = el('p-compose-caller-name')?.value.trim();
    const callerPhone = el('p-compose-caller-phone')?.value.trim();
    if (!body) return toast('Please enter your message', 'error');
    const payload = { subject, body, urgency };
    if (callerName) payload.caller_name = callerName;
    if (callerPhone) payload.caller_phone = callerPhone;
    try {
      await api('POST', '/portal/messages', payload);
      toast('Message sent to your answering team');
      closeComposeMessage();
      msgOffset = 0;
      loadMessages();
    } catch (err) { toast(err.message, 'error'); }
  }

  async function acknowledgeMessage(messageId, btn) {
    try {
      btn.disabled = true;
      await api('POST', `/portal/messages/${messageId}/acknowledge`);
      const item = document.getElementById(`pmsg-${messageId}`);
      if (item) {
        const ackBtn = item.querySelector('button[onclick*="acknowledgeMessage"]');
        if (ackBtn) ackBtn.replaceWith(Object.assign(document.createElement('span'), {
          style: 'font-size:0.78rem;color:#27ae60', textContent: '✓ Acknowledged',
        }));
      }
      msgOffset = 0;
      loadMessages();
    } catch (err) { toast(err.message, 'error'); btn.disabled = false; }
  }

  async function rateMessage(messageId, stars) {
    try {
      await api('POST', `/portal/messages/${messageId}/rate`, { rating: stars });
      toast(`Thank you for your ${stars}-star rating!`, 'success');
      msgOffset = 0;
      loadMessages();
    } catch (err) { toast(err.message, 'error'); }
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
      <div class="p-msg-item" id="pmsg-${m.id}">
        <div class="p-msg-header">
          <span class="p-msg-caller">${escHtml(m.caller_name || m.caller_phone || 'Unknown caller')}</span>
          <span class="p-msg-urgency p-urg-${urgencyColors[m.urgency] || 'blue'}">${m.urgency}</span>
          <span class="p-msg-status p-status-${m.status}">${m.status}</span>
        </div>
        ${m.subject ? `<div class="p-msg-subject">${escHtml(m.subject)}</div>` : ''}
        <div class="p-msg-body">${escHtml(m.body)}</div>
        <div class="p-msg-meta" style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px">
          <div style="display:flex;gap:12px;font-size:0.78rem;color:var(--p-text-muted,#888)">
            ${m.operator_name ? `<span>Taken by ${escHtml(m.operator_name)}</span>` : ''}
            <span>${relTime(m.created_at)}</span>
            ${m.acknowledged_at ? `<span style="color:#27ae60">&#10003; Acknowledged</span>` : ''}
          </div>
          <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
            ${(m.status === 'acknowledged' || m.acknowledged_at) && !m.portal_rating ? `
              <span style="font-size:0.78rem;color:var(--p-text-muted,#888)">Rate:</span>
              ${[1,2,3,4,5].map((s) => `<button class="p-btn p-btn-sm" title="${s} star${s>1?'s':''}" onclick="Portal.rateMessage('${m.id}',${s})" style="padding:2px 6px;font-size:1rem;background:none;border:none;cursor:pointer;color:#f0ad4e">&#9733;</button>`).join('')}
            ` : m.portal_rating ? `<span style="font-size:0.82rem;color:#f0ad4e">${'&#9733;'.repeat(m.portal_rating)}${'&#9734;'.repeat(5-m.portal_rating)}</span>` : ''}
            <button class="p-btn p-btn-sm p-btn-secondary" onclick="Portal.toggleMsgReplies('${m.id}', this)">&#128140; Replies</button>
            ${!m.acknowledged_at && m.status !== 'acknowledged' ? `
              <button class="p-btn p-btn-sm" onclick="Portal.acknowledgeMessage('${m.id}', this)">&#10003; Mark Read</button>
            ` : ''}
          </div>
        </div>
        <div id="msg-replies-${m.id}" style="display:none;margin-top:8px;padding:8px;background:var(--p-card-bg,#f8f9fa);border-radius:6px;font-size:0.82rem">
          Loading replies...
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
            <td data-label="Date / Time">${formatDate(c.call_start)}</td>
            <td data-label="Caller">${escHtml(c.caller_id_name || c.caller_id_num || '—')}<br/><small style="color:#999">${escHtml(c.caller_id_num || '')}</small></td>
            <td data-label="Duration">${c.duration_seconds ? fmtMins(c.duration_seconds) : '—'}</td>
            <td data-label="Answered By">${escHtml(c.operator_name || '—')}</td>
            <td data-label="Status"><span class="p-pill p-pill-${c.disposition === 'answered' ? 'green' : 'red'}">${c.disposition || '—'}</span></td>
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
            <td data-label="Period"><strong>${months[r.month-1]} ${r.year}</strong></td>
            <td data-label="Calls">${r.total_calls} <small style="color:#999">(${r.answered_calls} ans, ${r.missed_calls} missed)</small></td>
            <td data-label="Minutes">${r.total_minutes}m</td>
            <td data-label="Messages">${r.total_messages}</td>
            <td data-label="Amount Due"><strong>${plan?.currency || 'GBP'} ${parseFloat(r.amount_due).toFixed(2)}</strong></td>
            <td data-label="Report"><button class="p-btn p-btn-sm" onclick="Portal.downloadReport('${r.id}')">&#11015; View</button></td>
          </tr>
        `).join('')
        : '<tr><td colspan="6" class="p-empty">No reports yet</td></tr>';
    } catch (err) {
      el('p-billing-tbody').innerHTML = `<tr><td colspan="6" class="p-empty">Error: ${escHtml(err.message)}</td></tr>`;
    }
  }

  function downloadReport(reportId) {
    window.open(`/api/billing/portal/reports/${encodeURIComponent(reportId)}/invoice?token=${encodeURIComponent(token)}`, '_blank', 'noopener');
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

  /* ---- Web Push notifications ---- */
  async function initPush() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
    // Register service worker
    try {
      await navigator.serviceWorker.register('/sw.js');
    } catch { return; }

    // Don't prompt if already granted or blocked
    if (Notification.permission === 'granted') {
      await subscribePush(false); // silent re-subscribe in case subscription expired
      return;
    }
    if (Notification.permission === 'denied') return;

    // Show banner only if user hasn't dismissed it in this session
    if (!sessionStorage.getItem('push_banner_dismissed')) {
      const banner = el('p-push-banner');
      if (banner) banner.classList.remove('hidden');
    }
  }

  async function enablePush() {
    el('p-push-banner')?.classList.add('hidden');
    await subscribePush(true);
  }

  function dismissPushBanner() {
    el('p-push-banner')?.classList.add('hidden');
    sessionStorage.setItem('push_banner_dismissed', '1');
  }

  async function subscribePush(requestPermission) {
    try {
      if (requestPermission) {
        const perm = await Notification.requestPermission();
        if (perm !== 'granted') return;
      }

      const reg = await navigator.serviceWorker.ready;

      // Get VAPID public key
      const keyResp = await fetch('/api/push/vapid-public-key');
      if (!keyResp.ok) return;
      const { publicKey } = await keyResp.json();
      if (!publicKey) return;

      const existing = await reg.pushManager.getSubscription();
      const subscription = existing || await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });

      // Register with server
      await api('POST', '/push/subscribe', {
        subscription: subscription.toJSON(),
        userAgent: getBrowserHint(),
      });
    } catch (err) {
      console.warn('[Portal] Push subscription failed:', err.message);
    }
  }

  function getBrowserHint() {
    const ua = navigator.userAgent;
    if (/Chrome\/(\d+)/.test(ua)) return `Chrome ${RegExp.$1}`;
    if (/Firefox\/(\d+)/.test(ua)) return `Firefox ${RegExp.$1}`;
    if (/Safari\/(\d+)/.test(ua) && !/Chrome/.test(ua)) return 'Safari';
    return 'Unknown';
  }

  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64  = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw     = atob(base64);
    return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
  }

  /* ---- Account / GDPR ---- */
  function loadAccount() {
    const link = document.getElementById('acc-data-export-link');
    if (link) link.href = `/api/portal/data-export?token=${encodeURIComponent(token)}`;
    loadApiKeys();
  }

  async function loadApiKeys() {
    const tbody = document.getElementById('acc-keys-tbody');
    if (!tbody) return;
    try {
      const data = await api('GET', '/portal/api-keys');
      const keys = data.keys || [];
      if (!keys.length) {
        tbody.innerHTML = '<tr><td colspan="6" class="p-empty">No API keys yet</td></tr>';
        return;
      }
      tbody.innerHTML = keys.map((k) => {
        const revoked  = !!k.revoked_at;
        const expired  = k.expires_at && new Date(k.expires_at) < new Date();
        const status   = revoked ? '<span style="color:#e74c3c">Revoked</span>' : expired ? '<span style="color:#e67e22">Expired</span>' : '<span style="color:#27ae60">Active</span>';
        const lastUsed = k.last_used_at ? new Date(k.last_used_at).toLocaleDateString() : 'Never';
        const expires  = k.expires_at ? new Date(k.expires_at).toLocaleDateString() : 'Never';
        const scopes   = (k.scopes || []).join(', ');
        const revokeBtn = (!revoked && !expired)
          ? `<button class="p-btn p-btn-secondary" style="padding:2px 8px;font-size:0.8rem" onclick="Portal.revokeApiKey('${k.id}')">Revoke</button>`
          : '';
        return `<tr>
          <td>${escHtml(k.name)}</td>
          <td><code>${escHtml(k.key_prefix)}…</code></td>
          <td style="font-size:0.8rem">${escHtml(scopes)}</td>
          <td>${lastUsed}</td>
          <td>${expires} ${status}</td>
          <td>${revokeBtn}</td>
        </tr>`;
      }).join('');
    } catch (err) {
      if (tbody) tbody.innerHTML = `<tr><td colspan="6" class="p-empty">Error: ${escHtml(err.message)}</td></tr>`;
    }
  }

  async function createApiKey() {
    const name = (prompt('API key name (e.g. "My Integration"):') || '').trim();
    if (!name) return;
    const scopeList = ['messages:read', 'messages:write', 'appointments:read', 'appointments:write', 'contacts:read'];
    const scopeInput = prompt(
      `Scopes (comma-separated):\n${scopeList.join('\n')}`,
      'messages:read'
    );
    if (scopeInput === null) return;
    const scopes = scopeInput.split(',').map((s) => s.trim()).filter(Boolean);
    const daysInput = prompt('Expiry in days (blank = never):', '');
    const expires_in_days = daysInput ? parseInt(daysInput) : undefined;
    try {
      const data = await api('POST', '/portal/api-keys', { name, scopes, expires_in_days });
      document.getElementById('acc-new-key-value').textContent = data.key || '';
      document.getElementById('acc-new-key-banner').style.display = 'block';
      loadApiKeys();
    } catch (err) { alert(`Error: ${err.message}`); }
  }

  function copyApiKey() {
    const val = document.getElementById('acc-new-key-value')?.textContent || '';
    navigator.clipboard?.writeText(val).catch(() => {});
  }

  async function revokeApiKey(id) {
    if (!confirm('Revoke this API key? Any apps using it will stop working.')) return;
    try {
      await api('DELETE', `/portal/api-keys/${id}`);
      loadApiKeys();
    } catch (err) { alert(`Error: ${err.message}`); }
  }

  async function changePassword() {
    const current = document.getElementById('acc-current-pw')?.value;
    const newPw   = document.getElementById('acc-new-pw')?.value;
    const confirm = document.getElementById('acc-confirm-pw')?.value;
    const msg     = document.getElementById('acc-pw-msg');
    if (!current || !newPw || !confirm) { if (msg) msg.textContent = 'All fields required.'; return; }
    if (newPw !== confirm) { if (msg) msg.textContent = 'Passwords do not match.'; return; }
    if (msg) msg.textContent = '';
    try {
      await api('POST', '/portal/me/password', { current_password: current, new_password: newPw });
      if (msg) { msg.style.color = 'var(--success, green)'; msg.textContent = 'Password updated.'; }
      ['acc-current-pw','acc-new-pw','acc-confirm-pw'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.value = '';
      });
    } catch (err) {
      if (msg) { msg.style.color = 'var(--danger, red)'; msg.textContent = err.message; }
    }
  }

  /* ---- Contacts ---- */
  async function loadContacts() {
    const container = document.getElementById('p-contacts-list');
    if (!container) return;
    container.innerHTML = '<p style="color:#888">Loading...</p>';
    try {
      const data = await api('GET', '/portal/contacts');
      const contacts = data.contacts || [];
      if (!contacts.length) {
        container.innerHTML = '<p class="p-empty">No contacts found.</p>';
        return;
      }
      container.innerHTML = contacts.map((c) => `
        <div style="border:1px solid ${c.is_oncall ? 'var(--p-primary,#1a3a5c)' : '#ddd'};border-radius:8px;padding:14px 16px;margin-bottom:10px;display:flex;flex-direction:column;gap:8px;max-width:600px;${c.is_oncall ? 'background:rgba(26,58,92,0.04)' : ''}">
          <div style="display:flex;align-items:center;gap:8px">
            <span style="font-weight:600;font-size:1rem">${escHtml(c.name)}</span>
            ${c.is_oncall ? '<span style="background:var(--p-primary,#1a3a5c);color:#fff;font-size:0.72rem;padding:1px 8px;border-radius:12px;font-weight:600">&#128222; ON CALL</span>' : ''}
            ${c.title ? `<span style="font-size:0.8rem;color:#888">${escHtml(c.title)}</span>` : ''}
          </div>
          <div style="font-size:0.85rem;color:#555">
            ${c.email ? `<a href="mailto:${encodeURIComponent(c.email)}" style="color:inherit">${escHtml(c.email)}</a>` : ''}
            ${c.phone ? ` &middot; ${escHtml(c.phone)}` : ''}
            ${c.mobile ? ` &middot; ${escHtml(c.mobile)} (mob)` : ''}
          </div>
          <div style="display:flex;gap:16px;flex-wrap:wrap;font-size:0.82rem;color:#555">
            <label><input type="checkbox" ${c.is_oncall ? 'checked' : ''} onchange="Portal.toggleOnCall('${c.id}', this.checked)"> <strong style="color:var(--p-primary,#1a3a5c)">On Call</strong></label>
            <label><input type="checkbox" ${c.notify_email ? 'checked' : ''} onchange="Portal.updateContactPref('${c.id}', 'notify_email', this.checked)"> Email</label>
            <label><input type="checkbox" ${c.notify_sms ? 'checked' : ''} onchange="Portal.updateContactPref('${c.id}', 'notify_sms', this.checked)"> SMS</label>
            <label><input type="checkbox" ${c.notify_whatsapp ? 'checked' : ''} onchange="Portal.updateContactPref('${c.id}', 'notify_whatsapp', this.checked)"> WhatsApp</label>
            <label><input type="checkbox" ${c.notify_phone ? 'checked' : ''} onchange="Portal.updateContactPref('${c.id}', 'notify_phone', this.checked)"> Phone Call</label>
          </div>
          ${c.on_call_note ? `<div style="font-size:0.8rem;color:#888;font-style:italic">&#128221; ${escHtml(c.on_call_note)}</div>` : ''}
          ${c.message_note ? `<div style="font-size:0.8rem;color:#27ae60;font-style:italic">&#128272; ${escHtml(c.message_note)}</div>` : ''}
        </div>
      `).join('');
    } catch (err) {
      container.innerHTML = `<p class="p-empty">Error: ${escHtml(err.message)}</p>`;
    }
  }

  async function updateContactPref(contactId, field, value) {
    try {
      await api('PUT', `/portal/contacts/${contactId}`, { [field]: value });
      const msg = `${field.replace('notify_', '')} notifications ${value ? 'enabled' : 'disabled'}`;
      toast(msg, 'success');
    } catch (err) {
      toast('Failed to update: ' + err.message, 'error');
    }
  }

  async function toggleOnCall(contactId, value) {
    try {
      await api('PUT', `/portal/contacts/${contactId}`, { is_oncall: value });
      toast(value ? 'Contact marked ON CALL' : 'On-call status removed', 'success');
      loadContacts();
    } catch (err) {
      toast('Failed to update on-call status: ' + err.message, 'error');
    }
  }

  /* ---- Contact self-service request ---- */
  function openContactRequest() {
    const form = el('p-contact-request-form');
    if (!form) return;
    form.style.display = 'block';
    ['p-cr-name', 'p-cr-phone', 'p-cr-email', 'p-cr-role'].forEach((id) => { const e = el(id); if (e) e.value = ''; });
    form.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function closeContactRequest() {
    const form = el('p-contact-request-form');
    if (form) form.style.display = 'none';
  }

  async function submitContactRequest() {
    const name  = el('p-cr-name')?.value.trim();
    const phone = el('p-cr-phone')?.value.trim();
    const email = el('p-cr-email')?.value.trim();
    const role  = el('p-cr-role')?.value.trim();
    if (!name) return toast('Please enter the contact\'s full name', 'error');
    const body = `Contact request:\nName: ${name}${phone ? `\nPhone: ${phone}` : ''}${email ? `\nEmail: ${email}` : ''}${role ? `\nRole: ${role}` : ''}`;
    try {
      await api('POST', '/portal/messages', { subject: 'New Contact Request', body, urgency: 'normal' });
      toast('Request submitted — our team will add the contact shortly', 'success');
      closeContactRequest();
    } catch (err) { toast(err.message, 'error'); }
  }

  /* ---- Appointments ---- */
  async function loadAppointments() {
    const tbody = document.getElementById('p-appts-tbody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="5" class="p-empty">Loading...</td></tr>';
    try {
      const data = await api('GET', '/portal/appointments');
      const appts = data.appointments || [];
      if (!appts.length) {
        tbody.innerHTML = '<tr><td colspan="5" class="p-empty">No appointments</td></tr>';
        return;
      }
      const statusColor = { scheduled: '#3498db', completed: '#27ae60', cancelled: '#e74c3c', no_show: '#e67e22' };
      tbody.innerHTML = appts.map((a) => `<tr>
        <td>${new Date(a.starts_at).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' })}</td>
        <td>${escHtml(a.title)}</td>
        <td>${a.duration_minutes || 30} min</td>
        <td><span style="color:${statusColor[a.status] || '#666'}">${a.status}</span></td>
        <td>${escHtml(a.notes || '')}</td>
        <td>${a.status === 'scheduled' ? `<button class="p-btn p-btn-sm" style="background:#e74c3c;color:#fff;border:none;cursor:pointer;padding:3px 10px;border-radius:4px;font-size:0.8rem" onclick="Portal.cancelAppointment('${a.id}', this)">Cancel</button>` : ''}</td>
      </tr>`).join('');
    } catch (err) {
      if (tbody) tbody.innerHTML = `<tr><td colspan="5" class="p-empty">Error: ${escHtml(err.message)}</td></tr>`;
    }
  }

  function openNewAppt() {
    const form = document.getElementById('p-new-appt-form');
    if (form) form.style.display = 'block';
  }

  function closeNewAppt() {
    const form = document.getElementById('p-new-appt-form');
    if (form) form.style.display = 'none';
  }

  async function saveNewAppt() {
    const title    = document.getElementById('p-appt-title')?.value?.trim();
    const starts   = document.getElementById('p-appt-starts')?.value;
    const duration = parseInt(document.getElementById('p-appt-duration')?.value || '30');
    const notes    = document.getElementById('p-appt-notes')?.value?.trim() || null;
    if (!title || !starts) { alert('Title and start time are required'); return; }
    try {
      await api('POST', '/portal/appointments', { title, starts_at: starts, duration_minutes: duration, notes });
      closeNewAppt();
      loadAppointments();
    } catch (err) { alert('Error: ' + err.message); }
  }

  async function cancelAppointment(id, btn) {
    if (!confirm('Cancel this appointment?')) return;
    btn.disabled = true;
    try {
      await api('DELETE', `/portal/appointments/${id}`);
      loadAppointments();
    } catch (err) { alert('Error: ' + err.message); btn.disabled = false; }
  }

  /* ---- Knowledge Base ---- */
  let _kbArticles = [];

  async function loadKnowledge() {
    const list = document.getElementById('p-kb-list');
    if (!list) return;
    list.innerHTML = '<p style="color:#888">Loading...</p>';
    try {
      const data = await api('GET', '/portal/knowledge');
      _kbArticles = data.articles || [];
      renderKbList(_kbArticles);
    } catch (err) {
      list.innerHTML = `<p class="p-empty">Error: ${escHtml(err.message)}</p>`;
    }
  }

  function renderKbList(articles) {
    const list = document.getElementById('p-kb-list');
    if (!list) return;
    const articleEl = document.getElementById('p-kb-article');
    if (articleEl) articleEl.style.display = 'none';
    if (!articles.length) {
      list.innerHTML = '<p class="p-empty">No articles available</p>';
      return;
    }
    list.innerHTML = articles.map((a) => `
      <div onclick="Portal.openArticle('${a.id}')"
           style="padding:14px 16px;border:1px solid #ddd;border-radius:8px;margin-bottom:8px;cursor:pointer;max-width:640px">
        <div style="font-weight:600;font-size:0.95rem">${escHtml(a.title)}</div>
        ${a.category ? `<div style="font-size:0.78rem;color:#888;margin-top:2px">${escHtml(a.category)}</div>` : ''}
        ${a.summary ? `<div style="font-size:0.82rem;color:#555;margin-top:4px">${escHtml(a.summary)}</div>` : ''}
      </div>
    `).join('');
  }

  function searchKnowledge() {
    const q = (document.getElementById('p-kb-search')?.value || '').toLowerCase();
    if (!q) { renderKbList(_kbArticles); return; }
    renderKbList(_kbArticles.filter((a) =>
      (a.title || '').toLowerCase().includes(q) ||
      (a.summary || '').toLowerCase().includes(q) ||
      (a.category || '').toLowerCase().includes(q)
    ));
  }

  async function openArticle(id) {
    const list = document.getElementById('p-kb-list');
    const article = document.getElementById('p-kb-article');
    if (!article) return;
    if (list) list.style.display = 'none';
    article.style.display = 'block';
    document.getElementById('p-kb-article-title').textContent = 'Loading...';
    document.getElementById('p-kb-article-body').textContent  = '';
    try {
      const data = await api('GET', `/portal/knowledge/${id}`);
      const a = data.article;
      document.getElementById('p-kb-article-title').textContent = a.title || '';
      document.getElementById('p-kb-article-meta').textContent  =
        `${a.category ? a.category + ' · ' : ''}Updated ${new Date(a.updated_at || a.created_at).toLocaleDateString('en-GB')}`;
      document.getElementById('p-kb-article-body').textContent  = a.content || '';
      // Helpfulness rating
      const rateWrap = document.getElementById('p-kb-rate-wrap');
      if (rateWrap) {
        rateWrap.dataset.articleId = id;
        rateWrap.dataset.voted = '';
        rateWrap.querySelector('.p-kb-helpful-count').textContent = a.helpful_count || 0;
        rateWrap.querySelector('.p-kb-nothelpful-count').textContent = a.not_helpful_count || 0;
      }
    } catch (err) {
      document.getElementById('p-kb-article-body').textContent = 'Error loading article.';
    }
  }

  async function rateArticle(helpful) {
    const wrap = document.getElementById('p-kb-rate-wrap');
    if (!wrap || wrap.dataset.voted) return;
    const id = wrap.dataset.articleId;
    if (!id) return;
    wrap.dataset.voted = '1';
    try {
      const data = await api('POST', `/portal/knowledge/${id}/rate`, { helpful });
      wrap.querySelector('.p-kb-helpful-count').textContent = data.article.helpful_count;
      wrap.querySelector('.p-kb-nothelpful-count').textContent = data.article.not_helpful_count;
      toast(helpful ? 'Thanks for the feedback!' : 'Feedback recorded', 'success');
    } catch (err) {
      wrap.dataset.voted = '';
      toast(err.message, 'error');
    }
  }

  function closeArticle() {
    const list = document.getElementById('p-kb-list');
    const article = document.getElementById('p-kb-article');
    if (list) list.style.display = 'block';
    if (article) article.style.display = 'none';
  }

  /* ---- Files ---- */
  /* ---- Message Replies ---- */
  async function toggleMsgReplies(msgId, btn) {
    const container = document.getElementById(`msg-replies-${msgId}`);
    if (!container) return;
    if (container.style.display !== 'none') {
      container.style.display = 'none';
      return;
    }
    container.style.display = 'block';
    // Mark as portal-read (fire-and-forget)
    api('PATCH', `/portal/messages/${msgId}/mark-read`, {}).catch(() => {});
    await loadMsgReplies(msgId, container);
  }

  async function loadMsgReplies(msgId, container) {
    if (!container) container = document.getElementById(`msg-replies-${msgId}`);
    if (!container) return;
    container.innerHTML = 'Loading...';
    try {
      const data = await api('GET', `/portal/messages/${msgId}/replies`);
      const replies = data.replies || [];
      const replyHtml = replies.length
        ? replies.map((r) => {
            const isUs = !!r.portal_user_name;
            return `<div style="margin-bottom:8px;padding-bottom:8px;border-bottom:1px solid rgba(0,0,0,0.06);${isUs ? 'padding-left:12px;border-left:2px solid var(--p-primary,#1a3a5c)' : ''}">
              <div style="font-size:0.75rem;color:var(--p-text-muted,#888);margin-bottom:2px">
                <strong>${escHtml(isUs ? r.portal_user_name : (r.operator_name || 'Our team'))}</strong>
                ${isUs ? '<span style="font-size:0.7rem;color:#888"> (you)</span>' : ''}
                &middot; ${new Date(r.created_at).toLocaleString()}
              </div>
              <div style="white-space:pre-wrap;font-size:0.85rem">${escHtml(r.body)}</div>
            </div>`;
          }).join('')
        : '<p style="color:var(--p-text-muted,#888);font-size:0.82rem;margin:0 0 8px">No replies yet — our team will respond shortly.</p>';

      container.innerHTML = replyHtml +
        `<div style="display:flex;gap:6px;margin-top:8px">
          <textarea id="pr-input-${msgId}" rows="2" placeholder="Add a reply..." class="p-input" style="flex:1;resize:vertical;font-size:0.82rem"></textarea>
          <button class="p-btn p-btn-sm p-btn-primary" style="align-self:flex-end" onclick="Portal.sendPortalReply('${msgId}')">Send</button>
        </div>`;
    } catch (err) {
      container.innerHTML = `<span style="color:#e74c3c">Error: ${escHtml(err.message)}</span>`;
    }
  }

  async function sendPortalReply(msgId) {
    const input = document.getElementById(`pr-input-${msgId}`);
    const body = input?.value?.trim();
    if (!body) return;
    try {
      await api('POST', `/portal/messages/${msgId}/replies`, { body });
      const container = document.getElementById(`msg-replies-${msgId}`);
      await loadMsgReplies(msgId, container);
    } catch (err) { toast(err.message, 'error'); }
  }

  async function loadFiles() {
    const tbody = document.getElementById('p-files-tbody');
    const countEl = document.getElementById('p-files-count');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="6" class="p-empty">Loading...</td></tr>';
    try {
      const data = await api('GET', '/portal/files');
      const files = data.files || [];
      if (countEl) countEl.textContent = `${files.length} file${files.length !== 1 ? 's' : ''}`;
      if (!files.length) {
        tbody.innerHTML = '<tr><td colspan="6" class="p-empty">No files shared yet</td></tr>';
        return;
      }
      tbody.innerHTML = files.map((f) => `
        <tr>
          <td><strong>${escHtml(f.original_name)}</strong></td>
          <td style="font-size:0.8rem;color:#888">${escHtml(f.mime_type || '—')}</td>
          <td style="font-size:0.8rem;white-space:nowrap">${f.size_bytes ? formatFileSize(f.size_bytes) : '—'}</td>
          <td style="font-size:0.82rem">${f.description ? escHtml(f.description) : '<span style="color:#aaa">—</span>'}</td>
          <td style="font-size:0.8rem;white-space:nowrap">${new Date(f.created_at).toLocaleDateString()}</td>
          <td><a href="/api/portal/files/${encodeURIComponent(f.id)}/download"
                 class="p-btn p-btn-sm p-btn-secondary"
                 style="text-decoration:none;padding:4px 10px;font-size:0.8rem"
                 download="${escHtml(f.original_name)}">&#11167; Download</a></td>
        </tr>
      `).join('');
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="6" class="p-empty">Error: ${escHtml(err.message)}</td></tr>`;
    }
  }

  function formatFileSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  document.addEventListener('DOMContentLoaded', init);

  return {
    nav, logout, loadMessages, onMsgSearch, msgPage, openComposeMessage, closeComposeMessage, sendPortalMessage, acknowledgeMessage, rateMessage,
    loadCalls, loadBilling, loadAvailability, setAvailability, saveAvailNote, downloadReport,
    toggleMobileNav, enablePush, dismissPushBanner,
    loadAccount, changePassword, createApiKey, copyApiKey, revokeApiKey,
    showForgot, showLogin, doForgot, doReset,
    // Contacts
    loadContacts, updateContactPref, toggleOnCall, openContactRequest, closeContactRequest, submitContactRequest,
    // Appointments
    loadAppointments, openNewAppt, closeNewAppt, saveNewAppt, cancelAppointment,
    // Knowledge
    loadKnowledge, searchKnowledge, openArticle, closeArticle, rateArticle,
    // Files
    loadFiles,
    // Replies
    toggleMsgReplies, sendPortalReply,
    // Realtime
    dismissLiveToast,
  };
})();
