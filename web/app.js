/* ============================================================
   SinglePoint Calls — Operator Console Application
   ============================================================ */

'use strict';

const App = (() => {

  /* ---- State ---- */
  let token = localStorage.getItem('as_token');
  let currentOperator = null;
  let socket = null;
  let clients = [];

  // Pending 2FA token (between login phases)
  let pendingTwoFAToken = null;

  // Active call state
  let activeCall = null;
  let activeCallStart = null;
  let timerInterval = null;
  let callOnHold = false;

  // Post-call mandatory message tracking
  // Set when a call ends so the form can reference the correct call_log
  let _pendingMsgCallLogId   = null;
  let _pendingMsgClientId    = null;
  let _pendingMsgMessageDone = false;

  /* ---- DOM Helpers ---- */
  const el = (id) => document.getElementById(id);
  const show = (id) => { const e = el(id); if (e) e.style.display = ''; };
  const hide = (id) => { const e = el(id); if (e) e.style.display = 'none'; };

  /* ---- API ---- */
  async function api(method, path, body) {
    const opts = {
      method,
      headers: { 'Content-Type': 'application/json' },
    };
    if (token) opts.headers['Authorization'] = `Bearer ${token}`;
    if (body) opts.body = JSON.stringify(body);

    const res = await fetch(`/api${path}`, opts);
    if (res.status === 401) { logout(); return null; }
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || 'Request failed');
    }
    return res.json();
  }

  /* ---- Toast ---- */
  function toast(message, type = 'info', duration = 4000) {
    const container = el('toast-container');
    const t = document.createElement('div');
    t.className = `toast ${type}`;
    t.textContent = message;
    container.appendChild(t);
    setTimeout(() => t.remove(), duration);
  }

  /* ---- Auth ---- */
  async function init() {
    el('login-form').addEventListener('submit', handleLogin);
    el('message-form').addEventListener('submit', (e) => {
      e.preventDefault();
      submitMessage(true);
    });

    if (token) {
      try {
        const data = await api('GET', '/auth/me');
        if (data) {
          currentOperator = data.operator;
          showConsole();
        } else {
          showLogin();
        }
      } catch {
        showLogin();
      }
    } else {
      showLogin();
    }
  }

  async function handleLogin(e) {
    e.preventDefault();
    const username = el('username').value.trim();
    const password = el('password').value;
    const errorEl = el('login-error');
    errorEl.classList.add('hidden');

    try {
      const data = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      }).then((r) => r.json());

      if (data.requires_2fa) {
        pendingTwoFAToken = data.temp_token;
        el('totp-input').value = '';
        el('twofa-error').classList.add('hidden');
        el('twofa-modal').style.display = 'flex';
        setTimeout(() => el('totp-input').focus(), 100);
        return;
      }
      if (!data.token) throw new Error(data.error || 'Login failed');
      _finishLogin(data);
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.classList.remove('hidden');
    }
  }

  let usingBackupCode = false;

  function showBackupCodeEntry(e) {
    if (e) e.preventDefault();
    usingBackupCode = !usingBackupCode;
    const row = el('backup-code-row');
    const totpInput = el('totp-input');
    if (row) row.style.display = usingBackupCode ? 'block' : 'none';
    if (totpInput) totpInput.style.display = usingBackupCode ? 'none' : '';
  }

  async function verify2FA() {
    const errorEl = el('twofa-error');
    errorEl.classList.add('hidden');
    if (!pendingTwoFAToken) return;

    if (usingBackupCode) {
      const code = el('backup-code-input')?.value?.trim().replace(/-/g, '').toUpperCase();
      if (!code) return;
      try {
        const data = await fetch('/api/auth/2fa/backup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ temp_token: pendingTwoFAToken, backup_code: code }),
        }).then((r) => r.json());
        if (!data.token) throw new Error(data.error || 'Invalid backup code');
        pendingTwoFAToken = null;
        usingBackupCode = false;
        el('twofa-modal').style.display = 'none';
        _finishLogin(data);
        if (data.remaining_backup_codes <= 2) {
          toast(`Warning: only ${data.remaining_backup_codes} backup code(s) remaining`, 'warning');
        }
      } catch (err) {
        errorEl.textContent = err.message;
        errorEl.classList.remove('hidden');
      }
      return;
    }

    const code = el('totp-input').value.trim();
    if (!code) return;
    try {
      const data = await fetch('/api/auth/verify-2fa', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ temp_token: pendingTwoFAToken, totp_code: code }),
      }).then((r) => r.json());
      if (!data.token) throw new Error(data.error || 'Verification failed');
      pendingTwoFAToken = null;
      el('twofa-modal').style.display = 'none';
      _finishLogin(data);
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.classList.remove('hidden');
    }
  }

  function cancel2FA() {
    pendingTwoFAToken = null;
    usingBackupCode = false;
    const row = el('backup-code-row');
    if (row) row.style.display = 'none';
    const totpInput = el('totp-input');
    if (totpInput) totpInput.style.display = '';
    el('twofa-modal').style.display = 'none';
  }

  function showForgotPassword(e) {
    if (e) e.preventDefault();
    el('login-form').style.display = 'none';
    el('reset-step').style.display = 'none';
    el('forgot-step').style.display = 'block';
    setTimeout(() => { const u = el('forgot-username'); if (u) u.focus(); }, 80);
  }

  function showLogin() {
    el('forgot-step').style.display = 'none';
    el('reset-step').style.display = 'none';
    el('login-form').style.display = 'block';
    el('login-error').classList.add('hidden');
    setTimeout(() => { const u = el('username'); if (u) u.focus(); }, 80);
  }

  async function doForgotPassword() {
    const username = (el('forgot-username')?.value || '').trim();
    const errEl = el('forgot-error');
    const okEl  = el('forgot-success');
    errEl.classList.add('hidden');
    okEl.classList.add('hidden');
    if (!username) { errEl.textContent = 'Enter your username'; errEl.classList.remove('hidden'); return; }
    try {
      const r = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username }),
      }).then((res) => res.json());
      if (r.error) throw new Error(r.error);
      okEl.textContent = 'If that username exists, a reset link has been sent to the associated email address.';
      okEl.classList.remove('hidden');
    } catch (err) {
      errEl.textContent = err.message;
      errEl.classList.remove('hidden');
    }
  }

  async function doResetPassword() {
    const token_  = (el('reset-token')?.value || '').trim();
    const username = (el('reset-username')?.value || '').trim();
    const newPw   = el('reset-password')?.value || '';
    const errEl   = el('reset-error');
    const okEl    = el('reset-success');
    errEl.classList.add('hidden');
    okEl.classList.add('hidden');
    if (!token_ || !username || !newPw) {
      errEl.textContent = 'All fields are required'; errEl.classList.remove('hidden'); return;
    }
    try {
      const r = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: token_, username, new_password: newPw }),
      }).then((res) => res.json());
      if (r.error) throw new Error(r.error);
      okEl.textContent = 'Password reset! You can now sign in.';
      okEl.classList.remove('hidden');
      setTimeout(showLogin, 2000);
    } catch (err) {
      errEl.textContent = err.message;
      errEl.classList.remove('hidden');
    }
  }

  function _finishLogin(data) {
    token = data.token;
    currentOperator = data.operator;
    localStorage.setItem('as_token', token);
    showConsole();
  }

  function logout() {
    token = null;
    currentOperator = null;
    localStorage.removeItem('as_token');
    if (socket) { socket.disconnect(); socket = null; }
    showLogin();
  }

  /* ---- Screen management ---- */
  function showLogin() {
    el('login-screen').classList.add('active');
    el('console-screen').classList.remove('active');
  }

  function showConsole() {
    el('login-screen').classList.remove('active');
    el('console-screen').classList.add('active');
    el('operator-name').textContent = currentOperator.username;

    if (currentOperator.role === 'admin' || currentOperator.role === 'supervisor') {
      el('admin-tab').style.display = '';
      const demoBtn = el('demo-btn');
      const portalBtn = el('portal-link-btn');
      const noticeBtn = el('notice-add-btn');
      if (demoBtn) demoBtn.style.display = '';
      if (portalBtn) portalBtn.style.display = '';
      if (noticeBtn) noticeBtn.style.display = '';
    }

    connectSocket();
    loadClients();
    loadMessages();
    Tasks.load();
    loadNoticeboard();
    loadFollowUps();

    // Restore dark mode preference
    if (localStorage.getItem('as_darkmode') === '1') {
      document.documentElement.setAttribute('data-theme', 'dark');
      const btn = el('dark-mode-btn');
      if (btn) btn.title = 'Switch to light mode';
    }

    // Show wallboard tab for admin/supervisor
    if (currentOperator.role === 'admin' || currentOperator.role === 'supervisor') {
      const wbTab = el('wallboard-tab');
      if (wbTab) wbTab.style.display = '';
    }

    // Keyboard shortcuts
    document.addEventListener('keydown', handleKeyboardShortcut);

    // Refresh active calls list every 30s for supervisor monitoring buttons
    if (currentOperator.role === 'admin' || currentOperator.role === 'supervisor') {
      refreshActiveCalls();
      setInterval(refreshActiveCalls, 30000);
    }

    // Load canned responses for autocomplete
    loadCannedResponsesForAutocomplete();

    // Mobile: initialise panel state and show sidebar by default
    mobileSwitchPanel('sidebar');

    // Push notifications: show prompt if not yet decided
    initPushPrompt();
  }

  /* ---- Demo Mode ---- */
  function startDemo() {
    const demoClients = clients;
    const client = demoClients[0] || {
      id: null, name: 'Demo Company Ltd', greeting: 'Thank you for calling Demo Company.',
      script: 'Take a message and advise the caller that someone will be in touch shortly.',
    };
    const demoCall = {
      channelId: `demo-${Date.now()}`,
      callerIdNum: '+447700900123',
      callerIdName: 'John Smith',
      did: '+441234567890',
      client,
      isVip: false,
      isIgnored: false,
    };
    toast('Demo mode: Simulating incoming call', 'info', 3000);
    handleCallRinging(demoCall);
  }

  /* ---- My Profile ---- */
  async function showMyProfile() {
    if (!currentOperator) return;
    el('profile-info').innerHTML =
      `Logged in as <strong>${escHtml(currentOperator.username)}</strong> &bull; Role: <strong>${escHtml(currentOperator.role)}</strong>`;
    el('pf-current-pw').value = '';
    el('pf-new-pw').value = '';
    el('pw-strength-bar').style.display = 'none';
    el('pw-strength-fill').style.width = '0';

    const tfaStatus = el('twofa-status');
    if (tfaStatus) {
      if (currentOperator.totp_enabled) {
        tfaStatus.innerHTML = `
          <p style="font-size:0.85rem;color:var(--success);margin-bottom:10px">&#10003; 2FA is enabled on your account.</p>
          <button class="btn btn-sm btn-danger" onclick="App.disable2FA()">Disable 2FA</button>`;
      } else {
        tfaStatus.innerHTML = `
          <p style="font-size:0.85rem;color:var(--text-muted);margin-bottom:10px">2FA is not enabled on your account.</p>
          <button class="btn btn-sm btn-secondary" onclick="App.setup2FA()">Enable 2FA</button>`;
      }
    }
    // Load notification preferences from server
    try {
      const data = await api('GET', '/auth/me');
      const op = data.operator || {};
      const setCheck = (id, val) => { const e = el(id); if (e) e.checked = !!val; };
      setCheck('pf-notify-message',   op.notify_new_message);
      setCheck('pf-notify-missed',    op.notify_missed_call);
      setCheck('pf-notify-sla',       op.notify_sla_breach);
      setCheck('pf-notify-escalation', op.notify_escalation);
    } catch { /* ignore — toggles just stay unchecked */ }
    el('profile-modal').style.display = 'flex';
  }

  async function saveNotificationPrefs() {
    try {
      await api('PATCH', '/operators/me/notifications', {
        notify_new_message: !!(el('pf-notify-message')?.checked),
        notify_missed_call: !!(el('pf-notify-missed')?.checked),
        notify_sla_breach:  !!(el('pf-notify-sla')?.checked),
        notify_escalation:  !!(el('pf-notify-escalation')?.checked),
      });
      toast('Notification preferences saved', 'success');
    } catch (err) {
      toast(`Error: ${err.message}`, 'danger');
    }
  }

  function closeProfile() {
    el('profile-modal').style.display = 'none';
  }

  function showPwStrength(value) {
    const bar = el('pw-strength-bar');
    const fill = el('pw-strength-fill');
    const label = el('pw-strength-label');
    if (!bar || !fill) return;
    if (!value) { bar.style.display = 'none'; return; }
    bar.style.display = '';
    let score = 0;
    if (value.length >= 12) score++;
    if (/[A-Z]/.test(value)) score++;
    if (/[a-z]/.test(value)) score++;
    if (/[0-9]/.test(value)) score++;
    if (/[^A-Za-z0-9]/.test(value)) score++;
    const pct = (score / 5) * 100;
    fill.style.width = `${pct}%`;
    const levels = ['', 'pw-weak', 'pw-weak', 'pw-fair', 'pw-good', 'pw-strong'];
    const labelText = ['', 'Weak', 'Weak', 'Fair', 'Good', 'Strong'];
    fill.className = `pw-strength-fill ${levels[score] || ''}`;
    if (label) label.textContent = labelText[score] || '';
  }

  async function changePassword() {
    const currentPw = el('pf-current-pw').value;
    const newPw = el('pf-new-pw').value;
    if (!currentPw || !newPw) { toast('Both password fields are required', 'warning'); return; }
    try {
      await api('PUT', '/operators/me/password', { current_password: currentPw, new_password: newPw });
      toast('Password changed successfully', 'success');
      el('pf-current-pw').value = '';
      el('pf-new-pw').value = '';
      el('pw-strength-bar').style.display = 'none';
    } catch (err) {
      toast(`Error: ${err.message}`, 'danger');
    }
  }

  /* ---- 2FA Setup ---- */
  async function setup2FA() {
    try {
      const data = await api('GET', '/auth/2fa/setup');
      if (!data) return;
      el('twofa-qr').src = data.qr_code;
      el('twofa-secret').textContent = data.secret;
      el('twofa-confirm-code').value = '';
      el('twofa-setup-error').classList.add('hidden');
      el('profile-modal').style.display = 'none';
      el('twofa-setup-modal').style.display = 'flex';
    } catch (err) {
      toast(`Error: ${err.message}`, 'danger');
    }
  }

  let _backupCodes = [];

  async function confirm2FA() {
    const code = el('twofa-confirm-code').value.trim();
    const errorEl = el('twofa-setup-error');
    errorEl.classList.add('hidden');
    if (!code) return;
    try {
      const data = await api('POST', '/auth/2fa/confirm', { totp_code: code });
      currentOperator.totp_enabled = true;
      _backupCodes = data.backup_codes || [];

      if (_backupCodes.length) {
        const grid = el('twofa-backup-grid');
        if (grid) grid.innerHTML = _backupCodes.map((c) => `<span>${c}</span>`).join('');
        const backupDiv = el('twofa-backup-codes');
        if (backupDiv) backupDiv.style.display = 'block';
        const enableBtn = el('twofa-enable-btn');
        if (enableBtn) { enableBtn.textContent = 'Done'; enableBtn.onclick = close2FASetup; }
      } else {
        toast('2FA enabled successfully', 'success');
        el('twofa-setup-modal').style.display = 'none';
      }
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.classList.remove('hidden');
    }
  }

  function copyBackupCodes() {
    if (_backupCodes.length) {
      navigator.clipboard.writeText(_backupCodes.join('\n')).then(
        () => toast('Backup codes copied', 'success'),
        () => toast('Copy failed — please copy manually', 'warning')
      );
    }
  }

  function close2FASetup() {
    el('twofa-setup-modal').style.display = 'none';
  }

  async function disable2FA() {
    const pw = prompt('Enter your current password to disable 2FA:');
    if (!pw) return;
    try {
      await api('DELETE', '/auth/2fa', { password: pw });
      toast('2FA disabled', 'success');
      currentOperator.totp_enabled = false;
      closeProfile();
    } catch (err) {
      toast(`Error: ${err.message}`, 'danger');
    }
  }

  let wallboardInterval = null;

  function switchView(view) {
    document.querySelectorAll('.nav-tab').forEach((t) => t.classList.remove('active'));
    el('view-console').style.display = 'none';
    const adminView = el('view-admin');
    if (adminView) adminView.style.display = 'none';
    const wbView = el('view-wallboard');
    if (wbView) wbView.style.display = 'none';

    // Stop wallboard refresh when leaving that view
    if (wallboardInterval) { clearInterval(wallboardInterval); wallboardInterval = null; }

    if (view === 'console') {
      el('view-console').style.display = '';
      document.querySelectorAll('.nav-tab')[0].classList.add('active');
    } else if (view === 'wallboard') {
      if (wbView) wbView.style.display = '';
      const wbTab = el('wallboard-tab');
      if (wbTab) wbTab.classList.add('active');
      loadWallboard();
      wallboardInterval = setInterval(loadWallboard, 30000);
    } else {
      if (adminView) adminView.style.display = 'flex';
      el('admin-tab').classList.add('active');
      Admin.init();
    }
  }

  /* ---- Socket.io ---- */
  function connectSocket() {
    if (socket) socket.disconnect();
    socket = io({ auth: { token } });

    socket.on('connect', () => toast('Connected to live call stream', 'success', 2000));
    socket.on('disconnect', () => toast('Disconnected — reconnecting...', 'warning'));

    socket.on('call:ringing', handleCallRinging);
    socket.on('call:answered', handleCallAnswered);
    socket.on('call:ended', handleCallEnded);
    socket.on('call:transferred', (data) => {
      if (activeCall?.channelId === data.channelId) clearActiveCall();
      toast('Call transferred', 'info');
    });
    socket.on('call:held', (data) => {
      if (activeCall?.channelId === data.channelId) {
        callOnHold = true;
        const btn = el('btn-hold');
        if (btn) { btn.textContent = 'Unhold'; btn.classList.add('btn-hold-active'); }
      }
    });
    socket.on('call:unheld', (data) => {
      if (activeCall?.channelId === data.channelId) {
        callOnHold = false;
        const btn = el('btn-hold');
        if (btn) { btn.textContent = 'Hold'; btn.classList.remove('btn-hold-active'); }
      }
    });
    socket.on('operators:list', (data) => renderOperators(data.operators));
    socket.on('message:new', () => loadMessages());
    socket.on('chat:message', (msg) => appendChatMessage(msg));
    socket.on('operator:status_change', () => {}); // wallboard handles its own polling
    socket.on('client:availability', (data) => {
      // Update active call panel if it's for the current call's client
      if (activeCall?.client?.id === data.client_id) {
        renderAvailabilityInline(data.availability);
      }
    });
  }

  /* ---- Call Queue ---- */
  const callQueue = new Map();

  function handleCallRinging(data) {
    callQueue.set(data.channelId, data);
    renderCallQueue();
    toast(`Incoming call${data.client ? ` — ${data.client.name}` : ''}: ${data.callerIdNum}`, 'warning', 8000);
    el('status-badge').className = 'status-badge ringing';
    el('status-badge').textContent = 'RINGING';
  }

  function handleCallAnswered(data) {
    if (callQueue.has(data.channelId)) {
      callQueue.delete(data.channelId);
      renderCallQueue();
    }
    if (activeCall?.channelId === data.channelId) {
      el('status-badge').className = 'status-badge busy';
      el('status-badge').textContent = 'ON CALL';
      if (socket) socket.emit('operator:busy');
    } else if (callQueue.size === 0) {
      el('status-badge').className = 'status-badge ready';
      el('status-badge').textContent = 'READY';
    }
  }

  function handleCallEnded(data) {
    callQueue.delete(data.channelId);
    renderCallQueue();
    if (activeCall?.channelId === data.channelId) {
      // Save call context before clearing — message form must reference it
      const callLogId  = activeCall.callLogId;
      const clientId   = activeCall.client?.id || null;
      const callerNum  = activeCall.callerIdNum || '';
      const callerName = activeCall.callerIdName || '';
      clearActiveCall();
      if (callLogId) {
        // Pre-fill message form with call context so it's ready immediately
        _pendingMsgCallLogId  = callLogId;
        _pendingMsgClientId   = clientId;
        _pendingMsgMessageDone = false;
        if (clientId) { el('msg-client').value = clientId; onClientChange(); }
        el('msg-caller-phone').value = callerNum;
        el('msg-caller-name').value  = callerName;
        showCallerIdHint(callerNum);
        _showMandatoryMessageBanner();
        showDispositionModal(callLogId);
        // On mobile: switch to message form
        if (window.innerWidth <= 768) mobileSwitchPanel('content');
      } else {
        toast('Call ended', 'info');
      }
    }
    if (callQueue.size === 0) {
      el('status-badge').className = 'status-badge ready';
      el('status-badge').textContent = 'READY';
      if (socket) socket.emit('operator:ready');
    }
  }

  function renderCallQueue() {
    const container = el('call-queue');
    const badge = el('queue-count');
    badge.textContent = callQueue.size;

    if (callQueue.size === 0) {
      container.innerHTML = '<p class="empty-state">No calls waiting</p>';
      return;
    }

    container.innerHTML = '';
    for (const [channelId, call] of callQueue.entries()) {
      const vipBadge = call.isVip ? '<span class="vip-badge">&#11088; VIP</span>' : '';
      const ignoreBadge = call.isIgnored ? '<span class="ignore-badge">Ignored</span>' : '';
      const item = document.createElement('div');
      item.className = 'call-item ringing';
      item.innerHTML = `
        <div class="call-item-caller">${escHtml(call.callerIdName || call.callerIdNum)} ${vipBadge}${ignoreBadge}</div>
        ${call.callerIdName ? `<div class="call-item-did">${escHtml(call.callerIdNum)}</div>` : ''}
        <div class="call-item-client">${call.client ? escHtml(call.client.name) : 'Unknown Client'}</div>
        <div class="call-item-time">${formatTime(new Date())}</div>
        <div class="call-item-actions">
          <button class="btn btn-primary btn-sm" onclick="App.pickupCall('${channelId}')">Answer</button>
          <button class="btn btn-sm btn-secondary" onclick="App.viewScript('${channelId}')">Script</button>
        </div>
      `;
      container.appendChild(item);
    }
  }

  function pickupCall(channelId) {
    const call = callQueue.get(channelId);
    if (!call) return;

    const ext = prompt('Your SIP extension (e.g. 1001):');
    if (!ext) return;

    api('POST', `/callcontrol/${channelId}/answer`, { extension: ext })
      .then(() => {
        activeCall = call;
        activeCallStart = new Date();
        showActiveCallPanel(call);
        viewScript(channelId);
        prefillMessageForm(call);
        // On mobile: auto-switch to message form panel when call is answered
        mobileAutoSwitchOnCall();
        // Load client availability
        if (call.client) loadCallAvailability(call.client.id);
      })
      .catch((err) => toast(`Failed to answer: ${err.message}`, 'danger'));
  }

  async function loadCallAvailability(clientId) {
    try {
      const data = await api('GET', `/clients/${clientId}/availability`);
      if (data) renderAvailabilityInline(data.availability);
    } catch { /* silent */ }
  }

  function renderAvailabilityInline(avail) {
    const bar = el('ac-availability');
    if (!bar || !avail) return;
    const labels = {
      available: { text: 'Available', cls: 'avail-available' },
      out_of_office: { text: 'Out of Office', cls: 'avail-out' },
      annual_leave: { text: 'Annual Leave', cls: 'avail-leave' },
      meeting: { text: 'In a Meeting', cls: 'avail-meeting' },
      closed: { text: 'Closed', cls: 'avail-closed' },
    };
    const info = labels[avail.status] || labels.available;
    bar.className = `avail-badge-inline ${info.cls}`;
    bar.textContent = info.text + (avail.note ? ` — ${avail.note}` : '');
    bar.style.display = '';
  }

  function showActiveCallPanel(call) {
    el('active-call-panel').style.display = '';
    el('ac-caller-name').textContent = call.callerIdName || call.callerIdNum;
    el('ac-caller-phone').textContent = call.callerIdName ? call.callerIdNum : '';
    el('ac-client-name').textContent = call.client ? call.client.name : 'Unknown Client';

    if (timerInterval) clearInterval(timerInterval);
    timerInterval = setInterval(() => {
      const secs = Math.floor((Date.now() - activeCallStart.getTime()) / 1000);
      el('call-timer').textContent = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
    }, 1000);
  }

  function clearActiveCall() {
    activeCall = null;
    activeCallStart = null;
    callOnHold = false;
    const btnHold = el('btn-hold');
    if (btnHold) { btnHold.textContent = 'Hold'; btnHold.classList.remove('btn-hold-active'); }
    if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
    el('active-call-panel').style.display = 'none';
    el('call-timer').textContent = '0:00';
    el('status-badge').className = 'status-badge ready';
    el('status-badge').textContent = 'READY';
    el('script-panel').style.display = 'none';
    const acAvail = el('ac-availability');
    if (acAvail) acAvail.style.display = 'none';
    if (socket) socket.emit('operator:ready');
  }

  function hangup() {
    if (!activeCall) return;
    api('POST', `/callcontrol/${activeCall.channelId}/hangup`, {})
      .catch((err) => toast(`Hangup failed: ${err.message}`, 'danger'));
  }

  function toggleHold() {
    if (!activeCall) return;
    const action = callOnHold ? 'unhold' : 'hold';
    api('POST', `/callcontrol/${activeCall.channelId}/${action}`, {})
      .then(() => {
        callOnHold = !callOnHold;
        const btn = el('btn-hold');
        btn.textContent = callOnHold ? 'Unhold' : 'Hold';
        btn.classList.toggle('btn-hold-active', callOnHold);
        toast(callOnHold ? 'Caller placed on hold' : 'Call resumed', 'info', 2500);
      })
      .catch((err) => toast(`Hold failed: ${err.message}`, 'danger'));
  }

  function showTransfer() {
    el('transfer-panel').classList.toggle('hidden');
  }

  function transfer() {
    if (!activeCall) return;
    const ext = el('transfer-ext').value.trim();
    if (!ext) return;
    api('POST', `/callcontrol/${activeCall.channelId}/transfer`, { extension: ext })
      .then(() => { clearActiveCall(); toast(`Transferred to ${ext}`, 'success'); })
      .catch((err) => toast(`Transfer failed: ${err.message}`, 'danger'));
  }

  function viewScript(channelId) {
    const call = callQueue.get(channelId) || (activeCall?.channelId === channelId ? activeCall : null);
    if (!call || !call.client) { hide('script-panel'); return; }

    el('script-panel').style.display = '';
    el('script-client-name').textContent = call.client.name;

    // DID badge — show the number they called in
    const didBadge = el('sp-did-badge');
    if (didBadge && call.did) {
      didBadge.textContent = call.did;
      didBadge.style.display = '';
    } else if (didBadge) {
      didBadge.style.display = 'none';
    }

    // Render greeting + script immediately from cached call data (with variables)
    el('client-greeting').textContent = renderScript(call.client.greeting || '', call.client.name);
    el('client-script').textContent = renderScript(call.client.script || 'No script configured for this client.', call.client.name);

    // Hide advanced sections until screenpop data arrives
    el('sp-contacts-section').style.display = 'none';
    el('sp-links-section').style.display = 'none';
    el('sp-meta').style.display = 'none';
    el('sp-open-badge').style.display = 'none';
    el('sp-hero-address').style.display = 'none';
    el('sp-hero-hours').style.display = 'none';
    el('sp-hours-section').style.display = 'none';
    el('sp-news-section').style.display = 'none';
    el('sp-private-notes-section').style.display = 'none';
    el('sp-caller-history-section').style.display = 'none';
    el('client-info-sheets').innerHTML = '';

    // Fetch full screenpop data
    if (call.client.id) {
      api('GET', `/clients/${call.client.id}/screenpop`).then((data) => {
        if (!data) return;
        renderScreenPop(data, call.did, call.callerIdNum);
      }).catch(() => {});
    }
  }

  function renderScreenPop(data, did, callerNum) {
    const { client, contacts, availability } = data;

    // Client logo
    const logoEl = el('sp-client-logo');
    if (logoEl) {
      if (client.logo_url) {
        logoEl.src = `/uploads/${client.logo_url}`;
        logoEl.alt = client.name;
        logoEl.style.display = '';
      } else {
        logoEl.style.display = 'none';
      }
    }

    // Client-level availability bar
    const availBar = el('client-availability-bar');
    if (availBar) {
      if (availability.status !== 'available') {
        const labels = { out_of_office: 'Out of Office', annual_leave: 'Annual Leave', meeting: 'In a Meeting', closed: 'Closed — Outside Business Hours' };
        availBar.textContent = `Status: ${labels[availability.status] || availability.status}${availability.note ? ` — ${availability.note}` : ''}`;
        availBar.className = `avail-bar avail-bar-${availability.status.replace(/_/g, '-')}`;
        availBar.style.display = '';
      } else {
        availBar.style.display = 'none';
      }
    }

    // Open/closed badge — prefer server-computed is_open when available
    const openBadge = el('sp-open-badge');
    const hasHours = !!(client.opening_times && Object.keys(client.opening_times).length);
    if (openBadge && hasHours) {
      const isOpen = availability.is_open !== undefined ? availability.is_open : isCurrentlyInHours(client.opening_times, client.timezone);
      openBadge.innerHTML = isOpen ? '&#9679; Open Now' : '&#9679; Closed';
      openBadge.className = `sp-open-badge ${isOpen ? 'sp-open' : 'sp-closed'}`;
      openBadge.style.display = '';
    }

    // Hero: address + account number
    const heroAddr = el('sp-hero-address');
    if (heroAddr) {
      const parts = [];
      if (client.account_number) parts.push(`<span class="sp-acct-badge">Acct&nbsp;${escHtml(client.account_number)}</span>`);
      if (client.address) parts.push(`<span>&#128205; ${escHtml(client.address.replace(/\n/g, ', '))}</span>`);
      if (parts.length) { heroAddr.innerHTML = parts.join(''); heroAddr.style.display = ''; }
      else { heroAddr.style.display = 'none'; }
    }

    // Hero: today's opening hours chip
    const heroHours = el('sp-hero-hours');
    if (heroHours) {
      if (hasHours) {
        const todayText = getTodayHoursText(client.opening_times, client.timezone);
        if (todayText) {
          heroHours.innerHTML = `<span class="sp-hours-today-chip">&#128336; Today: ${escHtml(todayText)}</span>`;
          heroHours.style.display = '';
        } else { heroHours.style.display = 'none'; }
      } else { heroHours.style.display = 'none'; }
    }

    // Full opening hours table (collapsible section)
    const hoursSection = el('sp-hours-section');
    const hoursTableEl = el('sp-hours-table');
    if (hoursSection && hoursTableEl) {
      if (hasHours) {
        const days = ['monday','tuesday','wednesday','thursday','friday','saturday','sunday'];
        const dayLabels = { monday:'Mon',tuesday:'Tue',wednesday:'Wed',thursday:'Thu',friday:'Fri',saturday:'Sat',sunday:'Sun' };
        let todayKey = '';
        try {
          const p = new Intl.DateTimeFormat('en-GB', { timeZone: client.timezone || 'Europe/London', weekday: 'long' }).formatToParts(new Date());
          todayKey = (p.find((x) => x.type === 'weekday')?.value || '').toLowerCase();
        } catch (_) {}
        const rows = days.map((day) => {
          const t = client.opening_times[day];
          const isToday = day === todayKey;
          const cls = isToday ? ' class="sp-hrs-today"' : '';
          if (!t || t.closed) return `<tr${cls}><td class="sp-hrs-day">${dayLabels[day]}</td><td class="sp-hrs-time sp-hrs-closed">Closed</td></tr>`;
          return `<tr${cls}><td class="sp-hrs-day">${dayLabels[day]}</td><td class="sp-hrs-time">${escHtml(t.open || '09:00')} – ${escHtml(t.close || '17:30')}</td></tr>`;
        }).join('');
        hoursTableEl.innerHTML = `<table class="sp-hrs-tbl"><tbody>${rows}</tbody></table>`;
        hoursSection.style.display = '';
      } else {
        hoursSection.style.display = 'none';
      }
    }

    // Address + account meta (kept hidden, now shown in hero)
    const meta = el('sp-meta');
    if (meta) {
      const parts = [];
      if (client.account_number) parts.push(`Acct: ${escHtml(client.account_number)}`);
      if (client.address) parts.push(escHtml(client.address.replace(/\n/g, ', ')));
      if (parts.length) meta.innerHTML = parts.join(' &bull; ');
    }

    // Re-render greeting/script from fresh data (with variables)
    el('client-greeting').textContent = renderScript(client.greeting || '', client.name);
    el('client-script').textContent = renderScript(client.script || 'No script configured for this client.', client.name);

    // Info sheets
    const sheetsContainer = el('client-info-sheets');
    const infoSheets = client.info_sheets || [];
    if (sheetsContainer) {
      if (infoSheets.length) {
        sheetsContainer.innerHTML = infoSheets.map((s, i) => `
          <div class="info-sheet-card">
            <div class="info-sheet-header" onclick="this.parentElement.classList.toggle('open')">
              <span>${escHtml(s.title || `Sheet ${i + 1}`)}</span>
              <span class="info-sheet-arrow">&#9660;</span>
            </div>
            <div class="info-sheet-body">${escHtml(s.content || '')}</div>
          </div>
        `).join('');
        el('sp-sheets-section').style.display = '';
      } else {
        el('sp-sheets-section').style.display = 'none';
      }
    }

    // Contacts
    if (contacts && contacts.length) {
      renderScreenPopContacts(contacts, client.opening_times, client.timezone);
      el('sp-contacts-section').style.display = '';
    }

    // Web links
    const webLinks = client.web_links || [];
    if (webLinks.length) {
      const linksEl = el('sp-web-links');
      if (linksEl) {
        linksEl.innerHTML = webLinks.map((l) => `
          <a href="${escHtml(l.url)}" target="_blank" rel="noopener noreferrer" class="sp-web-link">
            <span class="sp-web-link-icon">&#128279;</span>
            <span>${escHtml(l.title || l.url)}</span>
          </a>
        `).join('');
      }
      el('sp-links-section').style.display = '';
    }

    // Private notes (red, operator-only)
    const pnSection = el('sp-private-notes-section');
    const pnBody = el('sp-private-notes');
    if (pnSection && pnBody) {
      if (client.private_notes) {
        pnBody.textContent = client.private_notes;
        pnSection.style.display = '';
      } else {
        pnSection.style.display = 'none';
      }
    }

    // Client news
    if (client.id) {
      loadClientNews(client.id);
    }

    // Caller history
    if (callerNum) {
      loadCallerHistory(callerNum);
    }
  }

  async function loadClientNews(clientId) {
    const section = el('sp-news-section');
    const container = el('sp-client-news');
    if (!section || !container) return;
    try {
      const data = await api('GET', `/clients/${clientId}/news`);
      if (!data || !data.news.length) { section.style.display = 'none'; return; }
      container.innerHTML = data.news.map((n) => `
        <div class="client-news-item">
          ${escHtml(n.content)}
          <div class="news-meta">${n.author_name ? `By ${escHtml(n.author_name)} — ` : ''}${relTime(n.created_at)}</div>
        </div>
      `).join('');
      section.style.display = '';
    } catch { section.style.display = 'none'; }
  }

  async function loadCallerHistory(callerNumber) {
    const section = el('sp-caller-history-section');
    const container = el('sp-caller-history');
    if (!section || !container) return;
    try {
      const data = await api('GET', `/calls/history/${encodeURIComponent(callerNumber)}`);
      if (!data || (!data.calls.length && !data.messages.length)) {
        section.style.display = 'none';
        return;
      }
      let html = '';
      if (data.calls.length) {
        html += '<div style="font-size:0.75rem;color:var(--text-muted);font-weight:600;margin-bottom:4px">Recent Calls</div>';
        html += data.calls.slice(0, 10).map((c) => `
          <div class="caller-history-item">
            <span class="ch-disp">${escHtml(c.disposition || 'unknown')}</span>
            <span>${escHtml(c.client_name || '—')}</span>
            <span class="ch-date">${relTime(c.call_start)}</span>
          </div>
        `).join('');
      }
      if (data.messages.length) {
        html += '<div style="font-size:0.75rem;color:var(--text-muted);font-weight:600;margin:8px 0 4px">Recent Messages</div>';
        html += data.messages.slice(0, 5).map((m) => `
          <div class="caller-history-item">
            <span>${escHtml(m.client_name || '—')}</span>
            <span class="ch-date">${relTime(m.created_at)}</span>
          </div>
        `).join('');
      }
      container.innerHTML = html;
      section.style.display = '';
    } catch { section.style.display = 'none'; }
  }

  function renderScreenPopContacts(contacts, openingTimes, timezone) {
    const container = el('sp-contacts');
    if (!container) return;

    // Group by department
    const depts = new Map();
    depts.set(null, []);
    contacts.forEach((c) => {
      const key = c.department_name || null;
      if (!depts.has(key)) depts.set(key, []);
      depts.get(key).push(c);
    });

    const actionLabels = { message: 'Message', transfer: 'Transfer', both: 'Msg+Xfer' };

    let html = '';
    for (const [dept, group] of depts.entries()) {
      if (!group.length) continue;
      if (dept) html += `<div class="sp-dept-label">${escHtml(dept)}</div>`;
      html += group.map((c) => {
        const avail = contactAvailBadge(c, openingTimes, timezone);
        const privateTag = c.is_private ? '<span class="private-badge">PRIVATE</span>' : '';
        const extInfo = (c.call_action === 'transfer' || c.call_action === 'both') && c.transfer_extension
          ? `<span class="sp-contact-ext">Ext ${escHtml(c.transfer_extension)}</span>` : '';
        const noteInfo = c.message_note ? `<div class="sp-contact-note">${escHtml(c.message_note)}</div>` : '';
        const actBtns = [];
        actBtns.push(`<button class="btn-take-msg" onclick="App.takeMessageForContact('${escHtml(c.client_id || '')}','${escHtml(c.name)}','${escHtml(c.phone || '')}','${escHtml(c.email || '')}')">&#128221; Take a Message</button>`);
        if (c.phone) actBtns.push(`<button onclick="App.originateToContact('${escHtml(c.phone)}','${escHtml(c.client_id || '')}')">&#128222; Call</button>`);
        if (c.email) actBtns.push(`<button onclick="App.quickContactCompose('${escHtml(c.id)}','${escHtml(c.client_id || '')}','email','${escHtml(c.email)}','${escHtml(c.name)}')">&#9993; Email</button>`);
        if (c.sms_number || c.phone) actBtns.push(`<button onclick="App.quickContactCompose('${escHtml(c.id)}','${escHtml(c.client_id || '')}','sms','${escHtml(c.sms_number || c.phone)}','${escHtml(c.name)}')">&#128172; SMS</button>`);
        const actionsHtml = `<div class="sp-contact-actions">${actBtns.join('')}</div>`;

        return `
          <div class="sp-contact-item${c.is_private ? ' sp-contact-private' : ''}">
            <div class="sp-contact-header">
              <div class="sp-contact-avail ${avail.cls}" title="${avail.text}"></div>
              <div class="sp-contact-name">${escHtml(c.name)}${privateTag}</div>
              ${c.title ? `<div class="sp-contact-title">${escHtml(c.title)}</div>` : ''}
              <div class="sp-contact-pills">
                <span class="pill pill-blue">${actionLabels[c.call_action] || c.call_action}</span>
                ${extInfo}
              </div>
            </div>
            ${c.phone ? `<div class="sp-contact-phone">&#128222; <a href="tel:${escHtml(c.phone)}">${escHtml(c.phone)}</a></div>` : ''}
            ${noteInfo}
            ${actionsHtml}
          </div>
        `;
      }).join('');
    }
    container.innerHTML = html || '<p class="empty-state">No contacts</p>';
  }

  /* ---- Availability helpers ---- */
  function isCurrentlyInHours(schedule, timezone) {
    try {
      const now = new Date();
      const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: timezone || 'Europe/London',
        weekday: 'long', hour: '2-digit', minute: '2-digit', hour12: false,
      }).formatToParts(now);
      const day = parts.find((p) => p.type === 'weekday').value.toLowerCase();
      const hour = parseInt(parts.find((p) => p.type === 'hour').value, 10);
      const min  = parseInt(parts.find((p) => p.type === 'minute').value, 10);
      const now_m = hour * 60 + min;
      const s = schedule[day];
      if (!s || s.closed) return false;
      const [oh, om] = (s.open  || '09:00').split(':').map(Number);
      const [ch, cm] = (s.close || '17:30').split(':').map(Number);
      return now_m >= oh * 60 + om && now_m < ch * 60 + cm;
    } catch { return true; }
  }

  function contactAvailBadge(contact, openingTimes, timezone) {
    const type = contact.availability_type || 'always';
    if (type === 'unavailable') return { text: 'Unavailable', cls: 'sp-avail-red' };
    if (type === 'always')      return { text: 'Available',   cls: 'sp-avail-green' };
    const sched = type === 'custom' ? (contact.availability_schedule || {}) : (openingTimes || {});
    const inHours = isCurrentlyInHours(sched, timezone);
    return inHours
      ? { text: 'Available',  cls: 'sp-avail-green' }
      : { text: 'Off Hours',  cls: 'sp-avail-amber' };
  }

  /* ---- Today's opening hours helper ---- */
  function getTodayHoursText(schedule, timezone) {
    try {
      const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: timezone || 'Europe/London',
        weekday: 'long',
      }).formatToParts(new Date());
      const day = parts.find((p) => p.type === 'weekday').value.toLowerCase();
      const s = schedule[day];
      if (!s) return null;
      if (s.closed) return 'Closed today';
      return `${s.open || '09:00'} – ${s.close || '17:30'}`;
    } catch { return null; }
  }

  /* ---- Script template rendering ---- */
  function renderScript(text, clientName) {
    if (!text) return '';
    const hour = new Date().getHours();
    const greeting = hour < 12 ? 'Good Morning' : hour < 17 ? 'Good Afternoon' : 'Good Evening';
    const operatorName = currentOperator?.full_name || currentOperator?.username || '';
    return text
      .replace(/\{\{greeting\}\}/gi, greeting)
      .replace(/\{\{client\}\}/gi, clientName || '')
      .replace(/\{\{operator\}\}/gi, operatorName);
  }

  function prefillMessageForm(call) {
    if (call.client) {
      el('msg-client').value = call.client.id;
      onClientChange();
    }
    el('msg-caller-phone').value = call.callerIdNum || '';
    el('msg-caller-name').value = call.callerIdName || '';
    // Show caller ID hint so operator confirms this is the best contact number
    showCallerIdHint(call.callerIdNum || '');
  }

  /* ---- Caller ID hint — prompts operator to confirm inbound number ---- */
  let _inboundCallerNum = '';

  function showCallerIdHint(inboundNum) {
    _inboundCallerNum = inboundNum;
    updateCallerIdHint();
  }

  function updateCallerIdHint() {
    const hint   = el('msg-caller-id-hint');
    const field  = el('msg-caller-phone');
    if (!hint || !field) return;
    const typed  = field.value.trim();
    if (!_inboundCallerNum) { hint.classList.add('hidden'); return; }

    if (!typed || typed === _inboundCallerNum) {
      // Number matches or field is empty — show confirmation prompt
      hint.innerHTML = `&#128222; Inbound number: <strong>${escHtml(_inboundCallerNum)}</strong>
        &nbsp;— Is this the best contact number for the caller?
        <button onclick="App.confirmCallerPhone()">&#10003; Confirm</button>`;
      hint.classList.remove('hidden');
    } else {
      // Operator has typed a different number — acknowledge
      hint.innerHTML = `&#128222; Inbound: <strong>${escHtml(_inboundCallerNum)}</strong>
        &ensp;&#x2192;&ensp;Using: <strong>${escHtml(typed)}</strong>`;
      hint.classList.remove('hidden');
    }
  }

  function confirmCallerPhone() {
    // Ensure the inbound number is set and the hint indicates confirmed
    const field = el('msg-caller-phone');
    if (field && _inboundCallerNum) field.value = _inboundCallerNum;
    const hint = el('msg-caller-id-hint');
    if (hint) {
      hint.innerHTML = `&#10003; Contact number confirmed: <strong>${escHtml(_inboundCallerNum)}</strong>`;
      hint.style.background = 'var(--success-light)';
      hint.style.borderColor = '#86efac';
      hint.style.color = 'var(--success)';
    }
  }

  function onCallerPhoneChanged() {
    updateCallerIdHint();
  }

  /* ---- Clients ---- */
  async function loadClients() {
    try {
      const data = await api('GET', '/clients?active=true');
      if (!data) return;
      clients = data.clients;

      const options = clients.map((c) => `<option value="${c.id}">${escHtml(c.name)}</option>`).join('');
      el('msg-client').innerHTML = '<option value="">— Select Client —</option>' + options;
      el('msg-filter-client').innerHTML = '<option value="">All Clients</option>' + options;
      const tfClient = el('tf-client');
      if (tfClient) tfClient.innerHTML = '<option value="">— None —</option>' + options;
    } catch (err) {
      console.error('loadClients error:', err.message);
    }
  }

  /* ---- Custom Form Rendering ---- */
  let _clientTemplates = [];

  function toggleTemplateMenu() {
    const menu = el('msg-template-menu');
    if (menu) menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
  }

  function applyMessageTemplate(idx) {
    const t = _clientTemplates[idx];
    if (!t) return;
    el('msg-subject').value = t.subject || '';
    el('msg-body').value = t.body || '';
    if (t.call_type) { const ct = el('msg-call-type'); if (ct) ct.value = t.call_type; }
    if (t.urgency)   { const ur = el('msg-urgency');   if (ur) ur.value = t.urgency; }
    const menu = el('msg-template-menu');
    if (menu) menu.style.display = 'none';
    onCallTypeChange();
  }

  async function _loadClientTemplates(clientId) {
    const wrapper = el('msg-templates-wrapper');
    const menu = el('msg-template-menu');
    if (!wrapper || !menu) return;
    try {
      const data = await api('GET', `/clients/${clientId}/message-templates`);
      _clientTemplates = data.templates || [];
      if (_clientTemplates.length) {
        wrapper.style.display = '';
        menu.innerHTML = _clientTemplates.map((t, i) =>
          `<div class="template-item" onclick="App.applyMessageTemplate(${i})" style="padding:8px 12px;cursor:pointer;font-size:0.85rem;border-bottom:1px solid var(--border)" onmouseover="this.style.background='var(--bg-secondary)'" onmouseout="this.style.background=''">${escHtml(t.name)}</div>`
        ).join('');
      } else {
        wrapper.style.display = 'none';
        menu.innerHTML = '';
      }
    } catch (_) {
      wrapper.style.display = 'none';
    }
  }

  function onClientChange() {
    const clientId = el('msg-client').value;
    const container = el('custom-form-fields');
    container.innerHTML = '';

    const client = clients.find((c) => c.id === clientId);
    if (!client) return;

    // Load message templates for this client
    _loadClientTemplates(clientId);

    const fields = client.custom_form || [];
    if (!fields.length) return;

    const divider = document.createElement('div');
    divider.className = 'custom-form-divider';
    divider.textContent = 'Additional Information';
    container.appendChild(divider);

    fields.forEach((field) => {
      const wrapper = document.createElement('div');
      wrapper.className = 'field';

      const label = document.createElement('label');
      label.textContent = field.label + (field.required ? ' *' : '');
      wrapper.appendChild(label);

      let input;
      switch (field.type) {
        case 'textarea':
          input = document.createElement('textarea');
          input.rows = 3;
          if (field.spellcheck) input.spellcheck = true;
          break;
        case 'select':
          input = document.createElement('select');
          input.innerHTML = '<option value="">— Select —</option>' +
            (field.options || []).map((o) => `<option value="${escHtml(o)}">${escHtml(o)}</option>`).join('');
          break;
        case 'checkbox':
          input = document.createElement('input');
          input.type = 'checkbox';
          wrapper.classList.add('field-inline');
          break;
        default:
          input = document.createElement('input');
          input.type = field.type || 'text';
          if (field.type === 'textarea') input.spellcheck = field.spellcheck || false;
      }

      input.dataset.fieldId = field.id;
      input.dataset.fieldLabel = field.label;
      if (field.required) input.required = true;
      input.className = 'custom-field-input';

      // Conditional visibility (show_when support)
      if (field.show_when) {
        wrapper.dataset.showWhenField = field.show_when.field;
        wrapper.dataset.showWhenValue = field.show_when.value;
        wrapper.style.display = 'none';
        wrapper.classList.add('conditional-field');
      }

      // On change, re-evaluate conditional fields
      input.addEventListener('change', () => checkFormConditions());
      input.addEventListener('input', () => checkFormConditions());

      wrapper.appendChild(input);
      container.appendChild(wrapper);
    });
    // Initial condition check
    checkFormConditions();
  }

  function checkFormConditions() {
    document.querySelectorAll('.conditional-field').forEach((wrapper) => {
      const depFieldId = wrapper.dataset.showWhenField;
      const depValue = wrapper.dataset.showWhenValue;
      const depInput = document.querySelector(`.custom-field-input[data-field-id="${depFieldId}"]`);
      if (!depInput) return;
      const currentVal = depInput.type === 'checkbox' ? String(depInput.checked) : depInput.value;
      wrapper.style.display = currentVal === depValue ? '' : 'none';
      const input = wrapper.querySelector('.custom-field-input');
      if (input && wrapper.style.display === 'none') input.required = false;
    });
  }

  /* ---- Call Type + No Charge ---- */
  function onCallTypeChange() {
    const callType = el('msg-call-type').value;
    const bodyField = el('msg-body');
    const noChargeEl = el('msg-no-charge');
    const noChargeRow = el('no-charge-row');

    // Standard calls require a message body
    if (callType === 'standard') {
      bodyField.required = true;
      bodyField.closest('.field').style.display = '';
    } else {
      bodyField.required = false;
      // For no_information / sales / wrong_number, body is optional
      bodyField.closest('.field').style.display = '';
    }

    // Auto-check no-charge for sales/wrong_number
    if (callType === 'sales' || callType === 'wrong_number') {
      noChargeEl.checked = true;
    }
  }

  /* ---- Messages ---- */
  async function loadMessages() {
    const clientFilter = el('msg-filter-client')?.value;
    const statusFilter = el('msg-filter-status')?.value;

    let path = '/messages?limit=30';
    if (clientFilter) path += `&client_id=${clientFilter}`;
    if (statusFilter) path += `&status=${statusFilter}`;

    try {
      const data = await api('GET', path);
      if (!data) return;
      renderMessages(data.messages);
    } catch (err) {
      console.error('loadMessages error:', err.message);
    }
  }

  function renderMessages(messages) {
    const container = el('messages-list');
    if (!messages.length) {
      container.innerHTML = '<p class="empty-state">No messages</p>';
      return;
    }

    container.innerHTML = messages.map((m) => `
      <div class="message-item" data-msg-id="${m.id}" onclick="App.showMessageDetail('${m.id}')">
        <div class="message-item-client">${escHtml(m.client_name || '—')}</div>
        <div class="message-item-caller">${escHtml(m.caller_name || m.caller_phone || 'Unknown')}</div>
        <div class="message-item-preview">${escHtml(m.body)}</div>
        <div class="message-item-meta">
          <span class="message-item-time">${relTime(m.created_at)}</span>
          <span class="urgency-pill urgency-${m.urgency}">${m.urgency}</span>
          <span class="message-item-status status-${m.status}">${m.status}</span>
        </div>
      </div>
    `).join('');
  }

  let _detailMessageId = null;
  let _detailMessageBody = '';

  async function showMessageDetail(messageId) {
    _detailMessageId = messageId;
    _detailMessageBody = '';
    const modal = el('msg-detail-modal');
    if (!modal) {
      // Fallback to old behavior if modal not in DOM
      return _showMessageDetailLegacy(messageId);
    }
    el('msg-detail-title').textContent = 'Loading…';
    el('msg-detail-meta').innerHTML = '';
    el('msg-detail-body').textContent = '';
    el('msg-detail-deliveries').innerHTML = '';
    const aiOut = el('ai-output');
    if (aiOut) { aiOut.style.display = 'none'; aiOut.textContent = ''; }
    modal.style.display = 'flex';
    try {
      const data = await api('GET', `/messages/${messageId}`);
      if (!data) return;
      const m = data.message;
      _detailMessageBody = m.body || '';
      el('msg-detail-title').textContent = m.subject || 'Message';
      el('msg-detail-meta').innerHTML = [
        `<span class="pill pill-${m.urgency === 'high' ? 'red' : 'blue'}">${m.urgency}</span>`,
        `<span class="pill">${m.status}</span>`,
        `<span>Client: <strong>${escHtml(m.client_name || '—')}</strong></span>`,
        `<span>Caller: ${escHtml(m.caller_name || '—')}${m.caller_phone ? ` (${escHtml(m.caller_phone)})` : ''}</span>`,
        `<span>${new Date(m.created_at).toLocaleString('en-GB')}</span>`,
      ].join('');
      el('msg-detail-body').textContent = m.body || '(no body)';

      // Display custom form_data if present
      const formDataEl = el('msg-detail-form-data');
      if (formDataEl) {
        const fd = m.form_data;
        if (fd && typeof fd === 'object' && Object.keys(fd).length) {
          formDataEl.style.display = 'block';
          formDataEl.innerHTML = '<div style="font-size:0.78rem;font-weight:600;margin-bottom:6px;color:var(--text-muted)">Additional Form Data:</div>' +
            Object.entries(fd).map(([k, v]) => `<div style="margin-bottom:3px"><strong>${escHtml(k)}:</strong> ${escHtml(String(v))}</div>`).join('');
        } else {
          formDataEl.style.display = 'none';
        }
      }

      // Load delivery log
      try {
        const del = await api('GET', `/messages/${messageId}/deliveries`);
        const deliveries = del.deliveries || [];
        if (deliveries.length) {
          el('msg-detail-deliveries').innerHTML = '<div style="margin-top:8px;font-size:0.78rem"><strong>Deliveries:</strong> ' +
            deliveries.map((d) => `<span class="pill ${d.status === 'sent' ? 'pill-green' : 'pill-red'}" style="margin-right:4px">${escHtml(d.channel)} · ${d.status}</span>`).join('') + '</div>';
        }
      } catch { /* ignore */ }
    } catch (err) {
      el('msg-detail-body').textContent = 'Error: ' + err.message;
    }
  }

  async function _showMessageDetailLegacy(messageId) {
    try {
      const data = await api('GET', `/messages/${messageId}`);
      if (!data) return;
      const m = data.message;
      const detail = [`Client: ${m.client_name}`, `Caller: ${m.caller_name || '—'}`, `Status: ${m.status}`, '', m.body].join('\n');
      if (confirm(`${detail}\n\nRedeliver?`)) {
        await api('POST', `/messages/${messageId}/deliver`, {});
        toast('Message delivered', 'success');
        loadMessages();
      }
    } catch (err) { toast(`Error: ${err.message}`, 'danger'); }
  }

  function closeMsgDetail() {
    const modal = el('msg-detail-modal');
    if (modal) modal.style.display = 'none';
    _detailMessageId = null;
  }

  async function redeliverMessage() {
    if (!_detailMessageId) return;
    try {
      await api('POST', `/messages/${_detailMessageId}/deliver`, {});
      toast('Message redelivered', 'success');
      closeMsgDetail();
      loadMessages();
    } catch (err) { toast(`Redeliver failed: ${err.message}`, 'danger'); }
  }

  /* ---- AI Features ---- */
  async function _aiRequest(endpoint, payload, outputLabel) {
    const btn = el(endpoint.includes('summarise') ? 'ai-summarise-btn' :
                   endpoint.includes('translate') ? 'ai-translate-btn' : 'ai-suggest-btn');
    const out = el('ai-output');
    if (!out) return;
    if (btn) btn.disabled = true;
    out.style.display = 'block';
    out.textContent = 'Thinking…';
    try {
      const data = await api('POST', endpoint, payload);
      const result = data.summary || data.translation || data.suggestion || data.result || JSON.stringify(data);
      out.innerHTML = `<strong>${outputLabel}:</strong><br>${escHtml(result)}`;
    } catch (err) {
      out.textContent = `AI error: ${err.message}`;
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function aiSummarise() {
    if (!_detailMessageBody) return;
    _aiRequest('/ai/summarise', { text: _detailMessageBody }, 'Summary');
  }

  function aiTranslate() {
    if (!_detailMessageBody) return;
    _aiRequest('/ai/translate', { text: _detailMessageBody, target_language: 'English' }, 'Translation');
  }

  function aiSuggestReply() {
    if (!_detailMessageBody) return;
    _aiRequest('/ai/suggest-reply', { message: _detailMessageBody }, 'Suggested Reply');
  }

  async function submitMessage(andDeliver = true) {
    const feedback = el('msg-feedback');
    feedback.className = 'feedback hidden';

    const clientId = el('msg-client').value;
    const body = el('msg-body').value.trim();
    const callType = el('msg-call-type').value;
    if (!clientId) return;
    if (callType === 'standard' && !body) return;

    // Collect custom form fields
    const customFields = {};
    document.querySelectorAll('.custom-field-input').forEach((input) => {
      const label = input.dataset.fieldLabel;
      customFields[label] = input.type === 'checkbox' ? input.checked : input.value;
    });

    const customNotes = Object.entries(customFields)
      .filter(([, v]) => v !== '' && v !== false)
      .map(([k, v]) => `${k}: ${v}`)
      .join('\n');

    const payload = {
      client_id: clientId,
      // Use pending call log ID (post-call) or active call ID (mid-call)
      call_log_id: _pendingMsgCallLogId || activeCall?.callLogId || null,
      caller_name: el('msg-caller-name').value.trim() || null,
      caller_phone: el('msg-caller-phone').value.trim() || null,
      caller_company: el('msg-caller-company').value.trim() || null,
      subject: el('msg-subject').value.trim() || null,
      body: customNotes ? `${body}\n\n--- Additional Info ---\n${customNotes}` : body,
      urgency: el('msg-urgency').value,
      call_type: callType,
      is_no_charge: el('msg-no-charge').checked,
      auto_deliver: andDeliver,
      form_data: Object.keys(customFields).length ? customFields : undefined,
    };

    try {
      el('msg-submit').disabled = true;
      await api('POST', '/messages', payload);
      feedback.className = 'feedback success';
      feedback.textContent = andDeliver ? 'Message saved and delivered.' : 'Message saved.';
      _clearMandatoryMessageBanner();
      clearMessageForm();
      loadMessages();
    } catch (err) {
      feedback.className = 'feedback error';
      feedback.textContent = `Error: ${err.message}`;
    } finally {
      el('msg-submit').disabled = false;
    }
  }

  function saveMessageOnly() { submitMessage(false); }

  /* ---- Mandatory message banner (shown after call ends) ---- */
  function _showMandatoryMessageBanner() {
    let banner = el('msg-mandatory-banner');
    if (!banner) {
      // Inject banner above the form header if it doesn't exist in HTML yet
      const header = document.querySelector('#view-console .panel-header h2');
      if (!header) return;
      banner = document.createElement('div');
      banner.id = 'msg-mandatory-banner';
      banner.className = 'msg-mandatory-banner';
      header.closest('.panel-header').after(banner);
    }
    banner.innerHTML = `&#9888; <strong>Message required</strong> — please complete a message or select a call type for this call before taking another.`;
    banner.style.display = 'flex';
  }

  function _clearMandatoryMessageBanner() {
    _pendingMsgCallLogId   = null;
    _pendingMsgClientId    = null;
    _pendingMsgMessageDone = true;
    const banner = el('msg-mandatory-banner');
    if (banner) banner.style.display = 'none';
  }

  function clearMessageForm() {
    el('msg-client').value = '';
    el('msg-caller-name').value = '';
    el('msg-caller-phone').value = '';
    el('msg-caller-company').value = '';
    // Clear caller ID hint
    _inboundCallerNum = '';
    const hint = el('msg-caller-id-hint');
    if (hint) { hint.classList.add('hidden'); hint.style.cssText = ''; }
    el('msg-subject').value = '';
    el('msg-body').value = '';
    el('msg-urgency').value = 'normal';
    el('msg-call-type').value = 'standard';
    el('msg-no-charge').checked = false;
    el('msg-body').required = true;
    el('msg-feedback').className = 'feedback hidden';
    el('custom-form-fields').innerHTML = '';
  }

  /* ---- Operators ---- */
  let _activeCallsByChannel = new Map();

  async function refreshActiveCalls() {
    try {
      const data = await api('GET', '/callcontrol/active');
      _activeCallsByChannel = new Map((data.calls || []).map((c) => [c.channelId, c]));
    } catch (_) { _activeCallsByChannel = new Map(); }
  }

  function renderOperators(operators) {
    const container = el('operators-list');
    if (!operators.length) {
      container.innerHTML = '<p class="empty-state">No operators online</p>';
      return;
    }
    const isSupervisor = currentOperator?.role === 'admin' || currentOperator?.role === 'supervisor';
    const statusLabel = { ready:'Ready', busy:'On Call', break:'On Break', lunch:'Lunch',
      training:'Training', admin:'Admin', offline:'Offline' };
    const dotClass = { ready:'dot-ready', busy:'dot-busy', break:'dot-break', lunch:'dot-lunch',
      training:'dot-training', admin:'dot-admin', offline:'dot-offline' };

    // Find active channels if supervisor
    const activeCalls = Array.from(_activeCallsByChannel.values());

    container.innerHTML = operators.map((op) => {
      // Find an active call for this operator (match by callLogId if we can, else skip)
      const opCall = activeCalls.find((c) => c.operatorId === op.id);
      const monitorBtns = isSupervisor && opCall && op.status === 'busy'
        ? `<div style="display:flex;gap:3px;margin-top:4px">
            <button class="btn btn-sm" style="font-size:0.65rem;padding:2px 6px" title="Listen silently" onclick="App.supervisorMonitor('${opCall.channelId}','listen')">&#128048; Listen</button>
            <button class="btn btn-sm" style="font-size:0.65rem;padding:2px 6px" title="Whisper to operator" onclick="App.supervisorMonitor('${opCall.channelId}','whisper')">&#128172; Whisper</button>
            <button class="btn btn-sm" style="font-size:0.65rem;padding:2px 6px" title="Join call" onclick="App.supervisorMonitor('${opCall.channelId}','barge')">&#127774; Barge</button>
          </div>`
        : '';
      return `
      <div class="operator-item">
        <span class="status-dot ${dotClass[op.status] || 'dot-offline'}"></span>
        <div style="flex:1;min-width:0">
          <div><span class="op-name">${escHtml(op.fullName || op.username)}</span>
          <span class="op-status" style="font-size:0.72rem;color:var(--text-muted);margin-left:4px">${statusLabel[op.status] || op.status}</span></div>
          ${monitorBtns}
        </div>
      </div>`;
    }).join('');
  }

  async function supervisorMonitor(channelId, mode) {
    const ext = prompt(`Your SIP extension to join call (${mode} mode):`);
    if (!ext) return;
    const endpoint = mode === 'listen' ? 'monitor' : mode === 'whisper' ? 'whisper' : 'barge';
    try {
      await api('POST', `/callcontrol/${channelId}/${endpoint}`, { supervisor_extension: ext });
      toast(`Connected in ${mode} mode`, 'success');
    } catch (err) { toast(`${mode} failed: ${err.message}`, 'danger'); }
  }

  /* ---- Utilities ---- */
  function escHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatTime(date) {
    return date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  }

  function relTime(isoStr) {
    if (!isoStr) return '';
    const diff = (Date.now() - new Date(isoStr).getTime()) / 1000;
    if (diff < 60) return 'just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return new Date(isoStr).toLocaleDateString('en-GB');
  }

  /* ---- Noticeboard ---- */
  async function loadNoticeboard() {
    try {
      const data = await api('GET', '/noticeboard');
      if (!data) return;
      renderNoticeboard(data.notices);
    } catch { /* silent */ }
  }

  function renderNoticeboard(notices) {
    const container = el('noticeboard-list');
    if (!container) return;
    if (!notices.length) {
      container.innerHTML = '<p class="empty-state">No announcements</p>';
      return;
    }
    container.innerHTML = notices.map((n) => `
      <div class="notice-item notice-${n.priority}">
        <div class="notice-title">${escHtml(n.title)}${n.is_pinned ? '<span class="notice-pinned">&#128204;</span>' : ''}</div>
        <div>${escHtml(n.content)}</div>
        <div class="notice-meta">${n.author_name ? escHtml(n.author_name) : ''} — ${relTime(n.created_at)}</div>
      </div>
    `).join('');
  }

  let editingNoticeId = null;

  function openNoticeEditor(noticeId) {
    editingNoticeId = noticeId || null;
    el('notice-editor-title').textContent = noticeId ? 'Edit Announcement' : 'New Announcement';
    el('notice-title').value = '';
    el('notice-content').value = '';
    el('notice-priority').value = 'normal';
    el('notice-expires').value = '';
    el('notice-pinned').checked = false;
    el('notice-editor-modal').style.display = 'flex';
  }

  function closeNoticeEditor() {
    el('notice-editor-modal').style.display = 'none';
    editingNoticeId = null;
  }

  async function saveNotice() {
    const title = el('notice-title').value.trim();
    const content = el('notice-content').value.trim();
    if (!title || !content) return;
    try {
      const body = {
        title, content,
        priority: el('notice-priority').value,
        expires_at: el('notice-expires').value || null,
        is_pinned: el('notice-pinned').checked,
      };
      if (editingNoticeId) {
        await api('PUT', `/noticeboard/${editingNoticeId}`, body);
      } else {
        await api('POST', '/noticeboard', body);
      }
      closeNoticeEditor();
      toast('Announcement saved', 'success');
      loadNoticeboard();
    } catch (err) {
      toast(`Error: ${err.message}`, 'danger');
    }
  }

  /* ---- Call Disposition ---- */
  let pendingDispositionCallLogId = null;

  function showDispositionModal(callLogId) {
    pendingDispositionCallLogId = callLogId;
    el('disp-type').value = 'answered';
    el('disp-billable').checked = true;
    el('disp-notes').value = '';
    el('disp-followup').checked = false;
    el('disp-followup-at').style.display = 'none';
    el('disp-followup-at').value = '';
    el('disposition-modal').style.display = 'flex';
  }

  async function saveDisposition() {
    if (!pendingDispositionCallLogId) return;
    try {
      await api('PATCH', `/calls/${pendingDispositionCallLogId}/disposition`, {
        disposition: el('disp-type').value,
        is_billable: el('disp-billable').checked,
        disposition_notes: el('disp-notes').value.trim() || null,
        follow_up_required: el('disp-followup').checked,
        follow_up_at: el('disp-followup-at').value || null,
      });
      toast('Call disposition saved', 'success');
    } catch (err) {
      toast(`Error: ${err.message}`, 'danger');
    }
    el('disposition-modal').style.display = 'none';
    pendingDispositionCallLogId = null;
  }

  function skipDisposition() {
    el('disposition-modal').style.display = 'none';
    pendingDispositionCallLogId = null;
    toast('Call ended', 'info');
  }

  /* ---- Quick Contact Compose (email/SMS from screen pop) ---- */
  let quickContactClientId = null;
  let quickContactId = null;

  function quickContactCompose(contactId, clientId, channel, to, contactName) {
    quickContactClientId = clientId;
    quickContactId = contactId;
    el('qc-title').textContent = `Send ${channel === 'email' ? 'Email' : 'SMS'} to ${contactName}`;
    el('qc-channel').value = channel;
    el('qc-to').value = to;
    el('qc-subject').value = '';
    el('qc-body').value = '';
    el('qc-subject-row').style.display = channel === 'email' ? '' : 'none';
    el('qc-feedback').className = 'feedback hidden';
    el('quick-contact-modal').style.display = 'flex';
  }

  function closeQuickContact() {
    el('quick-contact-modal').style.display = 'none';
    quickContactClientId = null;
    quickContactId = null;
  }

  async function sendQuickContact() {
    if (!quickContactClientId || !quickContactId) return;
    const body = el('qc-body').value.trim();
    if (!body) return;
    try {
      await api('POST', `/clients/${quickContactClientId}/contacts/${quickContactId}/notify`, {
        channel: el('qc-channel').value,
        subject: el('qc-subject').value.trim() || null,
        body,
      });
      toast('Sent successfully', 'success');
      closeQuickContact();
    } catch (err) {
      const fb = el('qc-feedback');
      fb.className = 'feedback error';
      fb.textContent = err.message;
    }
  }

  /* ---- Outbound Calls ---- */
  function openOutbound() {
    el('outbound-number').value = '';
    el('outbound-client').innerHTML = '<option value="">— None —</option>' +
      clients.map((c) => `<option value="${c.id}">${escHtml(c.name)}</option>`).join('');
    el('outbound-modal').style.display = 'flex';
  }

  function closeOutbound() {
    el('outbound-modal').style.display = 'none';
  }

  async function makeOutboundCall() {
    const number = el('outbound-number').value.trim();
    if (!number) return;
    const ext = prompt('Your SIP extension (e.g. 1001):');
    if (!ext) return;
    try {
      await api('POST', '/callcontrol/originate', {
        extension: ext,
        destination: number,
        client_id: el('outbound-client').value || null,
      });
      toast(`Dialling ${number}...`, 'info');
      closeOutbound();
    } catch (err) {
      toast(`Error: ${err.message}`, 'danger');
    }
  }

  function originateToContact(phone, clientId) {
    const ext = prompt('Your SIP extension (e.g. 1001):');
    if (!ext) return;
    api('POST', '/callcontrol/originate', { extension: ext, destination: phone, client_id: clientId || null })
      .then(() => toast(`Dialling ${phone}...`, 'info'))
      .catch((err) => toast(`Error: ${err.message}`, 'danger'));
  }

  /* ---- Client Browser (open any client screen without a call) ---- */
  function openClientBrowser() {
    const sel = el('cb-client-select');
    sel.innerHTML = '<option value="">-- Choose a client --</option>' +
      clients.map((c) => `<option value="${c.id}">${escHtml(c.name)}</option>`).join('');
    el('cb-screen').innerHTML = '';
    el('client-browser-modal').style.display = 'flex';
  }

  function closeClientBrowser() {
    el('client-browser-modal').style.display = 'none';
  }

  async function loadClientScreen() {
    const clientId = el('cb-client-select').value;
    const container = el('cb-screen');
    if (!clientId) { container.innerHTML = ''; return; }
    try {
      const data = await api('GET', `/clients/${clientId}/screenpop`);
      if (!data) return;
      const { client, contacts, availability } = data;

      let html = '';

      // Logo + name header
      if (client.logo_url) {
        html += `<div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
          <img src="/uploads/${escHtml(client.logo_url)}" alt="" style="width:48px;height:48px;border-radius:8px;object-fit:contain;border:1px solid #e0e0e0" />
          <h3>${escHtml(client.name)}</h3>
        </div>`;
      } else {
        html += `<h3 style="margin-bottom:12px">${escHtml(client.name)}</h3>`;
      }

      // Availability
      if (availability.status !== 'available') {
        const labels = { out_of_office: 'Out of Office', annual_leave: 'Annual Leave', meeting: 'In a Meeting', closed: 'Closed — Outside Business Hours' };
        html += `<div class="avail-bar avail-bar-${availability.status.replace(/_/g, '-')}" style="margin-bottom:8px">
          Status: ${labels[availability.status] || availability.status}${availability.note ? ' — ' + escHtml(availability.note) : ''}
        </div>`;
      }

      // Account / address
      const parts = [];
      if (client.account_number) parts.push(`Acct: ${escHtml(client.account_number)}`);
      if (client.address) parts.push(escHtml(client.address.replace(/\n/g, ', ')));
      if (parts.length) html += `<div class="sp-meta" style="display:block;margin-bottom:8px">${parts.join(' &bull; ')}</div>`;

      // Greeting
      if (client.greeting) html += `<div class="greeting-box" style="margin-bottom:8px">${escHtml(renderScript(client.greeting, client.name))}</div>`;

      // Script
      if (client.script) html += `<div class="script-box" style="margin-bottom:12px">${escHtml(renderScript(client.script, client.name))}</div>`;

      // Private notes
      if (client.private_notes) {
        html += `<div style="color:var(--danger);font-weight:600;padding:8px;background:#fff0f0;border-radius:4px;margin-bottom:8px">
          <strong>Private Notes:</strong> ${escHtml(client.private_notes)}
        </div>`;
      }

      // Contacts
      if (contacts && contacts.length) {
        html += '<h4 style="margin:8px 0 4px">Staff & Contacts</h4>';
        html += contacts.map((c) => {
          const btns = [];
          btns.push(`<button class="btn-take-msg" onclick="App.takeMessageForContact('${escHtml(c.client_id || clientId)}','${escHtml(c.name)}','${escHtml(c.phone || '')}','${escHtml(c.email || '')}')">Take a Message</button>`);
          if (c.phone) btns.push(`<button onclick="App.originateToContact('${escHtml(c.phone)}','${escHtml(clientId)}')">&#128222; Call</button>`);
          if (c.email) btns.push(`<button onclick="App.quickContactCompose('${escHtml(c.id)}','${escHtml(clientId)}','email','${escHtml(c.email)}','${escHtml(c.name)}')">&#9993; Email</button>`);
          return `<div class="sp-contact-item" style="margin-bottom:6px;padding:6px 8px;background:#f5f7fa;border-radius:6px">
            <strong>${escHtml(c.name)}</strong>${c.title ? ` — ${escHtml(c.title)}` : ''}
            ${c.phone ? `<span style="margin-left:8px;color:var(--text-muted)">${escHtml(c.phone)}</span>` : ''}
            <div class="sp-contact-actions">${btns.join('')}</div>
          </div>`;
        }).join('');
      }

      container.innerHTML = html;
    } catch (err) {
      container.innerHTML = `<p class="feedback error">${escHtml(err.message)}</p>`;
    }
  }

  /* ---- Take a Message for specific contact ---- */
  function takeMessageForContact(clientId, contactName, phone, email) {
    // Close any open modals
    closeClientBrowser();
    // Switch to console view
    switchView('console');
    // Pre-fill message form
    el('msg-client').value = clientId;
    onClientChange();
    el('msg-caller-name').value = contactName || '';
    el('msg-caller-phone').value = phone || '';
    el('msg-subject').value = `Message for ${contactName}`;
    el('msg-body').focus();
    toast(`Taking message for ${contactName}`, 'info');
  }

  /* ---- Audio Device Settings ---- */
  async function openAudioSettings() {
    el('audio-settings-modal').style.display = 'flex';
    try {
      // Request mic permission to enumerate devices
      await navigator.mediaDevices.getUserMedia({ audio: true }).then((s) => s.getTracks().forEach((t) => t.stop()));
      const devices = await navigator.mediaDevices.enumerateDevices();

      const outputDevices = devices.filter((d) => d.kind === 'audiooutput');
      const inputDevices = devices.filter((d) => d.kind === 'audioinput');

      const saved = JSON.parse(localStorage.getItem('as_audio_devices') || '{}');

      const outputSelect = el('audio-output-device');
      outputSelect.innerHTML = '<option value="default">System Default</option>' +
        outputDevices.map((d) => `<option value="${escHtml(d.deviceId)}"${d.deviceId === saved.output ? ' selected' : ''}>${escHtml(d.label || 'Speaker ' + d.deviceId.slice(0, 6))}</option>`).join('');

      const inputSelect = el('audio-input-device');
      inputSelect.innerHTML = '<option value="default">System Default</option>' +
        inputDevices.map((d) => `<option value="${escHtml(d.deviceId)}"${d.deviceId === saved.input ? ' selected' : ''}>${escHtml(d.label || 'Microphone ' + d.deviceId.slice(0, 6))}</option>`).join('');

      const ringSelect = el('audio-ring-device');
      ringSelect.innerHTML = '<option value="default">System Default</option>' +
        outputDevices.map((d) => `<option value="${escHtml(d.deviceId)}"${d.deviceId === saved.ring ? ' selected' : ''}>${escHtml(d.label || 'Speaker ' + d.deviceId.slice(0, 6))}</option>`).join('');
    } catch (err) {
      toast('Could not enumerate audio devices. Check browser permissions.', 'danger');
    }
  }

  function closeAudioSettings() {
    el('audio-settings-modal').style.display = 'none';
  }

  function saveAudioSettings() {
    const output = el('audio-output-device').value;
    const input = el('audio-input-device').value;
    const ring = el('audio-ring-device').value;
    localStorage.setItem('as_audio_devices', JSON.stringify({ output, input, ring }));

    // Apply ring device to ringer element
    const ringer = el('ringer');
    if (ringer && ringer.setSinkId && ring !== 'default') {
      ringer.setSinkId(ring).catch(() => {});
    }

    toast('Audio settings saved', 'success');
    closeAudioSettings();
  }

  function testAudio() {
    const output = el('audio-output-device').value;
    const statusEl = el('audio-test-status');
    statusEl.textContent = 'Playing...';
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      osc.frequency.value = 440;
      osc.connect(ctx.destination);
      osc.start();
      setTimeout(() => { osc.stop(); ctx.close(); statusEl.textContent = 'Done'; }, 1000);
    } catch {
      statusEl.textContent = 'Audio test failed';
    }
  }

  /* ---- Dark Mode ---- */
  function toggleDarkMode() {
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    if (isDark) {
      document.documentElement.removeAttribute('data-theme');
      localStorage.setItem('as_darkmode', '0');
      const btn = el('dark-mode-btn');
      if (btn) btn.title = 'Toggle dark mode';
    } else {
      document.documentElement.setAttribute('data-theme', 'dark');
      localStorage.setItem('as_darkmode', '1');
      const btn = el('dark-mode-btn');
      if (btn) btn.title = 'Switch to light mode';
    }
  }

  /* ---- Keyboard Shortcuts ---- */
  function handleKeyboardShortcut(e) {
    const tag = document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
      // Ctrl+Enter submits message form
      if (e.ctrlKey && e.key === 'Enter') {
        e.preventDefault();
        const form = el('message-form');
        if (form && el('message-form').style.display !== 'none') form.requestSubmit();
      }
      return;
    }
    if (!e.ctrlKey && e.key === 'Escape') {
      // Close any open modal
      document.querySelectorAll('.modal-overlay').forEach((m) => {
        if (m.style.display !== 'none') m.style.display = 'none';
      });
      const chatPanel = el('chat-panel');
      if (chatPanel && chatPanel.style.display !== 'none') chatPanel.style.display = 'none';
      return;
    }
    if (!e.ctrlKey) return;
    switch (e.key) {
      case 'a': case 'A': {
        e.preventDefault();
        const first = document.querySelector('.call-item');
        if (first) first.click();
        break;
      }
      case 'h': case 'H':
        e.preventDefault();
        if (activeCall) hangup();
        break;
      case 'l': case 'L':
        e.preventDefault();
        if (activeCall) toggleHold();
        break;
      case 'm': case 'M': {
        e.preventDefault();
        const mb = el('msg-body');
        if (mb) mb.focus();
        break;
      }
      case 'd': case 'D': {
        e.preventDefault();
        const cs = el('msg-client');
        if (cs) cs.focus();
        break;
      }
      case '/':
        e.preventDefault();
        showShortcuts();
        break;
    }
  }

  function showShortcuts() { el('shortcuts-modal').style.display = 'flex'; }
  function closeShortcuts() { el('shortcuts-modal').style.display = 'none'; }

  /* ---- Canned Response Autocomplete ---- */
  let cannedResponses = [];

  async function loadCannedResponsesForAutocomplete() {
    try {
      const data = await api('GET', '/canned');
      cannedResponses = data.canned_responses || [];
    } catch { cannedResponses = []; }
  }

  (function setupCannedAutocomplete() {
    document.addEventListener('DOMContentLoaded', () => {
      // Wait for init to attach
      setTimeout(() => {
        const msgBody = el('msg-body');
        if (!msgBody) return;

        // Wrap textarea for positioning
        const wrap = msgBody.parentElement;
        if (wrap && !wrap.classList.contains('canned-dropdown-wrap')) {
          wrap.classList.add('canned-dropdown-wrap');
        }

        const dropdown = document.createElement('div');
        dropdown.id = 'canned-dropdown';
        dropdown.className = 'canned-dropdown';
        dropdown.style.display = 'none';
        if (wrap) wrap.appendChild(dropdown);

        let activeIdx = -1;

        function hideDrop() { dropdown.style.display = 'none'; activeIdx = -1; }

        msgBody.addEventListener('input', () => {
          const val = msgBody.value;
          const lastWord = val.split(/\s/).pop();
          if (!lastWord.startsWith('/') || lastWord.length < 2) { hideDrop(); return; }
          const query = lastWord.slice(1).toLowerCase();
          const matches = cannedResponses.filter(
            (c) => c.shortcode.toLowerCase().startsWith(query)
          ).slice(0, 6);
          if (!matches.length) { hideDrop(); return; }
          activeIdx = -1;
          dropdown.innerHTML = matches.map((c, i) =>
            `<div class="canned-item" data-idx="${i}">
              <span class="canned-item-code">/${escHtml(c.shortcode)}</span>
              <span class="canned-item-title">${escHtml(c.title || c.body.substring(0, 40))}</span>
            </div>`
          ).join('');
          dropdown._matches = matches;
          dropdown.style.display = 'block';
        });

        msgBody.addEventListener('keydown', (e) => {
          if (dropdown.style.display === 'none') return;
          const items = dropdown.querySelectorAll('.canned-item');
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            activeIdx = Math.min(activeIdx + 1, items.length - 1);
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            activeIdx = Math.max(activeIdx - 1, 0);
          } else if (e.key === 'Enter' || e.key === 'Tab') {
            if (activeIdx >= 0) {
              e.preventDefault();
              insertCannedResponse(dropdown._matches[activeIdx]);
              hideDrop();
            }
          } else if (e.key === 'Escape') {
            hideDrop();
          }
          items.forEach((item, i) => item.classList.toggle('active', i === activeIdx));
        });

        dropdown.addEventListener('click', (e) => {
          const item = e.target.closest('.canned-item');
          if (!item) return;
          const idx = parseInt(item.dataset.idx);
          insertCannedResponse(dropdown._matches[idx]);
          hideDrop();
        });

        document.addEventListener('click', (e) => {
          if (!dropdown.contains(e.target) && e.target !== msgBody) hideDrop();
        });
      }, 500);
    });
  })();

  function insertCannedResponse(canned) {
    const msgBody = el('msg-body');
    if (!msgBody) return;
    const val = msgBody.value;
    const parts = val.split(/(\s)/);
    // Remove the last /shortcode fragment
    const last = parts[parts.length - 1];
    if (last && last.startsWith('/')) parts.pop();
    msgBody.value = parts.join('') + canned.body;
    msgBody.focus();
  }

  /* ---- Global Search ---- */
  let _searchTimer = null;

  function globalSearch(q) {
    clearTimeout(_searchTimer);
    const results = el('global-search-results');
    if (!results) return;
    if (!q || q.length < 2) { results.style.display = 'none'; return; }
    results.style.display = 'block';
    results.innerHTML = '<div style="padding:10px;color:var(--text-muted);font-size:0.82rem">Searching…</div>';
    _searchTimer = setTimeout(async () => {
      try {
        const data = await api('GET', `/search?q=${encodeURIComponent(q)}&limit=15`);
        const items = data.results || [];
        if (!items.length) {
          results.innerHTML = '<div style="padding:10px;color:var(--text-muted);font-size:0.82rem">No results</div>';
          return;
        }
        const typeIcon = { message: '&#128220;', contact: '&#128100;', client: '&#128188;', call: '&#128222;' };
        const typePill = { message: 'pill-blue', contact: 'pill-green', client: 'pill-orange', call: '' };
        results.innerHTML = items.map((r) => `
          <div class="search-result-item" onclick="App._handleSearchResult('${r.type}','${r.id}')"
               style="padding:8px 12px;border-bottom:1px solid var(--border);cursor:pointer;display:flex;flex-direction:column;gap:2px">
            <div style="display:flex;align-items:center;gap:6px">
              <span style="font-size:0.75rem">${typeIcon[r.type] || '?'}</span>
              <span class="pill ${typePill[r.type] || ''}" style="font-size:0.7rem;padding:1px 6px">${r.type}</span>
              <span style="font-size:0.85rem;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:200px">${escHtml(r.title || '—')}</span>
            </div>
            ${r.snippet ? `<div style="font-size:0.75rem;color:var(--text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escHtml(String(r.snippet))}</div>` : ''}
            ${r.client_name ? `<div style="font-size:0.72rem;color:var(--text-muted)">${escHtml(r.client_name)}</div>` : ''}
          </div>`).join('');
      } catch (err) {
        results.innerHTML = `<div style="padding:10px;color:var(--danger);font-size:0.82rem">Error: ${escHtml(err.message)}</div>`;
      }
    }, 250);
  }

  function closeSearch() {
    const results = el('global-search-results');
    if (results) results.style.display = 'none';
    const input = el('global-search-input');
    if (input) input.value = '';
  }

  async function _handleSearchResult(type, id) {
    closeSearch();
    if (type === 'message') {
      showMessageDetail(id);
    } else if (type === 'client') {
      // Open client in admin
      App.switchView('admin');
      // Load client directly
      try { Admin.openClientModal(id); } catch { /* ignore */ }
    } else if (type === 'call') {
      toast(`Call ID: ${id}`, 'info');
    } else if (type === 'contact') {
      toast(`Contact: ${id}`, 'info');
    }
  }

  /* ---- Follow-up Calls ---- */
  async function loadFollowUps() {
    const container = el('followups-list');
    if (!container) return;
    container.innerHTML = '<p class="empty-state">Loading...</p>';
    try {
      const data = await api('GET', '/calls/follow-ups/pending');
      const calls = data.calls || [];
      if (!calls.length) {
        container.innerHTML = '<p class="empty-state">No pending follow-ups</p>';
        return;
      }
      container.innerHTML = calls.map((c) => {
        const due = c.follow_up_at
          ? new Date(c.follow_up_at).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' })
          : 'No date';
        const overdue = c.follow_up_at && new Date(c.follow_up_at) < new Date();
        return `<div class="task-item" style="${overdue ? 'border-left:3px solid var(--danger)' : ''}">
          <div style="font-size:0.8rem;font-weight:600">${escHtml(c.client_name || '—')}</div>
          <div style="font-size:0.75rem;color:var(--text-muted)">${escHtml(c.caller_id_name || c.caller_id_num || 'Unknown')}</div>
          ${c.disposition_notes ? `<div style="font-size:0.72rem;color:var(--text-muted);margin-top:2px">${escHtml(c.disposition_notes)}</div>` : ''}
          <div style="font-size:0.72rem;color:${overdue ? 'var(--danger)' : 'var(--text-muted)'};margin-top:4px">Due: ${due}</div>
          <button class="btn btn-sm btn-secondary" style="margin-top:4px;font-size:0.72rem"
            onclick="App.completeFollowUp('${c.id}')">Mark Done</button>
        </div>`;
      }).join('');
    } catch (err) {
      container.innerHTML = `<p class="empty-state">Error: ${escHtml(err.message)}</p>`;
    }
  }

  async function completeFollowUp(callId) {
    try {
      await api('PATCH', `/calls/${callId}/disposition`, { disposition: 'follow_up_completed', follow_up_required: false });
      toast('Follow-up marked complete', 'success');
      loadFollowUps();
    } catch (err) {
      toast(`Error: ${err.message}`, 'danger');
    }
  }

  /* ---- Bulk Message Acknowledgment ---- */
  async function bulkAcknowledge() {
    const clientId = el('msg-filter-client')?.value || null;
    try {
      const body = clientId ? { client_id: clientId } : {};
      if (!clientId) {
        // No client filter — acknowledge by IDs of currently visible messages
        const rows = document.querySelectorAll('#messages-list [data-msg-id]');
        if (!rows.length) return toast('No messages to acknowledge', 'warning');
        body.ids = Array.from(rows).map((r) => r.dataset.msgId);
      }
      const data = await api('POST', '/messages/bulk/acknowledge', body);
      toast(`${data.updated} message${data.updated !== 1 ? 's' : ''} acknowledged`, 'success');
      loadMessages();
    } catch (err) {
      toast(`Error: ${err.message}`, 'danger');
    }
  }

  /* ---- Team Chat ---- */
  let chatOpen = false;
  let chatUnread = 0;

  function toggleChat() {
    const panel = el('chat-panel');
    chatOpen = !chatOpen;
    panel.style.display = chatOpen ? 'flex' : 'none';
    if (chatOpen) {
      chatUnread = 0;
      updateChatBadge();
      loadChatHistory();
      setTimeout(() => el('chat-input').focus(), 100);
    }
  }

  function updateChatBadge() {
    const badge = el('chat-unread-badge');
    if (!badge) return;
    if (chatUnread > 0) {
      badge.textContent = chatUnread;
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  }

  async function loadChatHistory() {
    try {
      const data = await api('GET', '/chat');
      const msgs = data.messages || [];
      const container = el('chat-messages');
      container.innerHTML = '';
      msgs.forEach((m) => appendChatMessage(m, false));
      container.scrollTop = container.scrollHeight;
    } catch { /* non-fatal */ }
  }

  function appendChatMessage(msg, scroll = true) {
    const container = el('chat-messages');
    if (!container) return;
    const isOwn = currentOperator && (msg.sender_id === currentOperator.id || msg.operator_id === currentOperator.id);
    const time = new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const div = document.createElement('div');
    div.className = `chat-msg${isOwn ? ' own' : ''}`;
    div.innerHTML = `
      ${!isOwn ? `<div class="chat-msg-sender">${escHtml(msg.sender_name || 'Operator')}</div>` : ''}
      <div>${escHtml(msg.body || msg.message || '')}</div>
      <div class="chat-msg-time">${time}</div>`;
    container.appendChild(div);
    if (scroll) container.scrollTop = container.scrollHeight;
    if (!chatOpen) {
      chatUnread++;
      updateChatBadge();
    }
  }

  async function sendChat() {
    const input = el('chat-input');
    const msg = input.value.trim();
    if (!msg) return;
    input.value = '';
    try {
      await api('POST', '/chat', { body: msg });
    } catch (err) {
      toast(`Chat error: ${err.message}`, 'danger');
    }
  }

  /* ---- Break / Status Management ---- */
  function toggleBreakMenu() {
    const menu = el('break-menu');
    menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
  }

  async function setOperatorStatus(status) {
    const menu = el('break-menu');
    if (menu) menu.style.display = 'none';
    try {
      if (status === 'ready') {
        await api('POST', '/operators/me/break/end', {});
      } else {
        await api('POST', '/operators/me/break/start', { break_type: status });
      }
      // Update UI
      const dotClasses = { ready: 'dot-ready', busy: 'dot-busy', break: 'dot-break',
        lunch: 'dot-lunch', training: 'dot-training', admin: 'dot-admin', offline: 'dot-offline' };
      const labels = { ready: 'Ready', busy: 'Busy', break: 'On Break', lunch: 'Lunch',
        training: 'Training', admin: 'Admin', offline: 'Offline' };
      const dot = el('break-status-dot');
      const label = el('break-status-label');
      if (dot) { dot.className = `status-dot ${dotClasses[status] || 'dot-offline'}`; }
      if (label) label.textContent = labels[status] || status;
      // Notify via socket
      if (socket) socket.emit('operator:status', { status });
    } catch (err) {
      toast(`Status error: ${err.message}`, 'danger');
    }
  }

  /* ---- Wallboard ---- */
  async function loadWallboard() {
    try {
      const data = await api('GET', '/wallboard');
      const s = data.stats;
      const setText = (id, val) => { const e = el(id); if (e) e.textContent = val; };
      setText('wb-queue', s.queue_count);
      setText('wb-calls', s.today_calls);
      const answeredEl = el('wb-answered');
      if (answeredEl) answeredEl.textContent = `${s.today_answered} answered`;
      setText('wb-missed', s.today_missed);
      setText('wb-messages', s.today_messages);
      setText('wb-sla', s.sla_met_pct !== null ? `${s.sla_met_pct}%` : '—');
      if (s.avg_handle_seconds !== null) {
        const m = Math.floor(s.avg_handle_seconds / 60);
        const sec = s.avg_handle_seconds % 60;
        setText('wb-aht', `${m}:${String(sec).padStart(2, '0')}`);
      } else {
        setText('wb-aht', '—');
      }
      setText('wb-unack', s.unack_messages);
      const ts = el('wb-last-updated');
      if (ts) ts.textContent = `Updated ${new Date().toLocaleTimeString()}`;
      // Render operator cards
      renderWallboardOperators();
    } catch (err) {
      toast(`Wallboard error: ${err.message}`, 'danger');
    }
  }

  function renderWallboardOperators() {
    const grid = el('wb-operators-grid');
    if (!grid) return;
    // Use the connected operators from the realtime operators list
    const ops = Array.from(document.querySelectorAll('#operators-list .operator-item'));
    if (!ops.length) {
      grid.innerHTML = '<p class="empty-state">No operators online</p>';
      return;
    }
    // Parse from operator list DOM (simpler than maintaining separate state)
    grid.innerHTML = ops.map((item) => {
      const name = item.querySelector('.op-name')?.textContent || '';
      const status = item.querySelector('.op-status')?.textContent || '';
      const dotClass = item.querySelector('.status-dot')?.className.split(' ').find((c) => c.startsWith('dot-')) || 'dot-offline';
      return `<div class="wb-op-card">
        <span class="status-dot ${dotClass}"></span>
        <div><div class="wb-op-name">${escHtml(name)}</div><div class="wb-op-status">${escHtml(status)}</div></div>
      </div>`;
    }).join('');
  }

  /* ---- QA Scoring ---- */
  let qaCallLogId = null;

  function openQA(callLogId) {
    qaCallLogId = callLogId;
    // Reset form
    ['qa-greeting','qa-script','qa-info','qa-tone','qa-msg'].forEach((id) => {
      const e = el(id); if (e) e.checked = false;
    });
    const overall = el('qa-overall');
    if (overall) { overall.value = 8; el('qa-overall-val').textContent = '8'; }
    const notes = el('qa-notes');
    if (notes) notes.value = '';
    el('qa-modal').style.display = 'flex';
  }

  function closeQA() {
    el('qa-modal').style.display = 'none';
    qaCallLogId = null;
  }

  async function submitQA() {
    if (!qaCallLogId) return;
    const overall = parseInt(el('qa-overall')?.value || '8');
    const notes = el('qa-notes')?.value.trim() || null;
    try {
      await api('POST', `/qa/call/${qaCallLogId}`, {
        greeting_correct:  !!(el('qa-greeting')?.checked),
        script_followed:   !!(el('qa-script')?.checked),
        info_accurate:     !!(el('qa-info')?.checked),
        professional_tone: !!(el('qa-tone')?.checked),
        message_complete:  !!(el('qa-msg')?.checked),
        overall,
        notes,
      });
      toast('QA score saved', 'success');
      closeQA();
    } catch (err) {
      toast(`QA error: ${err.message}`, 'danger');
    }
  }

  /* ---- Bootstrap ---- */
  /* ============================================================
     MOBILE NAVIGATION
     ============================================================ */
  let _activeMobilePanel = 'sidebar';

  function mobileSwitchPanel(panel) {
    // Only applies at mobile breakpoint
    if (window.innerWidth > 768) return;
    _activeMobilePanel = panel;
    ['sidebar', 'content', 'right-sidebar'].forEach((p) => {
      const el2 = document.querySelector(`.${p}`);
      if (el2) el2.classList.toggle('mobile-active', p === panel);
    });
    // Update tab bar active state
    const map = { 'sidebar': 'mob-tab-queue', 'content': 'mob-tab-form', 'right-sidebar': 'mob-tab-recent' };
    document.querySelectorAll('.mobile-tab-bar button').forEach((b) => b.classList.remove('active'));
    const activeTab = el(map[panel]);
    if (activeTab) activeTab.classList.add('active');
  }

  function toggleMobileMenu() {
    const drawer = el('mobile-nav-drawer');
    if (drawer) drawer.classList.toggle('open');
  }

  function closeMobileMenu() {
    const drawer = el('mobile-nav-drawer');
    if (drawer) drawer.classList.remove('open');
  }

  function closeSidebars() {
    const overlay = el('sidebar-overlay');
    const rs      = document.querySelector('.right-sidebar');
    if (rs)      rs.classList.remove('open');
    if (overlay) overlay.classList.remove('active');
  }

  // Close mobile menu on outside click
  document.addEventListener('click', (e) => {
    const drawer = el('mobile-nav-drawer');
    const btn    = el('mobile-menu-btn');
    if (drawer && drawer.classList.contains('open') &&
        !drawer.contains(e.target) && e.target !== btn) {
      drawer.classList.remove('open');
    }
    // Close search results when clicking outside
    const searchWrap = el('global-search-input')?.parentElement;
    const searchRes  = el('global-search-results');
    if (searchRes && searchRes.style.display !== 'none' && searchWrap && !searchWrap.contains(e.target)) {
      searchRes.style.display = 'none';
    }
    // Close template menu when clicking outside
    const templateMenu = el('msg-template-menu');
    const templateBtn  = el('msg-template-btn');
    if (templateMenu && templateMenu.style.display !== 'none' &&
        !templateMenu.contains(e.target) && e.target !== templateBtn) {
      templateMenu.style.display = 'none';
    }
  }, true);

  // On mobile: when a call is answered switch to form panel automatically
  function mobileAutoSwitchOnCall() {
    if (window.innerWidth <= 768) mobileSwitchPanel('content');
  }

  /* ============================================================
     WEB PUSH NOTIFICATIONS (operator console)
     ============================================================ */
  async function initPushPrompt() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
    try { await navigator.serviceWorker.register('/sw.js'); } catch { return; }
    if (Notification.permission === 'granted') {
      await _operatorSubscribePush(false); return;
    }
    if (Notification.permission === 'denied') return;
    // Show banner once per session
    if (!sessionStorage.getItem('op_push_dismissed')) {
      const banner = el('push-prompt');
      if (banner) banner.classList.remove('hidden');
      // Also show button in mobile drawer
      const mobBtn = el('mob-push-btn');
      if (mobBtn) mobBtn.style.display = '';
    }
  }

  async function enablePushNotifications() {
    el('push-prompt')?.classList.add('hidden');
    await _operatorSubscribePush(true);
  }

  function dismissPushPrompt() {
    el('push-prompt')?.classList.add('hidden');
    sessionStorage.setItem('op_push_dismissed', '1');
  }

  async function togglePushNotifications() {
    if (Notification.permission === 'granted') {
      // Already granted — ensure subscribed
      await _operatorSubscribePush(true);
      toast('Push notifications enabled', 'success');
    } else {
      await enablePushNotifications();
    }
  }

  async function _operatorSubscribePush(requestPermission) {
    try {
      if (requestPermission) {
        const perm = await Notification.requestPermission();
        if (perm !== 'granted') { toast('Permission denied for notifications', 'warning'); return; }
      }
      const reg = await navigator.serviceWorker.ready;
      const keyResp = await fetch('/api/push/vapid-public-key');
      if (!keyResp.ok) return;
      const { publicKey } = await keyResp.json();
      if (!publicKey) return;

      const existing     = await reg.pushManager.getSubscription();
      const subscription = existing || await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: _urlBase64ToUint8Array(publicKey),
      });
      await api('POST', '/push/subscribe', {
        subscription: subscription.toJSON(),
        userAgent: _getBrowserHint(),
      });
      toast('Push notifications active', 'success', 2000);
    } catch (err) {
      console.warn('[App] Push subscribe failed:', err.message);
    }
  }

  function _getBrowserHint() {
    const ua = navigator.userAgent;
    if (/Chrome\/(\d+)/.test(ua)) return `Chrome ${RegExp.$1}`;
    if (/Firefox\/(\d+)/.test(ua)) return `Firefox ${RegExp.$1}`;
    if (/Safari\/(\d+)/.test(ua) && !/Chrome/.test(ua)) return 'Safari';
    return 'Unknown';
  }

  function _urlBase64ToUint8Array(b64) {
    const padding = '='.repeat((4 - b64.length % 4) % 4);
    const base64  = (b64 + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw     = atob(base64);
    return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
  }

  document.addEventListener('DOMContentLoaded', init);

  /* ---- Public interface ---- */
  return {
    logout, pickupCall, hangup, toggleHold, showTransfer, transfer,
    viewScript, clearMessageForm, saveMessageOnly, loadMessages,
    showMessageDetail, closeMsgDetail, redeliverMessage,
    aiSummarise, aiTranslate, aiSuggestReply,
    switchView, onClientChange, onCallTypeChange,
    verify2FA, cancel2FA, startDemo,
    showMyProfile, closeProfile, showPwStrength, changePassword,
    showForgotPassword, showLogin, doForgotPassword, doResetPassword,
    setup2FA, confirm2FA, close2FASetup, disable2FA, copyBackupCodes, showBackupCodeEntry,
    // Noticeboard
    openNoticeEditor, closeNoticeEditor, saveNotice,
    // Disposition
    saveDisposition, skipDisposition,
    // Quick contact
    quickContactCompose, closeQuickContact, sendQuickContact,
    // Outbound
    openOutbound, closeOutbound, makeOutboundCall, originateToContact,
    // Client browser
    openClientBrowser, closeClientBrowser, loadClientScreen, takeMessageForContact,
    // Audio
    openAudioSettings, closeAudioSettings, saveAudioSettings, testAudio,
    // Dark mode
    toggleDarkMode,
    // Shortcuts
    showShortcuts, closeShortcuts,
    // Chat
    toggleChat, sendChat,
    // Break / status
    toggleBreakMenu, setOperatorStatus,
    // Wallboard
    loadWallboard,
    // QA
    openQA, closeQA, submitQA,
    // Mobile nav
    mobileSwitchPanel, toggleMobileMenu, closeMobileMenu, closeSidebars, mobileAutoSwitchOnCall,
    // Push notifications
    enablePushNotifications, dismissPushPrompt, togglePushNotifications,
    // Global search
    globalSearch, closeSearch, _handleSearchResult,
    // Follow-ups
    loadFollowUps, completeFollowUp,
    // Notification preferences
    saveNotificationPrefs,
    // Supervisor monitoring
    supervisorMonitor,
    // Message templates
    toggleTemplateMenu, applyMessageTemplate,
    // Bulk actions
    bulkAcknowledge,
    // Caller ID hint
    onCallerPhoneChanged, confirmCallerPhone,
    _api: api,
    _toast: toast,
    _escHtml: escHtml,
    _clients: () => clients,
  };

})();

/* ============================================================
   Admin Module
   ============================================================ */

const Admin = (() => {
  const api = (...args) => App._api(...args);
  const toast = (...args) => App._toast(...args);
  const escHtml = (...args) => App._escHtml(...args);
  const el = (id) => document.getElementById(id);

  let initialized = false;
  let editingClientId = null;
  let editingContactId = null;
  let editingOperatorId = null;

  // Form builder state
  let formFields = [];
  // Info sheets state
  let infoSheets = [];
  // Web links state
  let webLinks = [];

  /* ---- Init ---- */
  async function init() {
    if (!initialized) initialized = true;
    showSection('clients');
  }

  function showSection(name, evt) {
    document.querySelectorAll('.admin-section').forEach((s) => s.style.display = 'none');
    document.querySelectorAll('.admin-nav-item').forEach((b) => b.classList.remove('active'));
    el(`admin-${name}`).style.display = 'block';
    if (evt && evt.target) evt.target.classList.add('active');

    if (name === 'clients') loadClients();
    else if (name === 'operators') loadOperators();
    else if (name === 'availability') loadAvailabilitySection();
    else if (name === 'reports') loadReports();
    else if (name === 'billing') loadBillingSection();
    else if (name === 'settings') loadSettings();
    else if (name === 'performance') loadPerformance();
    else if (name === 'canned') loadCannedResponses();
    else if (name === 'analytics') Analytics.load();
    else if (name === 'leaderboard') Leaderboard.load();
    else if (name === 'sms') SMSInbox.load();
    else if (name === 'appointments') AppointmentsPanel.load();
    else if (name === 'shifts') ShiftsPanel.load();
    else if (name === 'ivr') IVRPanel.load();
    else if (name === 'voicemail') VoicemailPanel.load();
    else if (name === 'callbacks') CallbacksPanel.load();
    else if (name === 'scripts') ScriptsPanel.load();
    else if (name === 'dids') DIDsPanel.load();
    else if (name === 'routing') RoutingPanel.load();
    else if (name === 'audit') AuditPanel.load();
    else if (name === 'knowledge') KnowledgeAdmin.load();
    else if (name === 'qa') QAPanel.load();
    else if (name === 'skills') SkillsPanel.load();
    else if (name === 'dnc') DncPanel.load();
    else if (name === 'transcription') TranscriptionPanel.load();
    else if (name === 'whatsapp') WAInbox.load();
    else if (name === 'csat') CsatPanel.load();
    else if (name === 'schedules') SchedulesPanel.load();
  }

  /* ---- Client Modal Tabs ---- */
  function showClientTab(name, btn) {
    document.querySelectorAll('.ctab').forEach((t) => t.style.display = 'none');
    document.querySelectorAll('.modal-tab').forEach((b) => b.classList.remove('active'));
    const tab = el(`ctab-${name}`);
    if (tab) tab.style.display = '';
    if (btn) btn.classList.add('active');

    // Lazy-load tab content that requires server data
    if (name === 'contacts' && editingClientId) loadContacts(editingClientId);
    if (name === 'departments' && editingClientId) loadDepartments(editingClientId);
    if (name === 'lists' && editingClientId) { loadVip(editingClientId); loadIgnore(editingClientId); }
    if (name === 'files' && editingClientId) loadClientFiles(editingClientId);
    if (name === 'news' && editingClientId) loadClientNewsAdmin(editingClientId);
    if (name === 'portal' && editingClientId) loadPortalUsers(editingClientId);
    if (name === 'webhooks' && editingClientId) loadWebhooks(editingClientId);
    if (name === 'msgtpl' && editingClientId) loadMsgTemplates();
    if (name === 'holidays' && editingClientId) loadHolidays();
  }

  /* ---- Clients ---- */
  let allClients = [];

  async function loadClients() {
    const tbody = el('clients-tbody');
    tbody.innerHTML = '<tr><td colspan="6" class="empty-state">Loading...</td></tr>';
    try {
      const data = await api('GET', '/clients');
      allClients = data.clients;
      renderClientsTable(allClients);
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="6" class="empty-state">Error: ${escHtml(err.message)}</td></tr>`;
    }
  }

  function searchClients() {
    const q = el('client-search').value.toLowerCase();
    const filtered = allClients.filter(
      (c) => c.name.toLowerCase().includes(q) || c.account_number.toLowerCase().includes(q)
    );
    renderClientsTable(filtered);
  }

  function renderClientsTable(clients) {
    const tbody = el('clients-tbody');
    if (!clients.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="empty-state">No clients found</td></tr>';
      return;
    }
    tbody.innerHTML = clients.map((c) => `
      <tr>
        <td>${escHtml(c.account_number)}</td>
        <td><strong>${escHtml(c.name)}</strong></td>
        <td><code>${(c.dids || []).join(', ') || '—'}</code></td>
        <td>${escHtml(c.timezone)}</td>
        <td><span class="pill ${c.is_active ? 'pill-green' : 'pill-red'}">${c.is_active ? 'Active' : 'Inactive'}</span></td>
        <td>
          <button class="btn btn-sm btn-secondary" onclick="Admin.openClientModal('${c.id}')">Edit</button>
          <button class="btn btn-sm ${c.is_active ? 'btn-danger' : 'btn-secondary'}" onclick="Admin.toggleClient('${c.id}', ${!c.is_active})">
            ${c.is_active ? 'Deactivate' : 'Activate'}
          </button>
        </td>
      </tr>
    `).join('');
  }

  async function openClientModal(clientId) {
    editingClientId = clientId || null;
    el('client-modal-title').textContent = clientId ? 'Edit Client' : 'Add Client';
    el('cf-account').disabled = !!clientId;
    formFields = [];
    infoSheets = [];
    webLinks = [];

    // Reset form
    el('client-form').reset();
    el('cf-active').checked = true;
    el('da-phone-call').checked = true;
    el('da-email').checked = true;
    el('da-sms').checked = false;
    renderLogoPreview(null);

    // Show extra tabs only when editing
    const tabsVisible = !!clientId;
    ['tab-contacts-btn', 'tab-depts-btn', 'tab-lists-btn', 'tab-files-btn', 'tab-news-btn', 'tab-portal-btn', 'tab-webhooks-btn', 'tab-msgtpl-btn', 'tab-holidays-btn'].forEach((id) => {
      const btn = el(id);
      if (btn) btn.style.display = tabsVisible ? '' : 'none';
    });

    // Reset to first tab
    showClientTab('basic', document.querySelector('.modal-tab'));

    // Render opening times grid
    renderOpeningTimesGrid({});

    if (clientId) {
      try {
        const data = await api('GET', `/clients/${clientId}`);
        const c = data.client;

        el('cf-account').value = c.account_number;
        el('cf-name').value = c.name;
        el('cf-dids').value = (c.dids || []).join(', ');
        el('cf-timezone').value = c.timezone;
        el('cf-active').checked = c.is_active;
        el('cf-greeting').value = c.greeting || '';
        el('cf-script').value = c.script || '';
        el('cf-notes').value = c.notes || '';
        el('cf-address').value = c.address || '';
        el('cf-outbound-cli').value = c.outbound_caller_id || '';
        el('cf-private-notes').value = c.private_notes || '';
        el('cf-email-template').value = c.email_template || '';

        // Logo
        renderLogoPreview(c.logo_url || null);

        // Delivery actions
        const da = c.delivery_actions || { phone_call: true, email: true, sms: false };
        el('da-phone-call').checked = !!da.phone_call;
        el('da-email').checked = !!da.email;
        el('da-sms').checked = !!da.sms;
        el('da-whatsapp').checked = !!da.whatsapp;
        el('da-slack').checked    = !!da.slack;
        el('da-teams').checked    = !!da.teams;
        el('da-telegram').checked = !!da.telegram;

        // New delivery channels
        el('cf-whatsapp').value      = c.whatsapp_number   || '';
        el('cf-telegram').value      = c.telegram_chat_id  || '';
        el('cf-slack-webhook').value = c.slack_webhook      || '';
        el('cf-teams-webhook').value = c.teams_webhook      || '';

        // Escalation / SLA
        const escRules = Array.isArray(c.escalation_rules) ? c.escalation_rules : [];
        el('cf-escalate-mins').value = escRules.length ? (escRules[0].after_minutes || 0) : 0;
        el('cf-sla-seconds').value   = c.sla_answer_seconds || 30;
        if (el('cf-sla-abandon')) el('cf-sla-abandon').value = c.sla_abandon_threshold || 3;
        if (el('cf-sla-minutes')) el('cf-sla-minutes').value = c.sla_minutes || 60;
        if (el('cf-csat-enabled')) el('cf-csat-enabled').checked = !!c.csat_enabled;

        // SMTP
        el('cf-smtp-host').value = c.smtp_host || '';
        el('cf-smtp-port').value = c.smtp_port || '';
        el('cf-smtp-user').value = c.smtp_user || '';
        el('cf-smtp-from').value = c.smtp_from || '';
        // smtp_pass intentionally blank (placeholder tells user)

        // Opening times
        renderOpeningTimesGrid(c.opening_times || {});

        // Info sheets
        infoSheets = Array.isArray(c.info_sheets) ? c.info_sheets : [];
        renderInfoSheetsList();

        // Web links
        webLinks = Array.isArray(c.web_links) ? c.web_links : [];
        renderWebLinksList();

        // Custom form
        formFields = Array.isArray(c.custom_form) ? c.custom_form : [];
        renderFormBuilder();

      } catch (err) {
        toast(`Failed to load client: ${err.message}`, 'danger');
        return;
      }
    } else {
      renderFormBuilder();
      renderInfoSheetsList();
      renderWebLinksList();
    }

    el('client-modal').style.display = 'flex';
  }

  function closeClientModal() {
    el('client-modal').style.display = 'none';
    editingClientId = null;
  }

  async function saveClient() {
    const btn = el('cf-submit');
    btn.disabled = true;
    try {
      const didsRaw = el('cf-dids').value.trim();
      const dids = didsRaw ? didsRaw.split(',').map((d) => d.trim()).filter(Boolean) : [];

      // Collect opening times
      const openingTimes = {};
      const days = ['monday','tuesday','wednesday','thursday','friday','saturday','sunday'];
      days.forEach((day) => {
        const closedEl = el(`ot-${day}-closed`);
        const openEl = el(`ot-${day}-open`);
        const closeEl = el(`ot-${day}-close`);
        openingTimes[day] = {
          closed: closedEl ? closedEl.checked : false,
          open: openEl ? openEl.value : '09:00',
          close: closeEl ? closeEl.value : '17:30',
        };
      });

      const delivery_actions = {
        phone_call: el('da-phone-call').checked,
        email:      el('da-email').checked,
        sms:        el('da-sms').checked,
        whatsapp:   el('da-whatsapp').checked,
        slack:      el('da-slack').checked,
        teams:      el('da-teams').checked,
        telegram:   el('da-telegram').checked,
      };

      const escalateMins = parseInt(el('cf-escalate-mins').value) || 0;
      const escalation_rules = escalateMins > 0 ? [{ after_minutes: escalateMins }] : [];

      const smtpPass = el('cf-smtp-pass').value;
      const body = {
        name: el('cf-name').value.trim(),
        dids,
        timezone: el('cf-timezone').value,
        is_active: el('cf-active').checked,
        greeting: el('cf-greeting').value.trim() || null,
        script: el('cf-script').value.trim() || null,
        notes: el('cf-notes').value.trim() || null,
        address: el('cf-address').value.trim() || null,
        opening_times: openingTimes,
        info_sheets: infoSheets,
        web_links: webLinks,
        custom_form: formFields,
        delivery_actions,
        smtp_host: el('cf-smtp-host').value.trim() || null,
        smtp_port: parseInt(el('cf-smtp-port').value) || null,
        smtp_user: el('cf-smtp-user').value.trim() || null,
        smtp_from: el('cf-smtp-from').value.trim() || null,
        outbound_caller_id: el('cf-outbound-cli').value.trim() || null,
        private_notes: el('cf-private-notes').value.trim() || null,
        email_template: el('cf-email-template').value.trim() || null,
        whatsapp_number:  el('cf-whatsapp').value.trim() || null,
        telegram_chat_id: el('cf-telegram').value.trim() || null,
        slack_webhook:    el('cf-slack-webhook').value.trim() || null,
        teams_webhook:    el('cf-teams-webhook').value.trim() || null,
        escalation_rules,
        sla_answer_seconds:    parseInt(el('cf-sla-seconds').value) || 30,
        sla_abandon_threshold: parseInt(el('cf-sla-abandon')?.value) || 3,
        sla_minutes:           parseInt(el('cf-sla-minutes')?.value) || 60,
        csat_enabled: el('cf-csat-enabled')?.checked ?? false,
      };
      if (smtpPass) body.smtp_pass = smtpPass;

      if (editingClientId) {
        await api('PUT', `/clients/${editingClientId}`, body);
        toast('Client updated', 'success');
      } else {
        body.account_number = el('cf-account').value.trim();
        await api('POST', '/clients', body);
        toast('Client created', 'success');
      }
      closeClientModal();
      loadClients();
    } catch (err) {
      toast(`Error: ${err.message}`, 'danger');
    } finally {
      btn.disabled = false;
    }
  }

  async function toggleClient(clientId, setActive) {
    try {
      await api('PUT', `/clients/${clientId}`, { is_active: setActive });
      toast(`Client ${setActive ? 'activated' : 'deactivated'}`, 'success');
      loadClients();
    } catch (err) {
      toast(`Error: ${err.message}`, 'danger');
    }
  }

  /* ---- Opening Times Grid ---- */
  function renderOpeningTimesGrid(times) {
    const grid = el('opening-times-grid');
    if (!grid) return;
    const days = ['monday','tuesday','wednesday','thursday','friday','saturday','sunday'];
    const labels = { monday:'Mon',tuesday:'Tue',wednesday:'Wed',thursday:'Thu',friday:'Fri',saturday:'Sat',sunday:'Sun' };
    grid.innerHTML = days.map((day) => {
      const t = times[day] || { closed: false, open: '09:00', close: '17:30' };
      return `
        <div class="opening-row">
          <span class="opening-day">${labels[day]}</span>
          <label class="toggle" title="Closed">
            <input type="checkbox" id="ot-${day}-closed" ${t.closed ? 'checked' : ''} onchange="Admin.toggleDayClosed('${day}')" />
            <span></span>
          </label>
          <span style="font-size:0.72rem;color:var(--text-muted)">Closed</span>
          <input type="time" id="ot-${day}-open" value="${t.open || '09:00'}" ${t.closed ? 'disabled' : ''} />
          <span style="color:var(--text-muted);font-size:0.8rem">–</span>
          <input type="time" id="ot-${day}-close" value="${t.close || '17:30'}" ${t.closed ? 'disabled' : ''} />
        </div>
      `;
    }).join('');
  }

  function toggleDayClosed(day) {
    const closed = el(`ot-${day}-closed`).checked;
    el(`ot-${day}-open`).disabled = closed;
    el(`ot-${day}-close`).disabled = closed;
  }

  /* ---- Info Sheets ---- */
  function renderInfoSheetsList() {
    const container = el('info-sheets-list');
    if (!container) return;
    if (!infoSheets.length) {
      container.innerHTML = '<p style="font-size:0.8rem;color:var(--text-muted)">No information sheets added yet.</p>';
      return;
    }
    container.innerHTML = infoSheets.map((s, i) => `
      <div class="info-sheet-editor">
        <div style="display:flex;gap:8px;align-items:center;margin-bottom:6px">
          <input type="text" value="${escHtml(s.title)}" placeholder="Sheet title"
            oninput="Admin.updateInfoSheet(${i},'title',this.value)"
            style="flex:1;background:var(--bg);border:1px solid var(--border);color:var(--text);border-radius:var(--radius);padding:5px 8px;font-size:0.85rem" />
          <button type="button" class="btn btn-sm btn-danger" onclick="Admin.removeInfoSheet(${i})">&#10005;</button>
        </div>
        <textarea placeholder="Sheet content..." rows="4"
          oninput="Admin.updateInfoSheet(${i},'content',this.value)"
          style="width:100%;background:var(--bg);border:1px solid var(--border);color:var(--text);border-radius:var(--radius);padding:6px 8px;font-size:0.82rem;resize:vertical;font-family:inherit">${escHtml(s.content)}</textarea>
      </div>
    `).join('');
  }

  function addInfoSheet() {
    infoSheets.push({ title: '', content: '' });
    renderInfoSheetsList();
  }

  function updateInfoSheet(idx, field, value) {
    if (infoSheets[idx]) infoSheets[idx][field] = value;
  }

  function removeInfoSheet(idx) {
    infoSheets.splice(idx, 1);
    renderInfoSheetsList();
  }

  /* ---- Web Links ---- */
  function renderWebLinksList() {
    const container = el('web-links-list');
    if (!container) return;
    if (!webLinks.length) {
      container.innerHTML = '<p style="font-size:0.8rem;color:var(--text-muted)">No web links added yet.</p>';
      return;
    }
    container.innerHTML = webLinks.map((l, i) => `
      <div class="info-sheet-editor" style="display:flex;gap:8px;align-items:center">
        <input type="text" value="${escHtml(l.title)}" placeholder="Link title (e.g. Patient Portal)"
          oninput="Admin.updateWebLink(${i},'title',this.value)"
          style="flex:1;background:var(--bg);border:1px solid var(--border);color:var(--text);border-radius:var(--radius);padding:5px 8px;font-size:0.85rem" />
        <input type="url" value="${escHtml(l.url)}" placeholder="https://..."
          oninput="Admin.updateWebLink(${i},'url',this.value)"
          style="flex:2;background:var(--bg);border:1px solid var(--border);color:var(--text);border-radius:var(--radius);padding:5px 8px;font-size:0.85rem" />
        <button type="button" class="btn btn-sm btn-danger" onclick="Admin.removeWebLink(${i})">&#10005;</button>
      </div>
    `).join('');
  }

  function addWebLink() {
    webLinks.push({ title: '', url: '' });
    renderWebLinksList();
  }

  function updateWebLink(idx, field, value) {
    if (webLinks[idx]) webLinks[idx][field] = value;
  }

  function removeWebLink(idx) {
    webLinks.splice(idx, 1);
    renderWebLinksList();
  }

  /* ---- Custom Form Builder ---- */
  function renderFormBuilder() {
    const container = el('form-builder-list');
    if (!container) return;
    if (!formFields.length) {
      container.innerHTML = '<p style="font-size:0.8rem;color:var(--text-muted)">No custom fields added yet.</p>';
      return;
    }
    container.innerHTML = formFields.map((f, i) => `
      <div class="form-builder-field">
        <div class="form-builder-row">
          <select onchange="Admin.updateField(${i},'type',this.value)" style="background:var(--bg);border:1px solid var(--border);color:var(--text);border-radius:var(--radius);padding:5px 8px;font-size:0.82rem;min-width:120px">
            <option value="text"      ${f.type==='text'     ?'selected':''}>Text</option>
            <option value="textarea"  ${f.type==='textarea' ?'selected':''}>Textarea</option>
            <option value="select"    ${f.type==='select'   ?'selected':''}>Dropdown</option>
            <option value="tel"       ${f.type==='tel'      ?'selected':''}>Phone</option>
            <option value="email"     ${f.type==='email'    ?'selected':''}>Email</option>
            <option value="checkbox"  ${f.type==='checkbox' ?'selected':''}>Checkbox</option>
          </select>
          <input type="text" value="${escHtml(f.label)}" placeholder="Field label"
            oninput="Admin.updateField(${i},'label',this.value)"
            style="flex:1;background:var(--bg);border:1px solid var(--border);color:var(--text);border-radius:var(--radius);padding:5px 8px;font-size:0.85rem" />
          <label style="display:flex;align-items:center;gap:6px;font-size:0.78rem;color:var(--text-muted);white-space:nowrap">
            <input type="checkbox" ${f.required?'checked':''} onchange="Admin.updateField(${i},'required',this.checked)" /> Required
          </label>
          ${f.type === 'textarea' ? `
          <label style="display:flex;align-items:center;gap:6px;font-size:0.78rem;color:var(--text-muted);white-space:nowrap">
            <input type="checkbox" ${f.spellcheck?'checked':''} onchange="Admin.updateField(${i},'spellcheck',this.checked)" /> Spellcheck
          </label>` : ''}
          <button type="button" class="btn btn-sm btn-danger" onclick="Admin.removeField(${i})">&#10005;</button>
        </div>
        ${f.type === 'select' ? `
        <div style="margin-top:6px">
          <input type="text" value="${escHtml((f.options||[]).join(', '))}" placeholder="Options (comma-separated)"
            oninput="Admin.updateFieldOptions(${i}, this.value)"
            style="width:100%;background:var(--bg);border:1px solid var(--border);color:var(--text);border-radius:var(--radius);padding:5px 8px;font-size:0.82rem" />
        </div>` : ''}
        <div style="margin-top:6px;display:flex;gap:6px;align-items:center">
          <span style="font-size:0.72rem;color:var(--text-muted);white-space:nowrap">Show when:</span>
          <select onchange="Admin.updateFieldShowWhen(${i},'field',this.value)" style="font-size:0.78rem;background:var(--bg);border:1px solid var(--border);color:var(--text);border-radius:var(--radius);padding:3px 6px">
            <option value="">Always</option>
            ${formFields.filter((_,j) => j !== i).map((other) => `<option value="${escHtml(other.id)}" ${f.show_when?.field === other.id ? 'selected' : ''}>${escHtml(other.label || other.id)}</option>`).join('')}
          </select>
          ${f.show_when?.field ? `
          <span style="font-size:0.72rem;color:var(--text-muted)">=</span>
          <input type="text" value="${escHtml(f.show_when?.value || '')}" placeholder="value"
            oninput="Admin.updateFieldShowWhen(${i},'value',this.value)"
            style="width:100px;font-size:0.78rem;background:var(--bg);border:1px solid var(--border);color:var(--text);border-radius:var(--radius);padding:3px 6px" />` : ''}
        </div>
      </div>
    `).join('');
  }

  function addFormField() {
    formFields.push({ id: `f${Date.now()}`, type: 'text', label: '', required: false, spellcheck: false, options: [] });
    renderFormBuilder();
  }

  function updateField(idx, key, value) {
    if (formFields[idx]) {
      formFields[idx][key] = value;
      if (key === 'type') renderFormBuilder(); // re-render to show/hide spellcheck/options
    }
  }

  function updateFieldOptions(idx, value) {
    if (formFields[idx]) {
      formFields[idx].options = value.split(',').map((o) => o.trim()).filter(Boolean);
    }
  }

  function updateFieldShowWhen(idx, key, value) {
    if (!formFields[idx]) return;
    if (key === 'field') {
      if (!value) {
        delete formFields[idx].show_when;
      } else {
        formFields[idx].show_when = formFields[idx].show_when || {};
        formFields[idx].show_when.field = value;
      }
      renderFormBuilder();
    } else if (key === 'value') {
      if (formFields[idx].show_when) {
        formFields[idx].show_when.value = value;
      }
    }
  }

  function removeField(idx) {
    formFields.splice(idx, 1);
    renderFormBuilder();
  }

  /* ---- Contacts ---- */
  async function loadContacts(clientId) {
    const tbody = el('contacts-tbody');
    tbody.innerHTML = '<tr><td colspan="7" class="empty-state">Loading...</td></tr>';
    try {
      const data = await api('GET', `/clients/${clientId}/contacts`);
      renderContactsTable(data.contacts, clientId);
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="7" class="empty-state">Error</td></tr>`;
    }
  }

  function renderContactsTable(contacts, clientId) {
    const tbody = el('contacts-tbody');
    if (!contacts.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="empty-state">No contacts yet</td></tr>';
      return;
    }
    const actionLabels = { message: 'Message', transfer: 'Transfer', both: 'Msg+Xfer' };
    tbody.innerHTML = contacts.map((c) => `
      <tr${c.is_private ? ' class="contact-private-row"' : ''}>
        <td>${escHtml(c.name)}${c.is_private ? ' <span class="private-badge">PRIVATE</span>' : ''}</td>
        <td>${escHtml(c.department_name || '—')}</td>
        <td>${escHtml(c.phone || '—')}</td>
        <td>${escHtml(c.email || '—')}${c.notify_email ? ' ✉' : ''}</td>
        <td><span class="pill pill-blue">${actionLabels[c.call_action] || c.call_action}</span></td>
        <td>${c.priority}</td>
        <td>
          <button class="btn btn-sm btn-secondary" onclick="Admin.openContactModal('${c.id}')">Edit</button>
          <button class="btn btn-sm btn-danger" onclick="Admin.deleteContact('${clientId}','${c.id}')">Del</button>
        </td>
      </tr>
    `).join('');
  }

  async function openContactModal(contactId) {
    editingContactId = contactId || null;
    el('contact-modal-title').textContent = contactId ? 'Edit Contact' : 'Add Contact';
    el('contact-form').reset();
    el('ctf-priority').value = 1;
    el('ctf-notify-email').checked = true;
    el('ctf-call-action').value = 'message';
    el('ctf-ext-row').style.display = 'none';
    el('ctf-avail-type').value = 'always';
    el('ctf-avail-schedule-wrap').style.display = 'none';

    // Load departments into select
    const deptSelect = el('ctf-department');
    deptSelect.innerHTML = '<option value="">— None —</option>';
    if (editingClientId) {
      try {
        const depts = await api('GET', `/clients/${editingClientId}/departments`);
        (depts.departments || []).forEach((d) => {
          const opt = document.createElement('option');
          opt.value = d.id;
          opt.textContent = d.name;
          deptSelect.appendChild(opt);
        });
      } catch { /* no depts yet */ }
    }

    if (contactId && editingClientId) {
      try {
        const data = await api('GET', `/clients/${editingClientId}/contacts`);
        const contact = data.contacts.find((c) => c.id === contactId);
        if (contact) {
          el('ctf-name').value = contact.name || '';
          el('ctf-title').value = contact.title || '';
          el('ctf-phone').value = contact.phone || '';
          el('ctf-email').value = contact.email || '';
          el('ctf-sms').value = contact.sms_number || '';
          el('ctf-priority').value = contact.priority || 1;
          el('ctf-notify-email').checked = !!contact.notify_email;
          el('ctf-notify-sms').checked = !!contact.notify_sms;
          el('ctf-private').checked = !!contact.is_private;
          el('ctf-call-action').value = contact.call_action || 'message';
          el('ctf-transfer-ext').value = contact.transfer_extension || '';
          el('ctf-message-note').value = contact.message_note || '';
          if (contact.department_id) deptSelect.value = contact.department_id;
          // Availability
          const availType = contact.availability_type || 'always';
          el('ctf-avail-type').value = availType;
          if (availType === 'custom') {
            el('ctf-avail-schedule-wrap').style.display = '';
            renderContactAvailGrid(contact.availability_schedule || {});
          } else {
            el('ctf-avail-schedule-wrap').style.display = 'none';
          }
          onCallActionChange();
        }
      } catch (err) {
        toast(`Failed to load contact: ${err.message}`, 'danger');
      }
    }

    el('contact-modal').style.display = 'flex';
  }

  function onCallActionChange() {
    const action = el('ctf-call-action').value;
    el('ctf-ext-row').style.display = (action === 'transfer' || action === 'both') ? 'flex' : 'none';
  }

  function onAvailTypeChange() {
    const type = el('ctf-avail-type').value;
    const wrap = el('ctf-avail-schedule-wrap');
    if (type === 'custom') {
      wrap.style.display = '';
      if (!el('cta-monday-closed')) renderContactAvailGrid({});
    } else {
      wrap.style.display = 'none';
    }
  }

  function renderContactAvailGrid(schedule) {
    const grid = el('ctf-avail-grid');
    if (!grid) return;
    const days = ['monday','tuesday','wednesday','thursday','friday','saturday','sunday'];
    const labels = { monday:'Mon',tuesday:'Tue',wednesday:'Wed',thursday:'Thu',friday:'Fri',saturday:'Sat',sunday:'Sun' };
    grid.innerHTML = days.map((day) => {
      const t = schedule[day] || { closed: false, open: '09:00', close: '17:30' };
      return `
        <div class="opening-row">
          <span class="opening-day">${labels[day]}</span>
          <label class="toggle" title="Closed">
            <input type="checkbox" id="cta-${day}-closed" ${t.closed ? 'checked' : ''} onchange="Admin.toggleContactAvailDay('${day}')" />
            <span></span>
          </label>
          <span style="font-size:0.72rem;color:var(--text-muted)">Closed</span>
          <input type="time" id="cta-${day}-open"  value="${t.open  || '09:00'}" ${t.closed ? 'disabled' : ''} />
          <span style="color:var(--text-muted);font-size:0.8rem">–</span>
          <input type="time" id="cta-${day}-close" value="${t.close || '17:30'}" ${t.closed ? 'disabled' : ''} />
        </div>
      `;
    }).join('');
  }

  function toggleContactAvailDay(day) {
    const closed = el(`cta-${day}-closed`).checked;
    el(`cta-${day}-open`).disabled  = closed;
    el(`cta-${day}-close`).disabled = closed;
  }

  function getContactAvailSchedule() {
    const days = ['monday','tuesday','wednesday','thursday','friday','saturday','sunday'];
    const schedule = {};
    days.forEach((day) => {
      const closedEl = el(`cta-${day}-closed`);
      if (!closedEl) return;
      schedule[day] = {
        closed: closedEl.checked,
        open:   el(`cta-${day}-open`).value  || '09:00',
        close:  el(`cta-${day}-close`).value || '17:30',
      };
    });
    return schedule;
  }

  function closeContactModal() {
    el('contact-modal').style.display = 'none';
    editingContactId = null;
  }

  async function saveContact() {
    if (!editingClientId) return;
    const availType = el('ctf-avail-type').value;
    const body = {
      name: el('ctf-name').value.trim(),
      title: el('ctf-title').value.trim() || null,
      phone: el('ctf-phone').value.trim() || null,
      email: el('ctf-email').value.trim() || null,
      sms_number: el('ctf-sms').value.trim() || null,
      priority: parseInt(el('ctf-priority').value) || 1,
      notify_email: el('ctf-notify-email').checked,
      notify_sms: el('ctf-notify-sms').checked,
      is_private: el('ctf-private').checked,
      department_id: el('ctf-department').value || null,
      call_action: el('ctf-call-action').value,
      transfer_extension: el('ctf-transfer-ext').value.trim() || null,
      message_note: el('ctf-message-note').value.trim() || null,
      availability_type: availType,
      availability_schedule: availType === 'custom' ? getContactAvailSchedule() : {},
    };

    try {
      if (editingContactId) {
        await api('PUT', `/clients/${editingClientId}/contacts/${editingContactId}`, body);
        toast('Contact updated', 'success');
      } else {
        await api('POST', `/clients/${editingClientId}/contacts`, body);
        toast('Contact added', 'success');
      }
      closeContactModal();
      loadContacts(editingClientId);
    } catch (err) {
      toast(`Error: ${err.message}`, 'danger');
    }
  }

  async function deleteContact(clientId, contactId) {
    if (!confirm('Delete this contact?')) return;
    try {
      await api('DELETE', `/clients/${clientId}/contacts/${contactId}`);
      toast('Contact deleted', 'success');
      loadContacts(clientId);
    } catch (err) {
      toast(`Error: ${err.message}`, 'danger');
    }
  }

  function downloadContactTemplate() {
    const a = document.createElement('a');
    a.href = `/api/clients/${editingClientId}/contacts/import/template`;
    a.download = 'contacts-template.csv';
    a.click();
  }

  async function importContactsCsv(event) {
    const file = event.target.files[0];
    if (!file || !editingClientId) return;
    event.target.value = '';
    const csv = await file.text();
    try {
      const data = await api('POST', `/clients/${editingClientId}/contacts/import`,
        { csv }, { 'Content-Type': 'application/json' });
      toast(`Imported ${data.imported} contacts${data.skipped ? `, ${data.skipped} skipped` : ''}.`, 'success');
      if (data.errors?.length) {
        console.warn('CSV import errors:', data.errors);
        toast(`${data.errors.length} row(s) had errors — check the browser console.`, 'warning');
      }
      loadContacts(editingClientId);
    } catch (err) {
      toast(`Import failed: ${err.message}`, 'danger');
    }
  }

  /* ---- Departments ---- */
  async function loadDepartments(clientId) {
    const container = el('departments-list');
    if (!container) return;
    container.innerHTML = '<p style="color:var(--text-muted);font-size:0.82rem">Loading...</p>';
    try {
      const data = await api('GET', `/clients/${clientId}/departments`);
      const depts = data.departments || [];
      if (!depts.length) {
        container.innerHTML = '<p style="color:var(--text-muted);font-size:0.82rem">No departments yet.</p>';
        return;
      }
      container.innerHTML = depts.map((d) => `
        <div class="dept-item">
          <span>${escHtml(d.name)}</span>
          <button type="button" class="btn btn-sm btn-danger" onclick="Admin.deleteDepartment('${d.id}')">&#10005;</button>
        </div>
      `).join('');
    } catch (err) {
      container.innerHTML = `<p style="color:var(--danger);font-size:0.82rem">Error: ${escHtml(err.message)}</p>`;
    }
  }

  async function addDepartment() {
    const input = el('new-dept-name');
    const name = input.value.trim();
    if (!name || !editingClientId) return;
    try {
      await api('POST', `/clients/${editingClientId}/departments`, { name });
      input.value = '';
      toast('Department added', 'success');
      loadDepartments(editingClientId);
    } catch (err) {
      toast(`Error: ${err.message}`, 'danger');
    }
  }

  async function deleteDepartment(deptId) {
    if (!confirm('Delete this department? Contacts in it will be unassigned.')) return;
    try {
      await api('DELETE', `/clients/${editingClientId}/departments/${deptId}`);
      toast('Department deleted', 'success');
      loadDepartments(editingClientId);
    } catch (err) {
      toast(`Error: ${err.message}`, 'danger');
    }
  }

  /* ---- VIP Numbers ---- */
  async function loadVip(clientId) {
    const container = el('vip-list');
    if (!container) return;
    try {
      const data = await api('GET', `/clients/${clientId}/vip`);
      const list = data.vip || [];
      if (!list.length) { container.innerHTML = '<p style="color:var(--text-muted);font-size:0.78rem">No VIP numbers yet.</p>'; return; }
      container.innerHTML = list.map((e) => `
        <div class="number-list-item">
          <div>
            <div style="font-weight:600;font-size:0.85rem">${escHtml(e.phone)}</div>
            ${e.label ? `<div style="font-size:0.75rem;color:var(--text-muted)">${escHtml(e.label)}</div>` : ''}
          </div>
          <button type="button" class="btn btn-sm btn-danger" onclick="Admin.removeVip('${e.id}')">&#10005;</button>
        </div>
      `).join('');
    } catch { container.innerHTML = ''; }
  }

  async function addVip() {
    const phone = el('new-vip-phone').value.trim();
    const label = el('new-vip-label').value.trim();
    if (!phone || !editingClientId) return;
    try {
      await api('POST', `/clients/${editingClientId}/vip`, { phone, label: label || null });
      el('new-vip-phone').value = '';
      el('new-vip-label').value = '';
      toast('VIP number added', 'success');
      loadVip(editingClientId);
    } catch (err) {
      toast(`Error: ${err.message}`, 'danger');
    }
  }

  async function removeVip(entryId) {
    try {
      await api('DELETE', `/clients/${editingClientId}/vip/${entryId}`);
      loadVip(editingClientId);
    } catch (err) {
      toast(`Error: ${err.message}`, 'danger');
    }
  }

  /* ---- Ignore Numbers ---- */
  async function loadIgnore(clientId) {
    const container = el('ignore-list');
    if (!container) return;
    try {
      const data = await api('GET', `/clients/${clientId}/ignore`);
      const list = data.ignore || [];
      if (!list.length) { container.innerHTML = '<p style="color:var(--text-muted);font-size:0.78rem">No ignored numbers yet.</p>'; return; }
      container.innerHTML = list.map((e) => `
        <div class="number-list-item">
          <div>
            <div style="font-weight:600;font-size:0.85rem">${escHtml(e.phone)}</div>
            ${e.label ? `<div style="font-size:0.75rem;color:var(--text-muted)">${escHtml(e.label)}</div>` : ''}
          </div>
          <button type="button" class="btn btn-sm btn-danger" onclick="Admin.removeIgnore('${e.id}')">&#10005;</button>
        </div>
      `).join('');
    } catch { container.innerHTML = ''; }
  }

  async function addIgnore() {
    const phone = el('new-ignore-phone').value.trim();
    const label = el('new-ignore-label').value.trim();
    if (!phone || !editingClientId) return;
    try {
      await api('POST', `/clients/${editingClientId}/ignore`, { phone, label: label || null });
      el('new-ignore-phone').value = '';
      el('new-ignore-label').value = '';
      toast('Ignore number added', 'success');
      loadIgnore(editingClientId);
    } catch (err) {
      toast(`Error: ${err.message}`, 'danger');
    }
  }

  async function removeIgnore(entryId) {
    try {
      await api('DELETE', `/clients/${editingClientId}/ignore/${entryId}`);
      loadIgnore(editingClientId);
    } catch (err) {
      toast(`Error: ${err.message}`, 'danger');
    }
  }

  /* ---- Availability Section ---- */
  async function loadAvailabilitySection() {
    const container = el('availability-list');
    if (!container) return;
    container.innerHTML = '<p class="empty-state">Loading...</p>';

    try {
      const [clientsData, availData] = await Promise.all([
        api('GET', '/clients?active=true'),
        api('GET', '/availability'),
      ]);

      const clients = clientsData.clients || [];
      const availMap = {};
      (availData.availability || []).forEach((a) => { availMap[a.client_id] = a; });

      if (!clients.length) {
        container.innerHTML = '<p class="empty-state">No active clients.</p>';
        return;
      }

      container.innerHTML = clients.map((c) => {
        const avail = availMap[c.id] || { status: 'available', note: '' };
        const statuses = ['available', 'out_of_office', 'annual_leave', 'meeting'];
        const labels = { available: 'Available', out_of_office: 'Out of Office', annual_leave: 'Annual Leave', meeting: 'Meeting' };
        return `
          <div class="avail-card" id="avail-card-${c.id}">
            <div class="avail-card-name">${escHtml(c.name)}</div>
            <div class="avail-card-account">${escHtml(c.account_number)}</div>
            <div class="avail-card-controls">
              <select class="avail-status-select avail-status-${avail.status}"
                      onchange="Admin.setAvailability('${c.id}', this.value, document.getElementById('avail-note-${c.id}').value)"
                      id="avail-select-${c.id}">
                ${statuses.map((s) => `<option value="${s}" ${avail.status===s?'selected':''}>${labels[s]}</option>`).join('')}
              </select>
              <input type="text" id="avail-note-${c.id}" value="${escHtml(avail.note || '')}"
                placeholder="Optional note..."
                style="flex:1;background:var(--bg);border:1px solid var(--border);color:var(--text);border-radius:var(--radius);padding:5px 8px;font-size:0.82rem"
                onchange="Admin.setAvailability('${c.id}', document.getElementById('avail-select-${c.id}').value, this.value)" />
            </div>
          </div>
        `;
      }).join('');
    } catch (err) {
      container.innerHTML = `<p class="empty-state">Error: ${escHtml(err.message)}</p>`;
    }
  }

  async function setAvailability(clientId, status, note) {
    try {
      await api('PUT', `/clients/${clientId}/availability`, { status, note: note || null });
      // Update select styling
      const select = el(`avail-select-${clientId}`);
      if (select) {
        select.className = `avail-status-select avail-status-${status}`;
      }
    } catch (err) {
      toast(`Error: ${err.message}`, 'danger');
    }
  }

  /* ---- Operators ---- */
  async function loadOperators() {
    const tbody = el('operators-tbody');
    tbody.innerHTML = '<tr><td colspan="6" class="empty-state">Loading...</td></tr>';
    try {
      const data = await api('GET', '/operators');
      renderOperatorsTable(data.operators);
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="6" class="empty-state">Error: ${escHtml(err.message)}</td></tr>`;
    }
  }

  function renderOperatorsTable(operators) {
    const tbody = el('operators-tbody');
    if (!operators.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="empty-state">No operators</td></tr>';
      return;
    }
    tbody.innerHTML = operators.map((op) => `
      <tr>
        <td>${escHtml(op.username)}</td>
        <td>${escHtml(op.full_name)}</td>
        <td>${escHtml(op.email)}</td>
        <td><span class="pill pill-blue">${op.role}</span></td>
        <td><span class="pill ${op.is_active ? 'pill-green' : 'pill-red'}">${op.is_active ? 'Active' : 'Inactive'}</span></td>
        <td>
          <button class="btn btn-sm btn-secondary" onclick="Admin.openOperatorModal('${op.id}')">Edit</button>
          <button class="btn btn-sm ${op.is_active ? 'btn-danger' : 'btn-secondary'}"
                  onclick="Admin.toggleOperator('${op.id}', ${!op.is_active})">
            ${op.is_active ? 'Deactivate' : 'Activate'}
          </button>
        </td>
      </tr>
    `).join('');
  }

  function openOperatorModal(operatorId) {
    editingOperatorId = operatorId || null;
    el('op-modal-title').textContent = operatorId ? 'Edit Operator' : 'Add Operator';
    el('operator-form').reset();
    el('opf-username').disabled = !!operatorId;
    el('opf-password').required = !operatorId;
    el('opf-password').placeholder = operatorId ? 'Leave blank to keep current' : '';
    el('opf-active-row').style.display = operatorId ? 'flex' : 'none';
    el('operator-modal').style.display = 'flex';
  }

  function closeOperatorModal() {
    el('operator-modal').style.display = 'none';
    editingOperatorId = null;
  }

  async function saveOperator() {
    const body = {
      full_name: el('opf-fullname').value.trim(),
      email: el('opf-email').value.trim(),
      role: el('opf-role').value,
    };
    const pw = el('opf-password').value;
    if (pw) body.password = pw;
    if (editingOperatorId) body.is_active = el('opf-active').checked;

    try {
      if (editingOperatorId) {
        await api('PUT', `/operators/${editingOperatorId}`, body);
        toast('Operator updated', 'success');
      } else {
        body.username = el('opf-username').value.trim();
        if (!pw) { toast('Password is required', 'danger'); return; }
        await api('POST', '/operators', body);
        toast('Operator created', 'success');
      }
      closeOperatorModal();
      loadOperators();
    } catch (err) {
      toast(`Error: ${err.message}`, 'danger');
    }
  }

  async function toggleOperator(operatorId, setActive) {
    try {
      await api('PUT', `/operators/${operatorId}`, { is_active: setActive });
      toast(`Operator ${setActive ? 'activated' : 'deactivated'}`, 'success');
      loadOperators();
    } catch (err) {
      toast(`Error: ${err.message}`, 'danger');
    }
  }

  /* ---- Reports ---- */
  async function loadReports() {
    const days = el('report-days')?.value || 30;
    // Update CSV download links
    const setHref = (id, path) => { const a = el(id); if (a) a.href = '/api' + path; };
    setHref('report-ops-csv-btn',     `/reports/operators?days=${days}&format=csv`);
    setHref('report-clients-csv-btn', `/reports/clients?days=${days}&format=csv`);

    try {
      const s = await api('GET', '/reports/summary');
      if (s) {
        el('report-summary').innerHTML = `
          <div class="report-card"><div class="report-card-value">${s.calls_today}</div><div class="report-card-label">Calls Today</div></div>
          <div class="report-card"><div class="report-card-value">${s.answered_today}</div><div class="report-card-label">Answered</div></div>
          <div class="report-card report-card-danger"><div class="report-card-value">${s.missed_today}</div><div class="report-card-label">Missed</div></div>
          <div class="report-card"><div class="report-card-value">${s.messages_today}</div><div class="report-card-label">Messages Today</div></div>
          <div class="report-card report-card-warning"><div class="report-card-value">${s.tasks_pending}</div><div class="report-card-label">Pending Tasks</div></div>
          <div class="report-card report-card-success"><div class="report-card-value">${s.operators_online}</div><div class="report-card-label">Online Now</div></div>
        `;
      }
    } catch {
      el('report-summary').innerHTML = '<p class="empty-state">Failed to load summary</p>';
    }

    try {
      const vol = await api('GET', `/reports/call-volume?days=${days}`);
      const tbody = el('report-volume-tbody');
      if (vol && vol.rows.length) {
        tbody.innerHTML = vol.rows.map((r) => `
          <tr>
            <td>${new Date(r.day).toLocaleDateString('en-GB')}</td>
            <td>${r.total_calls}</td>
            <td>${r.answered_calls}</td>
            <td>${r.missed_calls}</td>
            <td>${Math.round(r.total_seconds / 60)}</td>
          </tr>
        `).join('');
      } else {
        tbody.innerHTML = '<tr><td colspan="5" class="empty-state">No data for this period</td></tr>';
      }
    } catch {
      el('report-volume-tbody').innerHTML = '<tr><td colspan="5" class="empty-state">Error loading data</td></tr>';
    }

    try {
      const ops = await api('GET', `/reports/operators?days=${days}`);
      const tbody = el('report-ops-tbody');
      if (ops && ops.rows.length) {
        tbody.innerHTML = ops.rows.map((r) => `
          <tr>
            <td>${escHtml(r.full_name)}</td>
            <td>${r.calls_answered}</td>
            <td>${r.messages_taken}</td>
            <td>${Math.round(r.total_seconds / 60)}</td>
            <td>${r.avg_duration ? Math.round(r.avg_duration) + 's' : '—'}</td>
          </tr>
        `).join('');
      } else {
        tbody.innerHTML = '<tr><td colspan="5" class="empty-state">No data for this period</td></tr>';
      }
    } catch {
      el('report-ops-tbody').innerHTML = '<tr><td colspan="5" class="empty-state">Error loading data</td></tr>';
    }

    try {
      const cl = await api('GET', `/reports/clients?days=${days}`);
      const tbody = el('report-clients-tbody');
      if (cl && cl.rows.length) {
        tbody.innerHTML = cl.rows.map((r) => `
          <tr>
            <td>${escHtml(r.name)}</td>
            <td>${escHtml(r.account_number)}</td>
            <td>${r.total_calls}</td>
            <td>${r.answered_calls}</td>
            <td>${r.total_messages}</td>
            <td>${Math.round(r.total_seconds / 60)}</td>
          </tr>
        `).join('');
      } else {
        tbody.innerHTML = '<tr><td colspan="6" class="empty-state">No data for this period</td></tr>';
      }
    } catch {
      el('report-clients-tbody').innerHTML = '<tr><td colspan="6" class="empty-state">Error loading data</td></tr>';
    }
  }

  /* ---- Billing ---- */
  let billingClientId = null;

  async function loadBillingSection() {
    const sel = el('billing-client-select');
    if (!sel) return;
    try {
      const data = await api('GET', '/clients');
      sel.innerHTML = '<option value="">— Select Client —</option>' +
        (data.clients || []).map((c) => `<option value="${c.id}">${escHtml(c.name)}</option>`).join('');
    } catch { /* ignore */ }
  }

  async function loadCallLog() {
    const tbody = el('calllog-tbody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="8" style="padding:12px;color:#666">Loading...</td></tr>';
    const clientId   = el('calllog-client-filter')?.value.trim();
    const disposition = el('calllog-disposition')?.value;
    let qs = '?limit=100';
    if (clientId)   qs += `&client_id=${encodeURIComponent(clientId)}`;
    if (disposition) qs += `&disposition=${encodeURIComponent(disposition)}`;
    try {
      const data = await api('GET', `/calls${qs}`);
      const rows = data?.calls || [];
      if (!rows.length) {
        tbody.innerHTML = '<tr><td colspan="8" class="empty-state">No calls found</td></tr>';
        return;
      }
      tbody.innerHTML = rows.map((r) => `
        <tr>
          <td style="white-space:nowrap">${r.call_start ? new Date(r.call_start).toLocaleString('en-GB') : '—'}</td>
          <td>${escHtml(r.client_name || '')}</td>
          <td>${escHtml((r.caller_id_name ? r.caller_id_name + ' ' : '') + (r.caller_id_num || ''))}</td>
          <td>${escHtml(r.did || '')}</td>
          <td>${r.duration_seconds != null ? r.duration_seconds + 's' : '—'}</td>
          <td>${escHtml(r.disposition || '')}</td>
          <td>${escHtml(r.operator_name || '—')}</td>
          <td>${r.recording_url
            ? `<audio controls preload="none" style="height:28px;max-width:180px">
                 <source src="/api/calls/${r.id}/recording">
               </audio>`
            : '—'}</td>
        </tr>
      `).join('');
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="8" class="empty-state">Error: ${escHtml(err.message)}</td></tr>`;
    }
  }

  async function loadBillingForClient() {
    const clientId = el('billing-client-select').value;
    billingClientId = clientId || null;
    if (!clientId) { el('billing-plan-editor').style.display = 'none'; return; }

    try {
      const data = await api('GET', `/billing/plans/${clientId}`);
      const plan = data.plan || {};
      el('bp-name').value        = plan.plan_name || 'Standard';
      el('bp-fee').value         = plan.monthly_fee || '0';
      el('bp-calls').value       = plan.included_calls || '0';
      el('bp-mins').value        = plan.included_minutes || '0';
      el('bp-admin').value       = plan.included_admin_minutes || '0';
      el('bp-call-rate').value   = plan.extra_call_rate || '0';
      el('bp-min-rate').value    = plan.extra_minute_rate || '0';
      el('bp-admin-rate').value  = plan.extra_admin_rate || '0';
      el('bp-currency').value    = plan.currency || 'GBP';
      el('billing-plan-editor').style.display = '';
    } catch {
      el('billing-plan-editor').style.display = '';
    }

    await loadBillingReports(clientId);
  }

  async function loadBillingReports(clientId) {
    const tbody = el('billing-reports-tbody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="7" class="empty-state">Loading...</td></tr>';
    try {
      const data = await api('GET', `/billing/reports/${clientId}`);
      const reports = data.reports || [];
      if (!reports.length) {
        tbody.innerHTML = '<tr><td colspan="7" class="empty-state">No reports yet. Click "Generate Month Report" to create one.</td></tr>';
        return;
      }
      tbody.innerHTML = reports.map((r) => {
        const bd = r.breakdown || {};
        return `
          <tr>
            <td>${r.year}/${String(r.month).padStart(2, '0')}</td>
            <td>${r.total_calls}</td>
            <td>${r.total_minutes}</td>
            <td>${r.admin_minutes}</td>
            <td>${r.total_messages}</td>
            <td><strong>${r.currency} ${parseFloat(r.amount_due).toFixed(2)}</strong></td>
            <td><button class="btn btn-sm btn-secondary" onclick="Admin.regenerateReport('${clientId}',${r.year},${r.month})">Regenerate</button></td>
          </tr>
        `;
      }).join('');
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="7" class="empty-state">Error: ${escHtml(err.message)}</td></tr>`;
    }
  }

  async function saveBillingPlan() {
    if (!billingClientId) { toast('Select a client first', 'warning'); return; }
    const body = {
      plan_name:              el('bp-name').value.trim() || 'Standard',
      monthly_fee:            parseFloat(el('bp-fee').value)       || 0,
      included_calls:         parseInt(el('bp-calls').value)       || 0,
      included_minutes:       parseInt(el('bp-mins').value)        || 0,
      included_admin_minutes: parseInt(el('bp-admin').value)       || 0,
      extra_call_rate:        parseFloat(el('bp-call-rate').value)  || 0,
      extra_minute_rate:      parseFloat(el('bp-min-rate').value)   || 0,
      extra_admin_rate:       parseFloat(el('bp-admin-rate').value) || 0,
      currency:               el('bp-currency').value || 'GBP',
    };
    try {
      await api('PUT', `/billing/plans/${billingClientId}`, body);
      toast('Billing plan saved', 'success');
    } catch (err) {
      toast(`Error: ${err.message}`, 'danger');
    }
  }

  async function generateBillingReport() {
    if (!billingClientId) { toast('Select a client first', 'warning'); return; }
    const now = new Date();
    const yearInput = prompt('Year:', now.getFullYear());
    if (!yearInput) return;
    const monthInput = prompt('Month (1-12):', now.getMonth() + 1);
    if (!monthInput) return;
    try {
      await api('POST', `/billing/reports/${billingClientId}/generate`, {
        year: parseInt(yearInput), month: parseInt(monthInput),
      });
      toast('Report generated', 'success');
      loadBillingReports(billingClientId);
    } catch (err) {
      toast(`Error: ${err.message}`, 'danger');
    }
  }

  async function regenerateReport(clientId, year, month) {
    try {
      await api('POST', `/billing/reports/${clientId}/generate`, { year, month });
      toast('Report regenerated', 'success');
      loadBillingReports(clientId);
    } catch (err) {
      toast(`Error: ${err.message}`, 'danger');
    }
  }

  /* ---- Settings ---- */
  async function loadSettings() {
    try {
      const data = await api('GET', '/settings');
      const s = data.settings || {};
      const name = el('set-company-name'); if (name) name.value = s.company_name || '';
      const fpbx = el('set-freepbx-url');  if (fpbx) fpbx.value = s.freepbx_url || '';
      const r2fa = el('set-require-2fa');  if (r2fa) r2fa.checked = s.require_2fa === 'true';
      const mpw  = el('set-min-pw');       if (mpw)  mpw.value  = s.min_password_length || '12';
      const sto  = el('set-session-timeout'); if (sto) sto.value = s.session_timeout_hours || '12';
      const ocli = el('set-outbound-cli'); if (ocli) ocli.value = s.outbound_caller_id || '';
    } catch (err) {
      toast(`Failed to load settings: ${err.message}`, 'danger');
    }
  }

  async function saveSettings() {
    const settings = {};
    const name = el('set-company-name'); if (name) settings.company_name = name.value.trim();
    const fpbx = el('set-freepbx-url');  if (fpbx) settings.freepbx_url = fpbx.value.trim();
    const r2fa = el('set-require-2fa');  if (r2fa) settings.require_2fa = String(r2fa.checked);
    const mpw  = el('set-min-pw');       if (mpw)  settings.min_password_length = mpw.value;
    const sto  = el('set-session-timeout'); if (sto) settings.session_timeout_hours = sto.value;
    const ocli = el('set-outbound-cli'); if (ocli) settings.outbound_caller_id = ocli.value.trim();
    try {
      await api('PUT', '/settings', settings);
      toast('Settings saved', 'success');
    } catch (err) {
      toast(`Error: ${err.message}`, 'danger');
    }
  }

  function openFreePBX() {
    const url = el('set-freepbx-url')?.value?.trim();
    if (url) window.open(url, '_blank', 'noopener,noreferrer');
    else toast('Enter FreePBX URL first', 'warning');
  }

  /* ---- Client Files ---- */
  async function loadClientFiles(clientId) {
    const tbody = el('client-files-tbody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="5" class="empty-state">Loading...</td></tr>';
    try {
      const data = await api('GET', `/clients/${clientId}/files`);
      if (!data.files.length) {
        tbody.innerHTML = '<tr><td colspan="5" class="empty-state">No files</td></tr>';
        return;
      }
      tbody.innerHTML = data.files.map((f) => `
        <tr>
          <td><a href="/api/clients/${clientId}/files/${f.id}/download" target="_blank">${escHtml(f.original_name)}</a></td>
          <td>${f.size_bytes ? Math.round(f.size_bytes / 1024) + ' KB' : '—'}</td>
          <td>${new Date(f.created_at).toLocaleDateString('en-GB')}</td>
          <td>${escHtml(f.uploaded_by_name || '—')}</td>
          <td><button class="btn btn-sm btn-danger" onclick="Admin.deleteFile('${f.id}')">Del</button></td>
        </tr>
      `).join('');
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="5" class="empty-state">Error: ${escHtml(err.message)}</td></tr>`;
    }
  }

  async function uploadFile() {
    if (!editingClientId) return;
    const input = el('file-upload-input');
    if (!input.files.length) return;

    const formData = new FormData();
    formData.append('file', input.files[0]);

    try {
      const res = await fetch(`/api/clients/${editingClientId}/files`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${localStorage.getItem('as_token')}` },
        body: formData,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Upload failed' }));
        throw new Error(err.error);
      }
      toast('File uploaded', 'success');
      loadClientFiles(editingClientId);
    } catch (err) {
      toast(`Error: ${err.message}`, 'danger');
    }
    input.value = '';
  }

  async function deleteFile(fileId) {
    if (!editingClientId || !confirm('Delete this file?')) return;
    try {
      await api('DELETE', `/clients/${editingClientId}/files/${fileId}`);
      toast('File deleted', 'info');
      loadClientFiles(editingClientId);
    } catch (err) {
      toast(`Error: ${err.message}`, 'danger');
    }
  }

  /* ---- Client News (Admin) ---- */
  async function loadClientNewsAdmin(clientId) {
    const container = el('client-news-list');
    if (!container) return;
    container.innerHTML = '<p class="empty-state">Loading...</p>';
    try {
      const data = await api('GET', `/clients/${clientId}/news`);
      if (!data.news.length) {
        container.innerHTML = '<p class="empty-state">No news items</p>';
        return;
      }
      container.innerHTML = data.news.map((n) => `
        <div class="client-news-item" style="display:flex;justify-content:space-between;align-items:flex-start">
          <div>
            <div>${escHtml(n.content)}</div>
            <div class="news-meta">${n.author_name ? escHtml(n.author_name) : ''} — ${new Date(n.created_at).toLocaleDateString('en-GB')}${n.expires_at ? ` (expires ${new Date(n.expires_at).toLocaleDateString('en-GB')})` : ''}</div>
          </div>
          <button class="btn btn-sm btn-danger" onclick="Admin.deleteNews('${n.id}')">Del</button>
        </div>
      `).join('');
    } catch (err) {
      container.innerHTML = `<p class="empty-state">Error: ${escHtml(err.message)}</p>`;
    }
  }

  function openNewsEditor() {
    el('news-content').value = '';
    el('news-expires').value = '';
    el('client-news-editor').style.display = '';
  }

  async function saveNews() {
    if (!editingClientId) return;
    const content = el('news-content').value.trim();
    if (!content) return;
    try {
      await api('POST', `/clients/${editingClientId}/news`, {
        content,
        expires_at: el('news-expires').value || null,
      });
      el('client-news-editor').style.display = 'none';
      toast('News item added', 'success');
      loadClientNewsAdmin(editingClientId);
    } catch (err) {
      toast(`Error: ${err.message}`, 'danger');
    }
  }

  async function deleteNews(newsId) {
    if (!editingClientId || !confirm('Delete this news item?')) return;
    try {
      await api('DELETE', `/clients/${editingClientId}/news/${newsId}`);
      toast('News item deleted', 'info');
      loadClientNewsAdmin(editingClientId);
    } catch (err) {
      toast(`Error: ${err.message}`, 'danger');
    }
  }

  /* ---- Email Template Preview ---- */
  function previewEmailTemplate() {
    const template = el('cf-email-template').value;
    if (!template) {
      toast('No custom template to preview. The default template will be used.', 'info');
      return;
    }
    const vars = {
      client_name: el('cf-name').value || 'Demo Client',
      caller_name: 'John Smith',
      caller_phone: '<+447700900123>',
      caller_company: '— Example Ltd',
      subject: 'Callback requested',
      body: 'Please call back regarding the invoice query. Caller said it was urgent.',
      urgency: 'HIGH',
      date: new Date().toLocaleString('en-GB'),
      operator_name: 'Operator',
      subject_row: '<tr><td style="padding:6px 0;border-bottom:1px solid #f0f0f0;color:#888">Subject</td><td style="padding:6px 0;border-bottom:1px solid #f0f0f0">Callback requested</td></tr>',
    };
    let html = template;
    for (const [key, val] of Object.entries(vars)) {
      html = html.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), val);
    }
    const win = window.open('', '_blank', 'width=700,height=600');
    win.document.write(html);
    win.document.close();
  }

  /* ---- Portal Users ---- */
  let editingPortalUserId = null;

  async function loadPortalUsers(clientId) {
    const tbody = el('portal-users-tbody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="4" class="empty-state">Loading...</td></tr>';
    try {
      const data = await api('GET', `/portal/clients/${clientId}/users`);
      const users = data.users || [];
      if (!users.length) {
        tbody.innerHTML = '<tr><td colspan="4" class="empty-state">No portal users yet</td></tr>';
        return;
      }
      tbody.innerHTML = users.map((u) => `
        <tr>
          <td>${escHtml(u.username)}</td>
          <td>${escHtml(u.email || '—')}</td>
          <td><span class="pill ${u.is_active ? 'pill-green' : 'pill-red'}">${u.is_active ? 'Active' : 'Inactive'}</span></td>
          <td>
            <button class="btn btn-sm btn-secondary" onclick="Admin.openPortalUserModal('${u.id}')">Edit</button>
            <button class="btn btn-sm btn-danger" onclick="Admin.deletePortalUser('${u.id}')">Del</button>
          </td>
        </tr>
      `).join('');
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="4" class="empty-state">Error: ${escHtml(err.message)}</td></tr>`;
    }
  }

  function openPortalUserModal(userId) {
    editingPortalUserId = userId || null;
    el('pu-modal-title').textContent = userId ? 'Edit Portal User' : 'Add Portal User';
    el('portal-user-form').reset();
    el('pu-username').disabled = !!userId;
    el('pu-password').required = !userId;
    el('pu-active-row').style.display = userId ? 'flex' : 'none';
    el('pu-active').checked = true;
    el('portal-user-modal').style.display = 'flex';
  }

  function closePortalUserModal() {
    el('portal-user-modal').style.display = 'none';
    editingPortalUserId = null;
  }

  async function savePortalUser() {
    if (!editingClientId) return;
    const body = {
      email: el('pu-email').value.trim() || null,
      is_active: el('pu-active').checked,
    };
    const pw = el('pu-password').value;
    if (pw) body.password = pw;
    try {
      if (editingPortalUserId) {
        await api('PUT', `/portal/clients/${editingClientId}/users/${editingPortalUserId}`, body);
        toast('Portal user updated', 'success');
      } else {
        body.username = el('pu-username').value.trim();
        if (!pw) { toast('Password is required', 'danger'); return; }
        await api('POST', `/portal/clients/${editingClientId}/users`, body);
        toast('Portal user created', 'success');
      }
      closePortalUserModal();
      loadPortalUsers(editingClientId);
    } catch (err) {
      toast(`Error: ${err.message}`, 'danger');
    }
  }

  async function deletePortalUser(userId) {
    if (!confirm('Delete this portal user?')) return;
    try {
      await api('DELETE', `/portal/clients/${editingClientId}/users/${userId}`);
      toast('Portal user deleted', 'info');
      loadPortalUsers(editingClientId);
    } catch (err) {
      toast(`Error: ${err.message}`, 'danger');
    }
  }

  /* ---- Webhooks ---- */
  async function loadWebhooks(clientId) {
    const tbody = el('webhooks-tbody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="5" class="empty-state">Loading...</td></tr>';
    try {
      const data = await api('GET', `/clients/${clientId}/webhooks`);
      const hooks = data.webhooks || [];
      if (!hooks.length) {
        tbody.innerHTML = '<tr><td colspan="5" class="empty-state">No webhooks configured</td></tr>';
        return;
      }
      tbody.innerHTML = hooks.map((h) => {
        const events = (h.events || []).join(', ') || 'all';
        const lastTriggered = h.last_triggered_at ? new Date(h.last_triggered_at).toLocaleString() : 'Never';
        return `<tr>
          <td style="word-break:break-all;font-size:0.82rem">${escHtml(h.url)}</td>
          <td style="font-size:0.8rem">${escHtml(events)}</td>
          <td>${h.is_active ? '<span style="color:#27ae60">Active</span>' : '<span style="color:#e74c3c">Paused</span>'}</td>
          <td style="font-size:0.82rem">${lastTriggered}</td>
          <td>
            <button class="btn btn-sm btn-secondary" onclick="Admin.testWebhook('${h.id}')">Test</button>
            <button class="btn btn-sm" style="background:#e74c3c;color:#fff;border:none;padding:3px 8px;border-radius:4px;cursor:pointer;margin-left:4px" onclick="Admin.deleteWebhook('${h.id}')">Delete</button>
          </td>
        </tr>`;
      }).join('');
    } catch (err) { toast(`Webhooks error: ${err.message}`, 'danger'); }
  }

  async function addWebhook() {
    if (!editingClientId) { toast('Save the client first', 'danger'); return; }
    const url = (prompt('Webhook endpoint URL (https://...):') || '').trim();
    if (!url || !url.startsWith('http')) { toast('Invalid URL', 'danger'); return; }
    const eventsInput = prompt(
      'Events to deliver (comma-separated, or leave blank for all):\nmessage.created, call.answered, call.ended, appointment.created',
      ''
    ) || '';
    const events = eventsInput.split(',').map((e) => e.trim()).filter(Boolean);
    const secret = (prompt('Webhook signing secret (optional, leave blank to skip):') || '').trim();
    try {
      await api('POST', `/clients/${editingClientId}/webhooks`, { url, events, secret: secret || undefined });
      toast('Webhook added', 'success');
      loadWebhooks(editingClientId);
    } catch (err) { toast(`Error: ${err.message}`, 'danger'); }
  }

  async function testWebhook(webhookId) {
    if (!editingClientId) return;
    try {
      const r = await api('POST', `/clients/${editingClientId}/webhooks/${webhookId}/test`);
      if (r.success) {
        toast(`Test delivered ✓ (HTTP ${r.status})`, 'success');
      } else {
        toast(`Test failed: HTTP ${r.status} — ${r.response_body?.slice(0, 80) || 'No response'}`, 'danger');
      }
    } catch (err) { toast(`Test error: ${err.message}`, 'danger'); }
  }

  async function deleteWebhook(webhookId) {
    if (!editingClientId) return;
    if (!confirm('Delete this webhook?')) return;
    try {
      await api('DELETE', `/clients/${editingClientId}/webhooks/${webhookId}`);
      toast('Webhook deleted', 'info');
      loadWebhooks(editingClientId);
    } catch (err) { toast(`Error: ${err.message}`, 'danger'); }
  }

  /* ---- Client Logo Upload ---- */
  async function sendTestEmail() {
    if (!editingClientId) { toast('Save the client first', 'danger'); return; }
    const to = (el('cf-test-email-to')?.value || '').trim();
    const resultEl = el('cf-test-email-result');
    if (!to) { if (resultEl) resultEl.textContent = 'Enter an email address'; return; }
    if (resultEl) { resultEl.style.color = 'inherit'; resultEl.textContent = 'Sending...'; }
    try {
      await api('POST', `/clients/${editingClientId}/test-email`, { to });
      if (resultEl) { resultEl.style.color = '#27ae60'; resultEl.textContent = `✓ Sent to ${to}`; }
    } catch (err) {
      if (resultEl) { resultEl.style.color = '#e74c3c'; resultEl.textContent = `✗ ${err.message}`; }
    }
  }

  async function uploadLogo() {
    if (!editingClientId) { toast('Save the client first', 'danger'); return; }
    const fileInput = el('cf-logo-file');
    if (!fileInput.files.length) { toast('Select an image file', 'danger'); return; }

    const formData = new FormData();
    formData.append('logo', fileInput.files[0]);

    try {
      const res = await fetch(`/api/clients/${editingClientId}/logo`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${localStorage.getItem('as_token')}` },
        body: formData,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Upload failed');
      }
      const data = await res.json();
      renderLogoPreview(data.logo_url);
      toast('Logo uploaded', 'success');
      fileInput.value = '';
    } catch (err) {
      toast(`Logo upload failed: ${err.message}`, 'danger');
    }
  }

  /* ---- Client Message Templates ---- */
  async function loadMsgTemplates() {
    if (!editingClientId) return;
    const tbody = el('msgtpl-tbody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="5" class="empty-state">Loading...</td></tr>';
    try {
      const { templates } = await api('GET', `/clients/${editingClientId}/message-templates`);
      if (!templates.length) {
        tbody.innerHTML = '<tr><td colspan="5" class="empty-state">No templates defined. Add one to speed up message taking.</td></tr>';
        return;
      }
      tbody.innerHTML = templates.map((t) => `
        <tr>
          <td><strong>${escHtml(t.name)}</strong></td>
          <td>${escHtml(t.subject || '—')}</td>
          <td>${escHtml(t.call_type)}</td>
          <td>${escHtml(t.urgency)}</td>
          <td><button class="btn btn-sm" style="background:#e74c3c;color:#fff;border:none;padding:3px 8px;border-radius:4px;cursor:pointer" onclick="Admin.deleteMsgTpl('${t.id}')">Delete</button></td>
        </tr>
      `).join('');
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="5" class="empty-state">Error: ${escHtml(err.message)}</td></tr>`;
    }
  }

  function openMsgTplNew() { el('msgtpl-new-form').style.display = 'block'; }
  function closeMsgTplNew() { el('msgtpl-new-form').style.display = 'none'; }

  async function saveMsgTpl() {
    if (!editingClientId) return;
    const name = el('msgtpl-name').value.trim();
    const body = el('msgtpl-body').value.trim();
    if (!name || !body) return toast('Name and body are required', 'danger');
    try {
      await api('POST', `/clients/${editingClientId}/message-templates`, {
        name, subject: el('msgtpl-subject').value.trim() || null,
        body, call_type: el('msgtpl-calltype').value, urgency: el('msgtpl-urgency').value,
      });
      toast('Template saved', 'success');
      closeMsgTplNew();
      loadMsgTemplates();
    } catch (err) { toast(`Error: ${err.message}`, 'danger'); }
  }

  async function deleteMsgTpl(templateId) {
    if (!confirm('Delete this template?')) return;
    try {
      await api('DELETE', `/clients/${editingClientId}/message-templates/${templateId}`);
      toast('Template deleted');
      loadMsgTemplates();
    } catch (err) { toast(`Error: ${err.message}`, 'danger'); }
  }

  /* ---- Client Holidays ---- */
  async function loadHolidays() {
    if (!editingClientId) return;
    const tbody = el('holidays-tbody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="5" class="empty-state">Loading...</td></tr>';
    const year = new Date().getFullYear();
    try {
      const { holidays } = await api('GET', `/clients/${editingClientId}/holidays?year=${year}`);
      if (!holidays.length) {
        tbody.innerHTML = '<tr><td colspan="5" class="empty-state">No holidays defined for this year</td></tr>';
        return;
      }
      const typeLabel = { closed: 'Fully Closed', reduced: 'Reduced Hours', emergency_only: 'Emergency Only' };
      tbody.innerHTML = holidays.map((h) => `
        <tr>
          <td>${h.holiday_date}</td>
          <td><strong>${escHtml(h.name)}</strong></td>
          <td><span class="pill" style="font-size:0.72rem">${typeLabel[h.closure_type] || h.closure_type}</span></td>
          <td>${escHtml(h.notes || '—')}</td>
          <td><button class="btn btn-sm" style="background:#e74c3c;color:#fff;border:none;padding:3px 8px;border-radius:4px;cursor:pointer" onclick="Admin.deleteHoliday('${h.id}')">Delete</button></td>
        </tr>
      `).join('');
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="5" class="empty-state">Error: ${escHtml(err.message)}</td></tr>`;
    }
  }

  function openHolidayNew() { el('holiday-new-form').style.display = 'block'; }
  function closeHolidayNew() { el('holiday-new-form').style.display = 'none'; }

  async function saveHoliday() {
    if (!editingClientId) return;
    const date = el('holiday-date').value;
    const name = el('holiday-name').value.trim();
    if (!date || !name) return toast('Date and name are required', 'danger');
    try {
      await api('POST', `/clients/${editingClientId}/holidays`, {
        holiday_date: date, name,
        closure_type: el('holiday-type').value,
        notes: el('holiday-notes').value.trim() || null,
      });
      toast('Holiday saved', 'success');
      closeHolidayNew();
      loadHolidays();
    } catch (err) { toast(`Error: ${err.message}`, 'danger'); }
  }

  async function deleteHoliday(holidayId) {
    if (!confirm('Delete this holiday?')) return;
    try {
      await api('DELETE', `/clients/${editingClientId}/holidays/${holidayId}`);
      toast('Holiday deleted');
      loadHolidays();
    } catch (err) { toast(`Error: ${err.message}`, 'danger'); }
  }

  async function removeLogo() {
    if (!editingClientId) return;
    try {
      await api('DELETE', `/clients/${editingClientId}/logo`);
      renderLogoPreview(null);
      toast('Logo removed', 'info');
    } catch (err) {
      toast(`Error: ${err.message}`, 'danger');
    }
  }

  function renderLogoPreview(logoUrl) {
    const preview = el('cf-logo-preview');
    const removeBtn = el('cf-logo-remove');
    if (logoUrl) {
      preview.innerHTML = `<img src="/uploads/${escHtml(logoUrl)}" alt="Logo" />`;
      removeBtn.style.display = '';
    } else {
      preview.innerHTML = '<span style="font-size:0.8rem;color:var(--text-muted)">No logo</span>';
      removeBtn.style.display = 'none';
    }
  }

  /* ---- Operator Performance ---- */
  async function loadPerformance() {
    const days = el('perf-days')?.value || '30';
    const tbody = el('performance-tbody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="6" class="empty-state">Loading...</td></tr>';
    try {
      const data = await api('GET', `/operators/performance?days=${days}`);
      const rows = data.performance || [];
      if (!rows.length) {
        tbody.innerHTML = '<tr><td colspan="6" class="empty-state">No data for this period</td></tr>';
        return;
      }
      tbody.innerHTML = rows.map((r) => {
        const aht = r.avg_duration_seconds
          ? `${Math.floor(r.avg_duration_seconds / 60)}:${String(r.avg_duration_seconds % 60).padStart(2, '0')}`
          : '—';
        const qa = r.avg_qa_score ? `${r.avg_qa_score}/10` : '—';
        return `<tr>
          <td>${escHtml(r.full_name)}</td>
          <td>${r.calls_answered}</td>
          <td>${r.calls_missed}</td>
          <td>${aht}</td>
          <td>${r.messages_taken}</td>
          <td>${qa}</td>
        </tr>`;
      }).join('');
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="6" class="empty-state">Error: ${escHtml(err.message)}</td></tr>`;
    }
  }

  /* ---- Performance Targets ---- */
  let _targetsVisible = false;

  function toggleTargetsPanel() {
    _targetsVisible = !_targetsVisible;
    const panel = el('targets-panel');
    if (panel) {
      panel.style.display = _targetsVisible ? 'block' : 'none';
      if (_targetsVisible) loadTargets();
    }
  }

  async function loadTargets() {
    const tbody = el('targets-tbody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="8" class="empty-state">Loading...</td></tr>';
    try {
      const { targets } = await api('GET', '/operators/targets/all');
      if (!targets.length) {
        tbody.innerHTML = '<tr><td colspan="8" class="empty-state">No operators found</td></tr>';
        return;
      }
      tbody.innerHTML = targets.map((t) => {
        const callPct  = t.target_calls   > 0 ? Math.min(100, Math.round(t.today_calls    / t.target_calls   * 100)) : null;
        const msgPct   = t.target_messages > 0 ? Math.min(100, Math.round(t.today_messages / t.target_messages * 100)) : null;
        const qaPct    = t.target_qa > 0 ? Math.min(100, Math.round((t.today_qa || 0) / t.target_qa * 100)) : null;
        const prog = (val, target, pct) => target > 0
          ? `<div style="font-weight:600">${val || 0}/${target}</div><div style="background:var(--border);border-radius:4px;height:4px;width:60px;margin-top:3px"><div style="background:${pct >= 100 ? '#22c55e' : pct >= 60 ? '#f59e0b' : '#ef4444'};width:${pct}%;height:4px;border-radius:4px"></div></div>`
          : `<span style="color:var(--text-muted)">—</span>`;
        return `<tr>
          <td>${escHtml(t.full_name)}</td>
          <td>${t.target_calls || '—'}</td>
          <td>${prog(t.today_calls, t.target_calls, callPct)}</td>
          <td>${t.target_messages || '—'}</td>
          <td>${prog(t.today_messages, t.target_messages, msgPct)}</td>
          <td>${t.target_qa || '—'}</td>
          <td>${prog(t.today_qa, t.target_qa, qaPct)}</td>
          <td><button class="btn btn-secondary btn-sm" onclick="Admin.openTargetsModal('${t.id}','${escHtml(t.full_name)}')">Edit</button></td>
        </tr>`;
      }).join('');
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="8" class="empty-state">Error: ${escHtml(err.message)}</td></tr>`;
    }
  }

  async function openTargetsModal(operatorId, name) {
    el('targets-operator-id').value = operatorId;
    el('targets-operator-name').textContent = name;
    el('targets-calls').value = 0;
    el('targets-msgs').value = 0;
    el('targets-qa').value = 0;
    try {
      const { targets } = await api('GET', `/operators/${operatorId}/targets`);
      if (targets) {
        el('targets-calls').value = targets.calls_per_day || 0;
        el('targets-msgs').value = targets.messages_per_day || 0;
        el('targets-qa').value = targets.qa_score_target || 0;
      }
    } catch (_) {}
    el('targets-modal').style.display = 'flex';
  }

  function closeTargetsModal() { el('targets-modal').style.display = 'none'; }

  async function saveTargets() {
    const id = el('targets-operator-id').value;
    const calls = parseInt(el('targets-calls').value) || 0;
    const msgs = parseInt(el('targets-msgs').value) || 0;
    const qa = parseInt(el('targets-qa').value) || 0;
    try {
      await api('PUT', `/operators/${id}/targets`, { calls_per_day: calls, messages_per_day: msgs, qa_score_target: qa });
      toast('Targets saved', 'success');
      closeTargetsModal();
      loadTargets();
    } catch (err) { toast(err.message, 'danger'); }
  }

  /* ---- Canned Responses ---- */
  let editingCannedId = null;

  async function loadCannedResponses() {
    const tbody = el('canned-tbody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="5" class="empty-state">Loading...</td></tr>';
    try {
      const data = await api('GET', '/canned');
      const rows = data.canned_responses || [];
      if (!rows.length) {
        tbody.innerHTML = '<tr><td colspan="5" class="empty-state">No canned responses yet</td></tr>';
        return;
      }
      tbody.innerHTML = rows.map((r) => `
        <tr>
          <td><code>/${escHtml(r.shortcode)}</code></td>
          <td>${escHtml(r.title || '—')}</td>
          <td>${escHtml(r.client_name || 'Global')}</td>
          <td style="max-width:200px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escHtml(r.body)}</td>
          <td>
            <button class="btn btn-sm btn-secondary" onclick="Admin.openCannedModal('${r.id}')">Edit</button>
            <button class="btn btn-sm btn-danger" onclick="Admin.deleteCannedResponse('${r.id}')">Del</button>
          </td>
        </tr>
      `).join('');
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="5" class="empty-state">Error: ${escHtml(err.message)}</td></tr>`;
    }
  }

  async function openCannedModal(cannedId) {
    editingCannedId = cannedId || null;
    el('canned-modal-title').textContent = cannedId ? 'Edit Canned Response' : 'Add Canned Response';
    el('canned-shortcode').value = '';
    el('canned-title').value = '';
    el('canned-body').value = '';
    el('canned-client').value = '';

    // Populate client select
    const clientSelect = el('canned-client');
    if (clientSelect.options.length <= 1) {
      const clientData = App._clients();
      clientData.forEach((c) => {
        const opt = document.createElement('option');
        opt.value = c.id; opt.textContent = c.name;
        clientSelect.appendChild(opt);
      });
    }

    if (cannedId) {
      try {
        const data = await api('GET', '/canned');
        const found = (data.canned_responses || []).find((r) => r.id === cannedId);
        if (found) {
          el('canned-shortcode').value = found.shortcode;
          el('canned-title').value     = found.title || '';
          el('canned-body').value      = found.body;
          el('canned-client').value    = found.client_id || '';
        }
      } catch { /* ignore */ }
    }
    el('canned-modal').style.display = 'flex';
  }

  function closeCannedModal() {
    el('canned-modal').style.display = 'none';
    editingCannedId = null;
  }

  async function saveCannedResponse() {
    const body = {
      shortcode: el('canned-shortcode').value.trim().replace(/\s+/g, ''),
      title:     el('canned-title').value.trim() || null,
      body:      el('canned-body').value.trim(),
      client_id: el('canned-client').value || null,
    };
    if (!body.shortcode) { toast('Shortcode is required', 'danger'); return; }
    if (!body.body)      { toast('Response text is required', 'danger'); return; }
    try {
      if (editingCannedId) {
        await api('PUT', `/canned/${editingCannedId}`, body);
        toast('Canned response updated', 'success');
      } else {
        await api('POST', '/canned', body);
        toast('Canned response created', 'success');
      }
      closeCannedModal();
      loadCannedResponses();
    } catch (err) {
      toast(`Error: ${err.message}`, 'danger');
    }
  }

  async function deleteCannedResponse(cannedId) {
    if (!confirm('Delete this canned response?')) return;
    try {
      await api('DELETE', `/canned/${cannedId}`);
      toast('Deleted', 'info');
      loadCannedResponses();
    } catch (err) {
      toast(`Error: ${err.message}`, 'danger');
    }
  }

  /* ---- Public ---- */
  return {
    init, showSection, showClientTab,
    searchClients,
    openClientModal, closeClientModal, saveClient, toggleClient,
    toggleDayClosed,
    addInfoSheet, updateInfoSheet, removeInfoSheet,
    addWebLink, updateWebLink, removeWebLink,
    addFormField, updateField, updateFieldOptions, updateFieldShowWhen, removeField,
    openContactModal, closeContactModal, saveContact, deleteContact,
    downloadContactTemplate, importContactsCsv,
    onCallActionChange, onAvailTypeChange, toggleContactAvailDay,
    addDepartment, deleteDepartment,
    addVip, removeVip,
    addIgnore, removeIgnore,
    setAvailability,
    openOperatorModal, closeOperatorModal, saveOperator, toggleOperator,
    loadReports, loadCallLog,
    loadBillingForClient, saveBillingPlan, generateBillingReport, regenerateReport,
    loadSettings, saveSettings, openFreePBX,
    loadClientFiles, uploadFile, deleteFile,
    loadClientNewsAdmin, openNewsEditor, saveNews, deleteNews,
    previewEmailTemplate,
    openPortalUserModal, closePortalUserModal, savePortalUser, deletePortalUser,
    loadWebhooks, addWebhook, testWebhook, deleteWebhook,
    sendTestEmail,
    uploadLogo, removeLogo,
    // Message templates
    loadMsgTemplates, openMsgTplNew, closeMsgTplNew, saveMsgTpl, deleteMsgTpl,
    // Holidays
    loadHolidays, openHolidayNew, closeHolidayNew, saveHoliday, deleteHoliday,
    // Performance
    loadPerformance,
    // Targets
    toggleTargetsPanel, loadTargets, openTargetsModal, closeTargetsModal, saveTargets,
    // Canned
    loadCannedResponses, openCannedModal, closeCannedModal, saveCannedResponse, deleteCannedResponse,
  };

})();

/* ============================================================
   Tasks Module
   ============================================================ */

const Tasks = (() => {
  const api = (...args) => App._api(...args);
  const toast = (...args) => App._toast(...args);
  const escHtml = (...args) => App._escHtml(...args);
  const el = (id) => document.getElementById(id);

  async function load() {
    try {
      const data = await api('GET', '/tasks?completed=false');
      if (!data) return;
      render(data.tasks);
    } catch (err) {
      console.error('Tasks.load error:', err.message);
    }
  }

  function render(tasks) {
    const container = el('tasks-list');
    const badge = el('tasks-badge');
    if (!tasks || !tasks.length) {
      container.innerHTML = '<p class="empty-state">No pending tasks</p>';
      badge.classList.add('hidden');
      return;
    }
    badge.textContent = tasks.length;
    badge.classList.remove('hidden');

    const now = Date.now();
    container.innerHTML = tasks.map((t) => {
      const overdue = t.due_at && new Date(t.due_at).getTime() < now;
      const dueStr = t.due_at
        ? new Date(t.due_at).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' })
        : '';
      return `
        <div class="task-item${overdue ? ' task-overdue' : ''}">
          <div class="task-title">${escHtml(t.title)}</div>
          ${t.client_name ? `<div class="task-client">${escHtml(t.client_name)}</div>` : ''}
          ${dueStr ? `<div class="task-due${overdue ? ' overdue' : ''}">${overdue ? '&#9888; Overdue: ' : 'Due: '}${dueStr}</div>` : ''}
          <div class="task-actions">
            <button class="btn btn-sm btn-secondary" onclick="Tasks.complete('${t.id}')">Done</button>
            <button class="btn btn-sm btn-danger" onclick="Tasks.remove('${t.id}')">Del</button>
          </div>
        </div>
      `;
    }).join('');
  }

  function openNew() { el('task-form').reset(); el('task-modal').style.display = 'flex'; }
  function closeNew() { el('task-modal').style.display = 'none'; }

  async function saveNew() {
    const title = el('tf-title').value.trim();
    if (!title) return;
    try {
      await api('POST', '/tasks', {
        title,
        notes: el('tf-notes').value.trim() || null,
        client_id: el('tf-client').value || null,
        due_at: el('tf-due').value || null,
      });
      closeNew();
      toast('Task created', 'success');
      load();
    } catch (err) {
      toast(`Error: ${err.message}`, 'danger');
    }
  }

  async function complete(taskId) {
    try {
      await api('POST', `/tasks/${taskId}/complete`, {});
      toast('Task marked complete', 'success');
      load();
    } catch (err) {
      toast(`Error: ${err.message}`, 'danger');
    }
  }

  async function remove(taskId) {
    if (!confirm('Delete this task?')) return;
    try {
      await api('DELETE', `/tasks/${taskId}`);
      toast('Task deleted', 'info');
      load();
    } catch (err) {
      toast(`Error: ${err.message}`, 'danger');
    }
  }

  return { load, openNew, closeNew, saveNew, complete, remove };

})();

/* ============================================================
   Analytics Panel
   ============================================================ */
const Analytics = (() => {
  const api = (...a) => App._api(...a);
  const toast = (...a) => App._toast(...a);
  const el = (id) => document.getElementById(id);
  const escHtml = (...a) => App._escHtml(...a);

  async function load() {
    const container = el('admin-analytics');
    if (!container) return;
    const period = el('analytics-period')?.value || 'day';
    const from   = el('analytics-from')?.value || '';
    const to     = el('analytics-to')?.value   || '';
    container.querySelectorAll('.analytics-table-wrap').forEach((w) => {
      w.innerHTML = '<p style="color:#666;padding:8px">Loading...</p>';
    });
    try {
      const qs = `?granularity=${period}${from ? `&from=${from}` : ''}${to ? `&to=${to}` : ''}`;
      const baseUrl = '/api';
      const token = localStorage.getItem('as_token') || '';
      // Update CSV download links (auth via URL param fallback not available — links open API directly)
      const csvQs = qs + '&format=csv';
      const setHref = (id, path) => { const a = el(id); if (a) a.href = baseUrl + path; };
      setHref('analytics-calls-csv',     `/analytics/calls${csvQs}`);
      setHref('analytics-msgs-csv',      `/analytics/messages${csvQs}`);
      setHref('analytics-sla-csv',       `/analytics/sla${csvQs}`);
      setHref('analytics-operators-csv', `/analytics/operators?${from ? `from=${from}&` : ''}${to ? `to=${to}&` : ''}format=csv`);
      setHref('analytics-clients-csv',   `/analytics/clients?${from ? `from=${from}&` : ''}${to ? `to=${to}&` : ''}format=csv`);

      const days = from ? Math.round((new Date(to || Date.now()) - new Date(from)) / 86400000) : 30;
      setHref('analytics-hourly-csv', `/analytics/calls/hourly?days=${days}&format=csv`);

      const [calls, msgs, sla, ops, clients, hourly] = await Promise.all([
        api('GET', `/analytics/calls${qs}`),
        api('GET', `/analytics/messages${qs}`),
        api('GET', `/analytics/sla${qs}`),
        api('GET', `/analytics/operators?${from ? `from=${from}&` : ''}${to ? `to=${to}` : ''}`),
        api('GET', `/analytics/clients?${from ? `from=${from}&` : ''}${to ? `to=${to}` : ''}`),
        api('GET', `/analytics/calls/hourly?days=${days}`).catch(() => null),
      ]);
      renderCallsSeries(calls?.series || []);
      renderMsgsSeries(msgs?.series || []);
      renderSLASeries(sla?.series || []);
      renderOperatorsTable(ops?.operators || []);
      renderClientsTable(clients?.clients || []);
      renderHourlyChart(hourly?.hourly || []);
    } catch (err) { toast(`Analytics error: ${err.message}`, 'danger'); }
  }

  function renderCallsSeries(rows) {
    const w = el('analytics-calls-wrap');
    if (!w) return;
    if (!rows.length) { w.innerHTML = '<p style="color:#888">No data</p>'; return; }
    w.innerHTML = `<table class="data-table"><thead><tr>
      <th>Time</th><th>Total</th><th>Answered</th><th>Missed</th><th>Avg Handle (s)</th>
    </tr></thead><tbody>${rows.map((r) => `<tr>
      <td>${new Date(r.bucket).toLocaleString()}</td>
      <td>${r.total}</td><td>${r.answered}</td><td>${r.missed}</td><td>${r.avg_handle_seconds}</td>
    </tr>`).join('')}</tbody></table>`;
  }

  function renderMsgsSeries(rows) {
    const w = el('analytics-msgs-wrap');
    if (!w) return;
    if (!rows.length) { w.innerHTML = '<p style="color:#888">No data</p>'; return; }
    w.innerHTML = `<table class="data-table"><thead><tr>
      <th>Time</th><th>Urgency</th><th>Count</th>
    </tr></thead><tbody>${rows.map((r) => `<tr>
      <td>${new Date(r.bucket).toLocaleString()}</td>
      <td>${escHtml(r.urgency || '-')}</td><td>${r.count}</td>
    </tr>`).join('')}</tbody></table>`;
  }

  function renderSLASeries(rows) {
    const w = el('analytics-sla-wrap');
    if (!w) return;
    if (!rows.length) { w.innerHTML = '<p style="color:#888">No data</p>'; return; }
    w.innerHTML = `<table class="data-table"><thead><tr>
      <th>Time</th><th>Total Calls</th><th>SLA Met</th><th>SLA %</th>
    </tr></thead><tbody>${rows.map((r) => `<tr>
      <td>${new Date(r.bucket).toLocaleString()}</td>
      <td>${r.total_calls}</td><td>${r.sla_met}</td>
      <td style="color:${parseFloat(r.sla_pct) >= 80 ? '#27ae60' : '#e74c3c'}">${r.sla_pct || 0}%</td>
    </tr>`).join('')}</tbody></table>`;
  }

  function renderOperatorsTable(rows) {
    const w = el('analytics-operators-wrap');
    if (!w) return;
    if (!rows.length) { w.innerHTML = '<p style="color:#888">No data</p>'; return; }
    w.innerHTML = `<table class="data-table"><thead><tr>
      <th>Operator</th><th>Calls</th><th>Messages</th><th>Avg Handle (s)</th><th>Avg QA</th>
    </tr></thead><tbody>${rows.map((r) => `<tr>
      <td>${escHtml(r.full_name)}</td>
      <td>${r.calls_taken}</td><td>${r.messages_logged}</td>
      <td>${r.avg_handle_seconds}</td><td>${r.avg_qa_score || '-'}</td>
    </tr>`).join('')}</tbody></table>`;
  }

  function renderClientsTable(rows) {
    const w = el('analytics-clients-wrap');
    if (!w) return;
    if (!rows.length) { w.innerHTML = '<p style="color:#888">No data</p>'; return; }
    w.innerHTML = `<table class="data-table"><thead><tr>
      <th>Client</th><th>Messages</th><th>High Urgency</th><th>Calls</th><th>Avg Handle (s)</th>
    </tr></thead><tbody>${rows.map((r) => `<tr>
      <td>${escHtml(r.name)}</td>
      <td>${r.messages}</td><td>${r.high_urgency}</td>
      <td>${r.calls}</td><td>${r.avg_handle_seconds}</td>
    </tr>`).join('')}</tbody></table>`;
  }

  function renderHourlyChart(rows) {
    const chart = el('analytics-hourly-chart');
    if (!chart) return;
    if (!rows.length) { chart.innerHTML = '<p style="color:#888;font-size:0.8rem">No data</p>'; return; }
    const maxCalls = Math.max(...rows.map((r) => r.total_calls), 1);
    chart.innerHTML = rows.map((r) => {
      const pct = Math.round((r.total_calls / maxCalls) * 100);
      const hourLabel = `${String(r.hour_utc).padStart(2,'0')}:00`;
      const color = pct > 75 ? '#ef4444' : pct > 40 ? '#f59e0b' : '#22c55e';
      return `<div title="${hourLabel}: ${r.total_calls} calls (${r.answered} answered)" style="flex:1;display:flex;flex-direction:column;align-items:center;gap:2px">
        <div style="width:100%;background:${color};height:${pct}%;min-height:${r.total_calls > 0 ? 2 : 0}px;border-radius:2px 2px 0 0;transition:height 0.3s"></div>
        <div style="font-size:0.55rem;color:var(--text-muted);transform:rotate(-45deg);transform-origin:top left;margin-top:4px;width:20px;overflow:hidden">${r.hour_utc}</div>
      </div>`;
    }).join('');
  }

  return { load };
})();

/* ============================================================
   Leaderboard Panel
   ============================================================ */
const Leaderboard = (() => {
  const api = (...a) => App._api(...a);
  const toast = (...a) => App._toast(...a);
  const el = (id) => document.getElementById(id);
  const escHtml = (...a) => App._escHtml(...a);

  async function load() {
    const container = el('admin-leaderboard');
    if (!container) return;
    const period = el('leaderboard-period')?.value || 'week';
    const tbody = el('leaderboard-tbody');
    if (tbody) tbody.innerHTML = '<tr><td colspan="8" style="padding:12px;color:#666">Loading...</td></tr>';
    try {
      const data = await api('GET', `/leaderboard?period=${period}`);
      render(data?.leaderboard || []);
    } catch (err) { toast(`Leaderboard error: ${err.message}`, 'danger'); }
  }

  function render(rows) {
    const tbody = el('leaderboard-tbody');
    if (!tbody) return;
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="8" style="padding:12px;color:#888">No data for this period</td></tr>';
      return;
    }
    tbody.innerHTML = rows.map((r) => `<tr ${r.rank <= 3 ? 'style="background:#fffde7"' : ''}>
      <td style="font-weight:bold;text-align:center">${r.rank}</td>
      <td>${escHtml(r.full_name)}</td>
      <td style="text-align:center">${r.calls}</td>
      <td style="text-align:center">${r.messages}</td>
      <td style="text-align:center">${r.sla_met}</td>
      <td style="text-align:center">${r.avg_qa || '-'}</td>
      <td style="text-align:center;font-weight:bold">${r.score}</td>
      <td style="font-size:1.1em">${(r.badges || []).map((b) => `<span title="${escHtml(b.name)}">${b.icon}</span>`).join(' ')}</td>
    </tr>`).join('');
  }

  return { load };
})();

/* ============================================================
   SMS Inbox Panel (operator-accessible)
   ============================================================ */
const SMSInbox = (() => {
  const api = (...a) => App._api(...a);
  const toast = (...a) => App._toast(...a);
  const el = (id) => document.getElementById(id);
  const escHtml = (...a) => App._escHtml(...a);
  let activeThread = null;

  async function load() {
    const container = el('admin-sms');
    if (!container) return;
    loadThreads();
  }

  async function loadThreads() {
    const list = el('sms-thread-list');
    if (!list) return;
    list.innerHTML = '<p style="color:#666;padding:8px">Loading...</p>';
    try {
      const data = await api('GET', '/sms/threads');
      const threads = data?.threads || [];
      if (!threads.length) { list.innerHTML = '<p style="color:#888;padding:8px">No SMS threads</p>'; return; }
      list.innerHTML = threads.map((t) => `
        <div class="sms-thread-item ${t.unread > 0 ? 'unread' : ''}"
             onclick="SMSInbox.openThread('${escHtml(t.from_number)}','${escHtml(t.client_name || '')}')"
             style="padding:8px 12px;border-bottom:1px solid #eee;cursor:pointer">
          <strong>${escHtml(t.from_number)}</strong>
          ${t.unread > 0 ? `<span style="background:#e74c3c;color:#fff;border-radius:999px;padding:1px 6px;font-size:0.75em;margin-left:4px">${t.unread}</span>` : ''}
          <span style="color:#888;font-size:0.85em;float:right">${escHtml(t.client_name || '')}</span>
          <div style="color:#666;font-size:0.85em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escHtml(t.last_body || '')}</div>
        </div>`).join('');
    } catch (err) { toast(`SMS error: ${err.message}`, 'danger'); }
  }

  async function openThread(number, clientName) {
    activeThread = number;
    const pane = el('sms-message-pane');
    if (!pane) return;
    pane.style.display = '';
    el('sms-thread-title') && (el('sms-thread-title').textContent = `${number}${clientName ? ` — ${clientName}` : ''}`);
    const msgs = el('sms-messages');
    if (msgs) msgs.innerHTML = '<p style="color:#666">Loading...</p>';
    try {
      const data = await api('GET', `/sms/thread/${encodeURIComponent(number)}`);
      const messages = data?.messages || [];
      if (msgs) {
        if (!messages.length) { msgs.innerHTML = '<p style="color:#888">No messages</p>'; return; }
        msgs.innerHTML = messages.map((m) => `
          <div style="display:flex;flex-direction:${m.direction === 'outbound' ? 'row-reverse' : 'row'};margin:4px 0">
            <div style="max-width:70%;padding:8px 12px;border-radius:12px;
                        background:${m.direction === 'outbound' ? '#3498db' : '#f0f0f0'};
                        color:${m.direction === 'outbound' ? '#fff' : '#333'}">
              ${escHtml(m.body)}
              <div style="font-size:0.75em;opacity:0.7;margin-top:2px">${new Date(m.created_at).toLocaleString()}</div>
            </div>
          </div>`).join('');
        msgs.scrollTop = msgs.scrollHeight;
      }
    } catch (err) { toast(`Error loading thread: ${err.message}`, 'danger'); }
    loadThreads();
  }

  async function sendReply() {
    if (!activeThread) return;
    const input = el('sms-reply-input');
    const body  = input?.value?.trim();
    if (!body) return;
    try {
      await api('POST', '/sms/reply', { to: activeThread, body });
      input.value = '';
      openThread(activeThread, '');
      toast('SMS sent', 'success');
    } catch (err) { toast(`Send failed: ${err.message}`, 'danger'); }
  }

  async function openCompose() {
    const modal = el('sms-compose-modal');
    if (!modal) return;
    el('sms-compose-to').value   = '';
    el('sms-compose-body').value = '';
    const sel = el('sms-compose-client');
    if (sel && sel.options.length <= 1) {
      try {
        const data = await api('GET', '/clients');
        (data?.clients || []).forEach((c) => {
          const o = document.createElement('option');
          o.value = c.id; o.textContent = c.name;
          sel.appendChild(o);
        });
      } catch { /* ignore */ }
    }
    modal.style.display = 'flex';
    setTimeout(() => el('sms-compose-to').focus(), 100);
  }

  function closeCompose() { const m = el('sms-compose-modal'); if (m) m.style.display = 'none'; }

  async function sendComposed() {
    const to       = el('sms-compose-to')?.value?.trim();
    const body     = el('sms-compose-body')?.value?.trim();
    const clientId = el('sms-compose-client')?.value || null;
    if (!to || !body) { toast('To and message are required', 'danger'); return; }
    try {
      await api('POST', '/sms/reply', { to, body, client_id: clientId });
      closeCompose();
      loadThreads();
      toast('SMS sent', 'success');
    } catch (err) { toast(`Send failed: ${err.message}`, 'danger'); }
  }

  return { load, openThread, sendReply, loadThreads, openCompose, closeCompose, sendComposed };
})();

/* ============================================================
   Appointments Panel
   ============================================================ */
const AppointmentsPanel = (() => {
  const api = (...a) => App._api(...a);
  const toast = (...a) => App._toast(...a);
  const el = (id) => document.getElementById(id);
  const escHtml = (...a) => App._escHtml(...a);

  async function load() {
    const container = el('admin-appointments');
    if (!container) return;
    const from = el('appt-from')?.value || new Date().toISOString().slice(0, 10);
    const to   = el('appt-to')?.value || '';
    const tbody = el('appointments-tbody');
    if (tbody) tbody.innerHTML = '<tr><td colspan="7" style="padding:12px;color:#666">Loading...</td></tr>';
    try {
      const qs = `?from=${from}${to ? `&to=${to}` : ''}`;
      const data = await api('GET', `/appointments${qs}`);
      render(data?.appointments || []);
    } catch (err) { toast(`Appointments error: ${err.message}`, 'danger'); }
  }

  function render(rows) {
    const tbody = el('appointments-tbody');
    if (!tbody) return;
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="7" style="padding:12px;color:#888">No appointments</td></tr>';
      return;
    }
    const statusColor = { scheduled: '#3498db', completed: '#27ae60', cancelled: '#e74c3c', no_show: '#e67e22' };
    tbody.innerHTML = rows.map((r) => `<tr>
      <td>${new Date(r.starts_at).toLocaleString()}</td>
      <td>${escHtml(r.title)}</td>
      <td>${escHtml(r.client_name || '')}</td>
      <td>${escHtml(r.caller_name || '')}</td>
      <td>${escHtml(r.caller_phone || '')}</td>
      <td><span style="color:${statusColor[r.status] || '#666'}">${r.status}</span></td>
      <td>
        <button onclick="AppointmentsPanel.updateStatus('${r.id}','completed')" style="font-size:0.8em;margin-right:4px">Done</button>
        <button onclick="AppointmentsPanel.updateStatus('${r.id}','cancelled')" style="font-size:0.8em;margin-right:4px">Cancel</button>
        <a href="/api/appointments/${r.id}/ical" download style="font-size:0.8em;color:var(--primary)">&#128197; iCal</a>
      </td>
    </tr>`).join('');
  }

  async function updateStatus(id, status) {
    try {
      await api('PUT', `/appointments/${id}`, { status });
      load();
      toast(`Appointment ${status}`, 'success');
    } catch (err) { toast(`Error: ${err.message}`, 'danger'); }
  }

  async function openNew() {
    const modal = el('appt-modal');
    if (modal) {
      el('appt-modal-title-field').value  = '';
      el('appt-modal-client').value       = '';
      el('appt-modal-caller').value       = '';
      el('appt-modal-phone').value        = '';
      el('appt-modal-starts').value       = '';
      el('appt-modal-duration').value     = '30';
      el('appt-modal-notes').value        = '';
      modal.style.display = 'flex';
      // Populate client select
      const sel = el('appt-modal-client');
      if (sel && sel.options.length <= 1) {
        const data = await api('GET', '/clients');
        (data?.clients || []).forEach((c) => {
          const o = document.createElement('option');
          o.value = c.id; o.textContent = c.name;
          sel.appendChild(o);
        });
      }
    }
  }

  function closeNew() { const m = el('appt-modal'); if (m) m.style.display = 'none'; }

  async function saveNew() {
    const body = {
      title:            el('appt-modal-title-field')?.value?.trim(),
      client_id:        el('appt-modal-client')?.value || null,
      caller_name:      el('appt-modal-caller')?.value?.trim() || null,
      caller_phone:     el('appt-modal-phone')?.value?.trim()  || null,
      starts_at:        el('appt-modal-starts')?.value,
      duration_minutes: parseInt(el('appt-modal-duration')?.value || '30'),
      notes:            el('appt-modal-notes')?.value?.trim()  || null,
    };
    if (!body.title || !body.starts_at) { toast('Title and start time are required', 'danger'); return; }
    try {
      await api('POST', '/appointments', body);
      closeNew();
      load();
      toast('Appointment created', 'success');
    } catch (err) { toast(`Error: ${err.message}`, 'danger'); }
  }

  return { load, updateStatus, openNew, closeNew, saveNew };
})();

/* ============================================================
   Shifts Panel (operator scheduling)
   ============================================================ */
const ShiftsPanel = (() => {
  const api = (...a) => App._api(...a);
  const toast = (...a) => App._toast(...a);
  const el = (id) => document.getElementById(id);
  const escHtml = (...a) => App._escHtml(...a);

  async function load() {
    const container = el('admin-shifts');
    if (!container) return;
    const date = el('shifts-date')?.value || new Date().toISOString().slice(0, 10);
    const tbody = el('shifts-tbody');
    if (tbody) tbody.innerHTML = '<tr><td colspan="6" style="padding:12px;color:#666">Loading...</td></tr>';
    try {
      const data = await api('GET', `/shifts/coverage?date=${date}`);
      renderCoverage(data?.shifts || [], date);
      loadTimeOff();
    } catch (err) { toast(`Shifts error: ${err.message}`, 'danger'); }
  }

  function renderCoverage(rows, date) {
    const tbody = el('shifts-tbody');
    if (!tbody) return;
    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="6" style="padding:12px;color:#888">No shifts for ${date}</td></tr>`;
      return;
    }
    const typeColors = { regular: '#3498db', oncall: '#e67e22', training: '#9b59b6' };
    tbody.innerHTML = rows.map((r) => `<tr>
      <td>${escHtml(r.operator_name)}</td>
      <td>${r.start_time} – ${r.end_time}</td>
      <td><span style="color:${typeColors[r.shift_type] || '#666'}">${r.shift_type}</span></td>
      <td>${escHtml(r.notes || '')}</td>
      <td><span class="status-badge ${r.operator_status === 'available' ? 'ready' : ''}" style="font-size:0.75em">${r.operator_status || 'offline'}</span></td>
      <td><button onclick="ShiftsPanel.deleteShift('${r.id}')" style="font-size:0.8em">Delete</button></td>
    </tr>`).join('');
  }

  async function loadTimeOff() {
    const tbody = el('timeoff-tbody');
    if (!tbody) return;
    try {
      const data = await api('GET', '/shifts/timeoff');
      const rows = data?.requests || [];
      if (!rows.length) {
        tbody.innerHTML = '<tr><td colspan="6" style="padding:12px;color:#888">No requests</td></tr>';
        return;
      }
      tbody.innerHTML = rows.map((r) => `<tr>
        <td>${escHtml(r.operator_name)}</td>
        <td>${r.from_date} – ${r.to_date}</td>
        <td>${escHtml(r.reason || '')}</td>
        <td style="color:${r.status==='approved'?'#27ae60':r.status==='denied'?'#e74c3c':'#e67e22'}">${r.status}</td>
        <td>${r.reviewed_by_name ? escHtml(r.reviewed_by_name) : '-'}</td>
        <td>${r.status === 'pending' ? `
          <button onclick="ShiftsPanel.reviewTimeOff('${r.id}','approved')" style="font-size:0.8em;margin-right:4px">Approve</button>
          <button onclick="ShiftsPanel.reviewTimeOff('${r.id}','denied')" style="font-size:0.8em">Deny</button>` : '-'}
        </td>
      </tr>`).join('');
    } catch { /* ignore */ }
  }

  async function deleteShift(id) {
    if (!confirm('Delete this shift?')) return;
    try { await api('DELETE', `/shifts/${id}`); load(); toast('Shift deleted', 'info'); }
    catch (err) { toast(`Error: ${err.message}`, 'danger'); }
  }

  async function reviewTimeOff(id, status) {
    try { await api('PUT', `/shifts/timeoff/${id}`, { status }); loadTimeOff(); toast(`Request ${status}`, 'success'); }
    catch (err) { toast(`Error: ${err.message}`, 'danger'); }
  }

  async function openNew() {
    const modal = el('shift-modal');
    if (!modal) return;
    el('shift-modal-date').value  = el('shifts-date')?.value || new Date().toISOString().slice(0, 10);
    el('shift-modal-start').value = '09:00';
    el('shift-modal-end').value   = '17:00';
    el('shift-modal-type').value  = 'regular';
    el('shift-modal-notes').value = '';
    const sel = el('shift-modal-operator');
    if (sel && sel.options.length <= 1) {
      try {
        const data = await api('GET', '/operators');
        (data?.operators || []).forEach((op) => {
          const o = document.createElement('option');
          o.value = op.id; o.textContent = op.full_name || op.username;
          sel.appendChild(o);
        });
      } catch { /* ignore */ }
    }
    modal.style.display = 'flex';
  }

  function closeNew() { const m = el('shift-modal'); if (m) m.style.display = 'none'; }

  async function saveNew() {
    const body = {
      operator_id: el('shift-modal-operator')?.value,
      shift_date:  el('shift-modal-date')?.value,
      start_time:  el('shift-modal-start')?.value,
      end_time:    el('shift-modal-end')?.value,
      shift_type:  el('shift-modal-type')?.value || 'regular',
      notes:       el('shift-modal-notes')?.value?.trim() || null,
    };
    if (!body.operator_id || !body.shift_date || !body.start_time || !body.end_time) {
      toast('Operator, date, start and end time are required', 'danger');
      return;
    }
    try {
      await api('POST', '/shifts', body);
      closeNew();
      load();
      toast('Shift added', 'success');
    } catch (err) { toast(`Error: ${err.message}`, 'danger'); }
  }

  return { load, deleteShift, reviewTimeOff, loadTimeOff, openNew, closeNew, saveNew };
})();

/* ============================================================
   IVR Builder Panel
   ============================================================ */
const IVRPanel = (() => {
  const api = (...a) => App._api(...a);
  const toast = (...a) => App._toast(...a);
  const el = (id) => document.getElementById(id);
  const escHtml = (...a) => App._escHtml(...a);

  async function load() {
    const container = el('admin-ivr');
    if (!container) return;
    const tbody = el('ivr-tbody');
    if (tbody) tbody.innerHTML = '<tr><td colspan="5" style="padding:12px;color:#666">Loading...</td></tr>';
    try {
      const data = await api('GET', '/ivr');
      render(data?.flows || []);
    } catch (err) { toast(`IVR error: ${err.message}`, 'danger'); }
  }

  function render(rows) {
    const tbody = el('ivr-tbody');
    if (!tbody) return;
    if (!rows.length) { tbody.innerHTML = '<tr><td colspan="5" style="padding:12px;color:#888">No IVR flows</td></tr>'; return; }
    tbody.innerHTML = rows.map((r) => `<tr>
      <td>${escHtml(r.name)}</td>
      <td>${escHtml(r.client_name)}</td>
      <td>${r.node_count} nodes</td>
      <td style="color:${r.is_active ? '#27ae60' : '#e74c3c'}">${r.is_active ? 'Active' : 'Draft'}</td>
      <td>
        <button onclick="IVRPanel.toggleActive('${r.id}',${!r.is_active})" style="font-size:0.8em;margin-right:4px">${r.is_active ? 'Deactivate' : 'Activate'}</button>
        <a href="/api/ivr/${r.id}/export" style="font-size:0.8em;margin-right:4px">Export</a>
        <button onclick="IVRPanel.deleteFlow('${r.id}')" style="font-size:0.8em">Delete</button>
      </td>
    </tr>`).join('');
  }

  async function toggleActive(id, active) {
    try { await api('PUT', `/ivr/${id}`, { is_active: active }); load(); }
    catch (err) { toast(`Error: ${err.message}`, 'danger'); }
  }

  async function add() {
    const clientsData = await api('GET', '/clients').catch(() => ({ clients: [] }));
    const clients = clientsData.clients || [];
    const clientOpts = clients.map((c) => `${c.name} [${c.id.slice(0,8)}]`).join('\n');
    const nameIn = (prompt('IVR flow name:') || '').trim();
    if (!nameIn) return;
    const clientInput = (prompt(`Client ID (copy from list below, or leave blank for global):\n${clientOpts}`) || '').trim();
    const client_id = clients.find((c) => c.id.startsWith(clientInput) || c.name === clientInput)?.id || clientInput || null;
    try {
      await api('POST', '/ivr', { name: nameIn, client_id, nodes: [] });
      toast('IVR flow created (0 nodes — configure via API)', 'success');
      load();
    } catch (err) { toast(`Error: ${err.message}`, 'danger'); }
  }

  async function deleteFlow(id) {
    if (!confirm('Delete this IVR flow?')) return;
    try { await api('DELETE', `/ivr/${id}`); load(); toast('IVR flow deleted', 'info'); }
    catch (err) { toast(`Error: ${err.message}`, 'danger'); }
  }

  return { load, add, toggleActive, deleteFlow };
})();

/* ============================================================
   Voicemail Panel
   ============================================================ */
const VoicemailPanel = (() => {
  const api = (...a) => App._api(...a);
  const toast = (...a) => App._toast(...a);
  const el = (id) => document.getElementById(id);
  const escHtml = (...a) => App._escHtml(...a);

  async function load() {
    const container = el('admin-voicemail');
    if (!container) return;
    const tbody = el('voicemail-tbody');
    if (tbody) tbody.innerHTML = '<tr><td colspan="5" style="padding:12px;color:#666">Loading...</td></tr>';
    try {
      const data = await api('GET', '/voicemail');
      render(data?.boxes || []);
    } catch (err) { toast(`Voicemail error: ${err.message}`, 'danger'); }
  }

  function render(rows) {
    const tbody = el('voicemail-tbody');
    if (!tbody) return;
    if (!rows.length) { tbody.innerHTML = '<tr><td colspan="6" style="padding:12px;color:#888">No voicemail boxes</td></tr>'; return; }
    tbody.innerHTML = rows.map((r) => `<tr>
      <td>${escHtml(r.mailbox_number)}</td>
      <td>${escHtml(r.client_name || '—')}</td>
      <td>${r.retention_days} days</td>
      <td>${r.max_message_seconds}s</td>
      <td>${escHtml(r.notify_email || '-')}</td>
      <td>
        <button onclick="VoicemailPanel.viewMessages('${r.id}','${escHtml(r.mailbox_number)}')" style="font-size:0.8em;margin-right:4px">Messages</button>
        <button onclick="VoicemailPanel.deleteBox('${r.id}')" style="font-size:0.8em">Delete</button>
      </td>
    </tr>`).join('');
  }

  async function viewMessages(id, number) {
    try {
      const data = await api('GET', `/voicemail/${id}/messages`);
      const msgs = data?.messages || [];
      const info = msgs.length
        ? msgs.map((m) => `${new Date(m.started_at).toLocaleString()} — ${m.caller_id} — ${m.duration_seconds}s\n${m.recording_transcript || '(no transcript)'}`).join('\n\n')
        : 'No voicemail messages found.';
      alert(`Voicemail box ${number}:\n\n${info}`);
    } catch (err) { toast(`Error: ${err.message}`, 'danger'); }
  }

  async function add() {
    const clientsData = await api('GET', '/clients').catch(() => ({ clients: [] }));
    const clients = clientsData.clients || [];
    const clientOpts = clients.map((c) => `${c.name}: ${c.id.slice(0,8)}`).join('\n');
    const clientInput = (prompt(`Client ID (paste first 8 chars from list, or leave blank):\n${clientOpts}`) || '').trim();
    const client_id = clients.find((c) => c.id.startsWith(clientInput) || c.name === clientInput)?.id || clientInput || null;
    const mailbox_number = (prompt('Mailbox number (3–10 digits, e.g. 001):') || '').trim();
    if (!mailbox_number) return;
    const pin = (prompt('PIN (4–8 digits):') || '').trim();
    if (!pin) return;
    const notify_email = (prompt('Notify email when message arrives (optional):') || '').trim();
    const retention_days = parseInt(prompt('Message retention in days (default 30):', '30') || '30');
    try {
      await api('POST', '/voicemail', {
        client_id: client_id || null,
        mailbox_number,
        pin,
        notify_email: notify_email || undefined,
        retention_days,
      });
      toast('Voicemail box created', 'success');
      load();
    } catch (err) { toast(`Error: ${err.message}`, 'danger'); }
  }

  async function deleteBox(id) {
    if (!confirm('Delete this voicemail box?')) return;
    try { await api('DELETE', `/voicemail/${id}`); load(); toast('Box deleted', 'info'); }
    catch (err) { toast(`Error: ${err.message}`, 'danger'); }
  }

  return { load, add, viewMessages, deleteBox };
})();

/* ============================================================
   Callbacks Panel
   ============================================================ */
const CallbacksPanel = (() => {
  const api = (...a) => App._api(...a);
  const toast = (...a) => App._toast(...a);
  const el = (id) => document.getElementById(id);
  const escHtml = (...a) => App._escHtml(...a);

  async function load() {
    const container = el('admin-callbacks');
    if (!container) return;
    const tbody = el('callbacks-tbody');
    if (tbody) tbody.innerHTML = '<tr><td colspan="5" style="padding:12px;color:#666">Loading...</td></tr>';
    try {
      const data = await api('GET', '/callbacks');
      render(data?.campaigns || []);
    } catch (err) { toast(`Callbacks error: ${err.message}`, 'danger'); }
  }

  function render(campaigns) {
    const tbody = el('callbacks-tbody');
    if (!tbody) return;
    if (!campaigns.length) { tbody.innerHTML = '<tr><td colspan="7" style="padding:12px;color:#888">No campaigns</td></tr>'; return; }
    const statusColor = { active: '#27ae60', paused: '#e67e22', draft: '#3498db', completed: '#888', cancelled: '#e74c3c' };
    tbody.innerHTML = campaigns.map((c) => `<tr>
      <td>${escHtml(c.name)}</td>
      <td>${escHtml(c.client_name || '—')}</td>
      <td style="color:${statusColor[c.status] || '#666'}">${c.status}</td>
      <td>${c.completed_records || 0} / ${c.total_records || 0}</td>
      <td>${c.max_attempts}</td>
      <td>${new Date(c.created_at).toLocaleDateString()}</td>
      <td>
        <button onclick="CallbacksPanel.getNext('${c.id}')" class="btn btn-sm btn-secondary">Next</button>
        ${c.status === 'active'
          ? `<button onclick="CallbacksPanel.setStatus('${c.id}','paused')" class="btn btn-sm btn-secondary" style="margin-left:3px">Pause</button>`
          : c.status === 'paused' ? `<button onclick="CallbacksPanel.setStatus('${c.id}','active')" class="btn btn-sm btn-secondary" style="margin-left:3px">Resume</button>` : ''}
        <button onclick="CallbacksPanel.del('${c.id}')" class="btn btn-sm" style="background:#e74c3c;color:#fff;border:none;padding:3px 8px;border-radius:4px;cursor:pointer;margin-left:3px">Delete</button>
      </td>
    </tr>`).join('');
  }

  async function add() {
    const clientsData = await api('GET', '/clients').catch(() => ({ clients: [] }));
    const clients = clientsData.clients || [];
    const clientOpts = clients.map((c) => `${c.name}: ${c.id.slice(0,8)}`).join('\n');
    const clientInput = (prompt(`Client ID (from list):\n${clientOpts}`) || '').trim();
    if (!clientInput) return;
    const client_id = clients.find((c) => c.id.startsWith(clientInput) || c.name === clientInput)?.id;
    if (!client_id) { toast('Client not found', 'danger'); return; }
    const name = (prompt('Campaign name:') || '').trim();
    if (!name) return;
    const from_number = (prompt('From number (E.164, used for outbound calls):') || '').trim();
    const max_attempts = parseInt(prompt('Max attempts per record (default 3):', '3') || '3');
    try {
      await api('POST', '/callbacks', { client_id, name, from_number: from_number || undefined, max_attempts });
      toast('Campaign created', 'success');
      load();
    } catch (err) { toast(`Error: ${err.message}`, 'danger'); }
  }

  async function getNext(campaignId) {
    try {
      const data = await api('GET', `/callbacks/queue/next?campaign_id=${campaignId}`);
      if (!data?.record) { toast('No more records in queue', 'info'); return; }
      const r = data.record;
      toast(`Next: ${r.phone_number} — ${r.contact_name || 'Unknown'} (attempt ${r.attempts + 1})`, 'info', 8000);
    } catch (err) { toast(`Error: ${err.message}`, 'danger'); }
  }

  async function setStatus(id, status) {
    try { await api('PUT', `/callbacks/${id}`, { status }); load(); }
    catch (err) { toast(`Error: ${err.message}`, 'danger'); }
  }

  async function del(id) {
    if (!confirm('Delete this campaign and all its records?')) return;
    try { await api('DELETE', `/callbacks/${id}`); load(); toast('Campaign deleted', 'info'); }
    catch (err) { toast(`Error: ${err.message}`, 'danger'); }
  }

  return { load, add, getNext, setStatus, del };
})();

/* ============================================================
   Scripts Panel
   ============================================================ */
const ScriptsPanel = (() => {
  const api = (...a) => App._api(...a);
  const toast = (...a) => App._toast(...a);
  const el = (id) => document.getElementById(id);
  const escHtml = (...a) => App._escHtml(...a);

  async function load() {
    const container = el('admin-scripts');
    if (!container) return;
    const industry = el('scripts-industry-filter')?.value || '';
    const list = el('scripts-list');
    if (list) list.innerHTML = '<p style="color:#666">Loading...</p>';
    try {
      const data = await api('GET', `/scripts/templates${industry ? `?industry=${encodeURIComponent(industry)}` : ''}`);
      render(data?.templates || []);
      loadIndustries();
    } catch (err) { toast(`Scripts error: ${err.message}`, 'danger'); }
  }

  let _templates = [];

  function render(templates) {
    _templates = templates;
    const list = el('scripts-list');
    if (!list) return;
    if (!templates.length) { list.innerHTML = '<p style="color:#888">No templates</p>'; return; }
    list.innerHTML = templates.map((t) => `
      <div style="border:1px solid var(--border);border-radius:6px;padding:12px;margin-bottom:8px;background:var(--bg-secondary)">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">
          <div>
            <strong>${escHtml(t.name)}</strong>
            <span style="color:var(--text-muted);font-size:0.85em;margin-left:8px">${escHtml(t.industry || 'General')}</span>
          </div>
          <div style="display:flex;gap:6px;flex-shrink:0">
            <button class="btn btn-sm btn-secondary" onclick="ScriptsPanel.applyToClient('${t.id}')">Apply to Client</button>
            <button class="btn btn-sm" style="background:#e74c3c;color:#fff;border:none;padding:3px 8px;border-radius:4px;cursor:pointer" onclick="ScriptsPanel.del('${t.id}')">Delete</button>
          </div>
        </div>
        <div style="color:var(--text-muted);font-size:0.875em;margin-top:6px;white-space:pre-wrap;max-height:80px;overflow:hidden">${escHtml((t.template_text || '').slice(0, 200))}${(t.template_text||'').length > 200 ? '…' : ''}</div>
      </div>`).join('');
  }

  async function loadIndustries() {
    const sel = el('scripts-industry-filter');
    if (!sel || sel.dataset.loaded) return;
    try {
      const data = await api('GET', '/scripts/industries');
      (data?.industries || []).forEach((ind) => {
        const o = document.createElement('option');
        o.value = ind; o.textContent = ind;
        sel.appendChild(o);
      });
      sel.dataset.loaded = '1';
    } catch { /* ignore */ }
  }

  async function add() {
    const name = (prompt('Template name (e.g. "GP Surgery Script"):') || '').trim();
    if (!name) return;
    const industry = (prompt('Industry (e.g. "Medical", "Legal", "Real Estate"):') || '').trim();
    const template_text = (prompt('Script template text (use {{caller_name}}, {{client_name}} etc. as placeholders):') || '').trim();
    if (!template_text) return;
    try {
      await api('POST', '/scripts/templates', { name, industry: industry || undefined, template_text });
      toast('Template created', 'success');
      load();
    } catch (err) { toast(`Error: ${err.message}`, 'danger'); }
  }

  async function applyToClient(templateId) {
    const clientsData = await api('GET', '/clients').catch(() => ({ clients: [] }));
    const clients = clientsData.clients || [];
    const clientOpts = clients.map((c) => `${c.name}: ${c.id.slice(0,8)}`).join('\n');
    const clientInput = (prompt(`Apply template to client:\n${clientOpts}`) || '').trim();
    if (!clientInput) return;
    const client = clients.find((c) => c.id.startsWith(clientInput) || c.name === clientInput);
    if (!client) { toast('Client not found', 'danger'); return; }
    try {
      await api('POST', `/scripts/apply/${templateId}/client/${client.id}`, {});
      toast(`Template applied to ${client.name}`, 'success');
    } catch (err) { toast(`Error: ${err.message}`, 'danger'); }
  }

  async function del(id) {
    if (!confirm('Delete this template?')) return;
    try { await api('DELETE', `/scripts/templates/${id}`); load(); toast('Template deleted', 'info'); }
    catch (err) { toast(`Error: ${err.message}`, 'danger'); }
  }

  return { load, add, applyToClient, del };
})();

/* ============================================================
   DIDs Panel
   ============================================================ */
const DIDsPanel = (() => {
  const api = (...a) => App._api(...a);
  const toast = (...a) => App._toast(...a);
  const el = (id) => document.getElementById(id);
  const escHtml = (...a) => App._escHtml(...a);

  let _allDids = [];
  let _clients = [];

  async function load() {
    const container = el('admin-dids');
    if (!container) return;
    const tbody = el('dids-tbody');
    if (tbody) tbody.innerHTML = '<tr><td colspan="7" style="padding:12px;color:#666">Loading...</td></tr>';
    try {
      const [didData, clientData] = await Promise.all([
        api('GET', '/dids'),
        api('GET', '/clients'),
      ]);
      _allDids   = didData?.dids     || [];
      _clients   = clientData?.clients || [];
      render(_allDids);
    } catch (err) { toast(`DIDs error: ${err.message}`, 'danger'); }
  }

  function filter() {
    const q = (el('did-search')?.value || '').toLowerCase();
    render(q ? _allDids.filter((d) =>
      (d.number || '').includes(q) ||
      (d.label  || '').toLowerCase().includes(q) ||
      (d.client_name || '').toLowerCase().includes(q) ||
      (d.provider || '').toLowerCase().includes(q)
    ) : _allDids);
  }

  function render(rows) {
    const tbody = el('dids-tbody');
    if (!tbody) return;
    if (!rows.length) { tbody.innerHTML = '<tr><td colspan="7" style="padding:12px;color:#888">No DIDs found</td></tr>'; return; }
    tbody.innerHTML = rows.map((r) => {
      const clientOpts = ['<option value="">— Unassigned —</option>',
        ..._clients.map((c) => `<option value="${c.id}" ${c.id === r.client_id ? 'selected' : ''}>${escHtml(c.name)}</option>`)
      ].join('');
      return `<tr>
        <td><code>${escHtml(r.number)}</code></td>
        <td>${escHtml(r.label || '—')}</td>
        <td>
          <select style="font-size:0.82rem" onchange="DIDsPanel.assignClient('${r.id}', this.value)">
            ${clientOpts}
          </select>
        </td>
        <td>${escHtml(r.provider || '—')}</td>
        <td>${r.monthly_cost ? '£' + parseFloat(r.monthly_cost).toFixed(2) : '—'}</td>
        <td style="color:${r.is_active ? '#27ae60' : '#e74c3c'}">${r.is_active ? 'Active' : 'Inactive'}</td>
        <td>
          <button onclick="DIDsPanel.toggleActive('${r.id}', ${!r.is_active})" class="btn btn-sm btn-secondary">${r.is_active ? 'Deactivate' : 'Activate'}</button>
          <button onclick="DIDsPanel.deleteDID('${r.id}')" class="btn btn-sm" style="background:#e74c3c;color:#fff;border:none;padding:3px 8px;border-radius:4px;cursor:pointer;margin-left:4px">Delete</button>
        </td>
      </tr>`;
    }).join('');
  }

  async function add() {
    const number = (prompt('DID number (E.164, e.g. +441604000001):') || '').trim();
    if (!number) return;
    const label    = (prompt('Label (e.g. "Main Reception line"):') || '').trim();
    const provider = (prompt('Provider (e.g. Twilio, VoIP.ms):') || '').trim();
    const costStr  = (prompt('Monthly cost (£, leave blank to skip):') || '').trim();
    const monthly_cost = costStr ? parseFloat(costStr) : undefined;
    try {
      await api('POST', '/dids', { number, label: label || undefined, provider: provider || undefined, monthly_cost });
      toast('DID added', 'success');
      load();
    } catch (err) { toast(`Error: ${err.message}`, 'danger'); }
  }

  async function assignClient(didId, clientId) {
    try {
      await api('PUT', `/dids/${didId}`, { client_id: clientId || null });
      const d = _allDids.find((x) => x.id === didId);
      if (d) { d.client_id = clientId || null; d.client_name = _clients.find((c) => c.id === clientId)?.name || null; }
      toast('DID assigned', 'success');
    } catch (err) { toast(`Error: ${err.message}`, 'danger'); load(); }
  }

  async function toggleActive(id, active) {
    try {
      await api('PUT', `/dids/${id}`, { is_active: active });
      toast(active ? 'DID activated' : 'DID deactivated', 'info');
      load();
    } catch (err) { toast(`Error: ${err.message}`, 'danger'); }
  }

  async function deleteDID(id) {
    if (!confirm('Delete this DID? This cannot be undone.')) return;
    try { await api('DELETE', `/dids/${id}`); load(); toast('DID deleted', 'info'); }
    catch (err) { toast(`Error: ${err.message}`, 'danger'); }
  }

  return { load, filter, add, assignClient, toggleActive, deleteDID };
})();

/* ============================================================
   Routing Rules Panel
   ============================================================ */
const RoutingPanel = (() => {
  const api = (...a) => App._api(...a);
  const toast = (...a) => App._toast(...a);
  const el = (id) => document.getElementById(id);
  const escHtml = (...a) => App._escHtml(...a);

  async function load() {
    const container = el('admin-routing');
    if (!container) return;
    const tbody = el('routing-tbody');
    if (tbody) tbody.innerHTML = '<tr><td colspan="6" style="padding:12px;color:#666">Loading...</td></tr>';
    try {
      const data = await api('GET', '/routing-rules');
      render(data?.rules || []);
    } catch (err) { toast(`Routing error: ${err.message}`, 'danger'); }
  }

  function render(rows) {
    const tbody = el('routing-tbody');
    if (!tbody) return;
    if (!rows.length) { tbody.innerHTML = '<tr><td colspan="8" style="padding:12px;color:#888">No routing rules</td></tr>'; return; }
    tbody.innerHTML = rows.map((r) => `<tr>
      <td>${escHtml(r.name)}</td>
      <td>${escHtml(r.match_area_code || '*')}</td>
      <td>${escHtml(r.match_country || '*')}</td>
      <td>${escHtml(r.match_did || '*')}</td>
      <td>${(r.target_skills || []).map((s) => escHtml(s)).join(', ') || 'Any'}</td>
      <td>${r.priority || 100}</td>
      <td style="color:${r.is_active ? '#27ae60' : '#e74c3c'}">${r.is_active ? 'Active' : 'Off'}</td>
      <td><button class="btn btn-sm" style="background:#e74c3c;color:#fff;border:none;padding:2px 8px;border-radius:4px;cursor:pointer" onclick="RoutingPanel.del('${r.id}')">Delete</button></td>
    </tr>`).join('');
  }

  async function add() {
    const name = (prompt('Rule name (e.g. "UK Medical Calls"):') || '').trim();
    if (!name) return;
    const areaCode  = (prompt('Match area code (e.g. 020, leave blank to match all):') || '').trim();
    const country   = (prompt('Match country code (e.g. GB, US, leave blank to match all):') || '').trim();
    const did       = (prompt('Match specific DID (E.164, leave blank for all):') || '').trim();
    const skillsIn  = (prompt('Required skills (comma-separated, e.g. Medical,Spanish):') || '').trim();
    const target_skills = skillsIn ? skillsIn.split(',').map((s) => s.trim()).filter(Boolean) : [];
    const priority  = parseInt(prompt('Priority (lower = higher priority, default 100):', '100') || '100');
    try {
      await api('POST', '/routing-rules', {
        name,
        match_area_code: areaCode || undefined,
        match_country:   country  || undefined,
        match_did:       did      || undefined,
        target_skills,
        priority,
      });
      toast('Routing rule added', 'success');
      load();
    } catch (err) { toast(`Error: ${err.message}`, 'danger'); }
  }

  async function del(id) {
    if (!confirm('Delete this routing rule?')) return;
    try { await api('DELETE', `/routing-rules/${id}`); load(); toast('Rule deleted', 'info'); }
    catch (err) { toast(`Error: ${err.message}`, 'danger'); }
  }

  return { load, add, del };
})();

/* ============================================================
   Audit Log Panel
   ============================================================ */
const AuditPanel = (() => {
  const api = (...a) => App._api(...a);
  const toast = (...a) => App._toast(...a);
  const el = (id) => document.getElementById(id);
  const escHtml = (...a) => App._escHtml(...a);

  async function load() {
    const container = el('admin-audit');
    if (!container) return;
    const tbody = el('audit-tbody');
    if (tbody) tbody.innerHTML = '<tr><td colspan="5" style="padding:12px;color:#666">Loading...</td></tr>';
    try {
      const from = el('audit-from')?.value;
      const to   = el('audit-to')?.value;
      const qs   = `?limit=100${from ? `&from=${from}` : ''}${to ? `&to=${to}` : ''}`;
      const data = await api('GET', `/audit${qs}`);
      render(data?.entries || []);
    } catch (err) { toast(`Audit error: ${err.message}`, 'danger'); }
  }

  function render(rows) {
    const tbody = el('audit-tbody');
    if (!tbody) return;
    if (!rows.length) { tbody.innerHTML = '<tr><td colspan="5" style="padding:12px;color:#888">No entries</td></tr>'; return; }
    tbody.innerHTML = rows.map((r) => `<tr>
      <td style="white-space:nowrap">${new Date(r.ts).toLocaleString()}</td>
      <td>${escHtml(r.operator_name || '')}</td>
      <td><code>${escHtml(r.action)}</code></td>
      <td>${escHtml(r.resource_type || '')}</td>
      <td style="color:#888;font-size:0.85em">${escHtml(r.ip_address || '')}</td>
    </tr>`).join('');
  }

  function exportCsv() {
    const from = el('audit-from')?.value;
    const to   = el('audit-to')?.value;
    const qs   = `${from ? `?from=${from}` : '?'}${to ? `${from ? '&' : ''}to=${to}` : ''}`;
    window.location = `/api/audit/export.csv${qs}`;
  }

  return { load, exportCsv };
})();

/* ============================================================
   Knowledge Admin Panel
   ============================================================ */
const KnowledgeAdmin = (() => {
  const api = (...a) => App._api(...a);
  const toast = (...a) => App._toast(...a);
  const el = (id) => document.getElementById(id);
  const escHtml = (...a) => App._escHtml(...a);

  async function load() {
    const container = el('admin-knowledge');
    if (!container) return;
    const tbody = el('knowledge-tbody');
    if (tbody) tbody.innerHTML = '<tr><td colspan="5" style="padding:12px;color:#666">Loading...</td></tr>';
    try {
      const data = await api('GET', '/knowledge');
      render(data?.articles || []);
    } catch (err) { toast(`Knowledge error: ${err.message}`, 'danger'); }
  }

  function render(rows) {
    const tbody = el('knowledge-tbody');
    if (!tbody) return;
    if (!rows.length) { tbody.innerHTML = '<tr><td colspan="5" style="padding:12px;color:#888">No articles</td></tr>'; return; }
    tbody.innerHTML = rows.map((r) => `<tr>
      <td>${escHtml(r.title)}</td>
      <td>${escHtml(r.category || '—')}</td>
      <td>${escHtml((r.tags || []).join(', ') || '—')}</td>
      <td style="color:${r.is_published ? '#27ae60' : '#e67e22'}">${r.is_published ? 'Published' : 'Draft'}</td>
      <td><button onclick="KnowledgeAdmin.delete('${r.id}')" style="font-size:0.8em">Delete</button></td>
    </tr>`).join('');
  }

  async function add() {
    const title = (prompt('Article title:') || '').trim();
    if (!title) return;
    const body = (prompt('Article body/content:') || '').trim();
    if (!body) return;
    const category = (prompt('Category (e.g. "FAQs", "Procedures", leave blank):') || '').trim();
    const tagsIn   = (prompt('Tags (comma-separated, leave blank for none):') || '').trim();
    const tags = tagsIn ? tagsIn.split(',').map((t) => t.trim()).filter(Boolean) : [];
    const is_published = confirm('Publish immediately? (Cancel = save as draft)');
    try {
      await api('POST', '/knowledge', { title, body, category: category || undefined, tags, is_published });
      toast('Article created', 'success');
      load();
    } catch (err) { toast(`Error: ${err.message}`, 'danger'); }
  }

  async function deleteArticle(id) {
    if (!confirm('Delete this article?')) return;
    try { await api('DELETE', `/knowledge/${id}`); load(); toast('Article deleted', 'info'); }
    catch (err) { toast(`Error: ${err.message}`, 'danger'); }
  }

  return { load, add, delete: deleteArticle };
})();

/* ============================================================
   SkillsPanel — Operator Skills Admin
   ============================================================ */
const SkillsPanel = (() => {
  const api = (...a) => App._api(...a);
  const toast = (...a) => App._toast(...a);
  const escHtml = (...a) => App._escHtml(...a);
  const el = (id) => document.getElementById(id);

  let _operators = [];
  let _catalog = [];

  async function load() {
    const container = el('admin-skills');
    if (!container) return;
    try {
      const [catData, opsData] = await Promise.all([
        api('GET', '/operator-skills/catalog'),
        api('GET', '/operators'),
      ]);
      _catalog = catData.skills || [];
      _operators = (opsData.operators || []).filter((o) => o.is_active !== false);
      renderCatalog();
      renderOperators();
    } catch (err) { toast(`Skills error: ${err.message}`, 'danger'); }
  }

  function renderCatalog() {
    const tbody = el('skills-catalog-tbody');
    if (!tbody) return;
    if (!_catalog.length) {
      tbody.innerHTML = '<tr><td colspan="3" class="empty-state">No skills defined yet</td></tr>';
      return;
    }
    tbody.innerHTML = _catalog.map((skill) => {
      const count = _operators.filter((o) => (o.skills || []).includes(skill)).length;
      return `<tr>
        <td>${escHtml(skill)}</td>
        <td>${count}</td>
        <td><button class="btn btn-sm" style="background:#e74c3c;color:#fff;border:none;padding:2px 8px;border-radius:4px;cursor:pointer"
          onclick="SkillsPanel.removeSkillFromAll('${escHtml(skill)}')">Remove All</button></td>
      </tr>`;
    }).join('');
  }

  function renderOperators() {
    const tbody = el('skills-operators-tbody');
    if (!tbody) return;
    if (!_operators.length) {
      tbody.innerHTML = '<tr><td colspan="4" class="empty-state">No operators</td></tr>';
      return;
    }
    tbody.innerHTML = _operators.map((op) => {
      const skills = (op.skills || []).join(', ') || '—';
      return `<tr>
        <td>${escHtml(op.full_name)}</td>
        <td>${escHtml(skills)}</td>
        <td>${escHtml(op.preferred_language || 'en')}</td>
        <td><button class="btn btn-sm btn-secondary" onclick="SkillsPanel.editOperator('${op.id}')">Edit</button></td>
      </tr>`;
    }).join('');
  }

  async function addSkill() {
    const name = (prompt('New skill name (e.g. "Spanish", "Medical", "Level-2 Tech"):') || '').trim();
    if (!name) return;
    if (_catalog.includes(name)) { toast('Skill already exists', 'info'); return; }
    // Skills live on operators; add to first admin if no one has it yet
    toast(`Skill "${name}" will appear once assigned to an operator`, 'info');
  }

  async function editOperator(operatorId) {
    const op = _operators.find((o) => o.id === operatorId);
    if (!op) return;
    const current = (op.skills || []).join(', ');
    const input = prompt(`Skills for ${op.full_name} (comma-separated):\n\nAll catalog skills: ${_catalog.join(', ') || 'none'}`, current);
    if (input === null) return;
    const newSkills = input.split(',').map((s) => s.trim()).filter(Boolean);
    const langInput = prompt(`Preferred language code for ${op.full_name} (e.g. en, es, fr):`, op.preferred_language || 'en');
    if (langInput === null) return;
    try {
      await api('PUT', `/operator-skills/${operatorId}`, { skills: newSkills, preferred_language: langInput.trim() || 'en' });
      toast('Skills updated', 'success');
      load();
    } catch (err) { toast(`Error: ${err.message}`, 'danger'); }
  }

  async function removeSkillFromAll(skill) {
    if (!confirm(`Remove skill "${skill}" from all operators?`)) return;
    try {
      await Promise.all(
        _operators
          .filter((o) => (o.skills || []).includes(skill))
          .map((o) => api('PUT', `/operator-skills/${o.id}`, { skills: (o.skills || []).filter((s) => s !== skill) }))
      );
      toast(`Skill "${skill}" removed`, 'info');
      load();
    } catch (err) { toast(`Error: ${err.message}`, 'danger'); }
  }

  return { load, addSkill, editOperator, removeSkillFromAll };
})();

/* ============================================================
   DncPanel — Do Not Call List Admin
   ============================================================ */
const DncPanel = (() => {
  const api = (...a) => App._api(...a);
  const toast = (...a) => App._toast(...a);
  const escHtml = (...a) => App._escHtml(...a);
  const el = (id) => document.getElementById(id);

  async function load() {
    if (!el('admin-dnc')) return;
    const tbody = el('dnc-tbody');
    if (tbody) tbody.innerHTML = '<tr><td colspan="6" class="empty-state">Loading...</td></tr>';
    try {
      const data = await api('GET', '/dnc');
      render(data.numbers || []);
    } catch (err) { toast(`DNC error: ${err.message}`, 'danger'); }
  }

  function render(rows) {
    const tbody = el('dnc-tbody');
    if (!tbody) return;
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="empty-state">No numbers on DNC list</td></tr>';
      return;
    }
    tbody.innerHTML = rows.map((r) => `<tr>
      <td><code>${escHtml(r.phone)}</code></td>
      <td>${escHtml(r.reason || '—')}</td>
      <td>${escHtml(r.added_by_name || '—')}</td>
      <td>${r.expires_at ? new Date(r.expires_at).toLocaleDateString() : 'Never'}</td>
      <td>${new Date(r.created_at).toLocaleDateString()}</td>
      <td><button class="btn btn-sm" style="background:#e74c3c;color:#fff;border:none;padding:2px 8px;border-radius:4px;cursor:pointer"
        onclick="DncPanel.remove('${r.id}')">Remove</button></td>
    </tr>`).join('');
  }

  async function add() {
    const phone = (prompt('Phone number to add to DNC list:') || '').trim();
    if (!phone) return;
    const reason = (prompt('Reason (optional):') || '').trim();
    try {
      await api('POST', '/dnc', { phone, reason: reason || undefined });
      toast('Number added to DNC list', 'success');
      load();
    } catch (err) { toast(`Error: ${err.message}`, 'danger'); }
  }

  async function remove(id) {
    if (!confirm('Remove this number from the DNC list?')) return;
    try {
      await api('DELETE', `/dnc/${id}`);
      toast('Number removed', 'info');
      load();
    } catch (err) { toast(`Error: ${err.message}`, 'danger'); }
  }

  async function check() {
    const input = el('dnc-check-input');
    const phone = (input?.value || '').trim();
    const resultEl = el('dnc-check-result');
    if (!phone || !resultEl) return;
    try {
      const data = await api('POST', '/dnc/check', { phone });
      if (data.on_dnc) {
        resultEl.innerHTML = `<span style="color:#e74c3c;font-weight:600">&#128683; On DNC list</span> — Reason: ${escHtml(data.reason || 'none')}`;
      } else {
        resultEl.innerHTML = `<span style="color:#27ae60;font-weight:600">&#10003; Not on DNC list</span>`;
      }
    } catch (err) { resultEl.textContent = `Error: ${err.message}`; }
  }

  return { load, add, remove, check };
})();

/* ============================================================
   TranscriptionPanel — Call Transcription Admin
   ============================================================ */
const TranscriptionPanel = (() => {
  const api = (...a) => App._api(...a);
  const toast = (...a) => App._toast(...a);
  const escHtml = (...a) => App._escHtml(...a);
  const el = (id) => document.getElementById(id);

  async function load() {
    if (!el('admin-transcription')) return;
    const tbody = el('transcription-tbody');
    if (tbody) tbody.innerHTML = '<tr><td colspan="6" class="empty-state">Loading...</td></tr>';
    try {
      const data = await api('GET', '/calls?limit=200&has_recording=true');
      render(data.calls || []);
    } catch (err) { toast(`Transcription error: ${err.message}`, 'danger'); }
  }

  function render(rows) {
    const tbody = el('transcription-tbody');
    if (!tbody) return;
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="empty-state">No calls with recordings found</td></tr>';
      return;
    }
    tbody.innerHTML = rows.map((r) => {
      const date = new Date(r.call_start || r.started_at || r.created_at).toLocaleString();
      const secs = r.duration_seconds || r.duration || 0;
      const dur = secs ? `${Math.floor(secs / 60)}m ${secs % 60}s` : '—';
      const hasTranscript = !!r.recording_transcript;
      const statusHtml = hasTranscript
        ? `<span style="color:#27ae60">&#10003; Done</span> <button class="btn btn-sm btn-secondary" style="margin-left:4px" onclick="TranscriptionPanel.showDetail('${r.id}')">View</button>`
        : `<span style="color:#999">Pending</span>`;
      return `<tr>
        <td>${date}</td>
        <td>${escHtml(r.client_name || '—')}</td>
        <td>${escHtml(r.caller_id_num || r.caller_number || '—')}</td>
        <td>${dur}</td>
        <td>${statusHtml}</td>
        <td>${!hasTranscript ? `<button class="btn btn-sm btn-primary" onclick="TranscriptionPanel.transcribe('${r.id}', this)">Transcribe</button>` : ''}</td>
      </tr>`;
    }).join('');
  }

  async function transcribe(callLogId, btn) {
    if (btn) { btn.disabled = true; btn.textContent = '...'; }
    try {
      const r = await api('POST', `/transcription/call/${callLogId}`);
      toast(r.status === 'already_transcribed' ? 'Already transcribed' : 'Transcription complete', 'success');
      load();
    } catch (err) {
      toast(`Transcription failed: ${err.message}`, 'danger');
      if (btn) { btn.disabled = false; btn.textContent = 'Transcribe'; }
    }
  }

  async function batchTranscribe() {
    try {
      const r = await api('POST', '/transcription/batch', { limit: 10 });
      toast(`Batch transcription: ${r.transcribed} call(s) processed`, 'success');
      load();
    } catch (err) { toast(`Batch error: ${err.message}`, 'danger'); }
  }

  async function showDetail(callLogId) {
    try {
      const r = await api('GET', `/transcription/call/${callLogId}`);
      const detailEl = el('transcription-detail');
      if (!detailEl) return;
      el('transcription-detail-title').textContent = `Transcript — ${new Date(r.transcribed_at || Date.now()).toLocaleString()}`;
      el('transcription-text').textContent = r.recording_transcript || '(empty)';
      const summaryEl = el('transcription-summary');
      if (summaryEl) summaryEl.textContent = r.transcript_summary ? `Summary: ${r.transcript_summary}` : '';
      detailEl.style.display = 'block';
      detailEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (err) { toast(`Error: ${err.message}`, 'danger'); }
  }

  function closeDetail() {
    const d = el('transcription-detail');
    if (d) d.style.display = 'none';
  }

  return { load, transcribe, batchTranscribe, showDetail, closeDetail };
})();

/* ============================================================
   QAPanel — QA Score History Admin
   ============================================================ */
const QAPanel = (() => {
  const api = (...a) => App._api(...a);
  const toast = (...a) => App._toast(...a);
  const escHtml = (...a) => App._escHtml(...a);
  const el = (id) => document.getElementById(id);

  async function load() {
    if (!el('admin-qa')) return;
    const tbody = el('qa-scores-tbody');
    if (tbody) tbody.innerHTML = '<tr><td colspan="12" class="empty-state">Loading...</td></tr>';
    const from = el('qa-from')?.value || '';
    const to   = el('qa-to')?.value   || '';
    const qs   = new URLSearchParams({ limit: 100 });
    if (from) qs.set('date_from', from);
    if (to)   qs.set('date_to',   to);
    try {
      const data = await api('GET', `/qa/scores?${qs}`);
      renderSummary(data.scores || []);
      render(data.scores || [], data.total || 0);
    } catch (err) { toast(`QA error: ${err.message}`, 'danger'); }
  }

  function renderSummary(rows) {
    const el_ = el('qa-summary');
    if (!el_) return;
    if (!rows.length) { el_.innerHTML = ''; return; }
    const avg = (rows.reduce((s, r) => s + (r.overall || 0), 0) / rows.length).toFixed(1);
    const perfect = rows.filter((r) => r.overall >= 9).length;
    const below7  = rows.filter((r) => r.overall < 7).length;
    el_.innerHTML = `
      <div style="background:var(--bg-secondary);border:1px solid var(--border);border-radius:6px;padding:10px 16px;text-align:center">
        <div style="font-size:1.5rem;font-weight:700">${avg}</div>
        <div style="font-size:0.75rem;color:var(--text-muted)">Avg Overall</div>
      </div>
      <div style="background:var(--bg-secondary);border:1px solid var(--border);border-radius:6px;padding:10px 16px;text-align:center">
        <div style="font-size:1.5rem;font-weight:700;color:#27ae60">${perfect}</div>
        <div style="font-size:0.75rem;color:var(--text-muted)">Score ≥ 9</div>
      </div>
      <div style="background:var(--bg-secondary);border:1px solid var(--border);border-radius:6px;padding:10px 16px;text-align:center">
        <div style="font-size:1.5rem;font-weight:700;color:#e74c3c">${below7}</div>
        <div style="font-size:0.75rem;color:var(--text-muted)">Score &lt; 7</div>
      </div>
      <div style="background:var(--bg-secondary);border:1px solid var(--border);border-radius:6px;padding:10px 16px;text-align:center">
        <div style="font-size:1.5rem;font-weight:700">${rows.length}</div>
        <div style="font-size:0.75rem;color:var(--text-muted)">Total Scored</div>
      </div>`;
  }

  function tick(val) { return val ? '&#10003;' : '&#10007;'; }

  function render(rows, total) {
    const tbody = el('qa-scores-tbody');
    if (!tbody) return;
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="12" class="empty-state">No QA scores found</td></tr>';
      return;
    }
    tbody.innerHTML = rows.map((r) => {
      const date = new Date(r.call_start || r.created_at).toLocaleString();
      const scoreColour = r.overall >= 9 ? '#27ae60' : r.overall < 7 ? '#e74c3c' : 'inherit';
      return `<tr>
        <td>${date}</td>
        <td>${escHtml(r.client_name || '—')}</td>
        <td>${escHtml(r.caller_id_num || '—')}</td>
        <td>${escHtml(r.operator_name || '—')}</td>
        <td style="font-weight:700;color:${scoreColour}">${r.overall}/10</td>
        <td style="text-align:center">${tick(r.greeting_correct)}</td>
        <td style="text-align:center">${tick(r.script_followed)}</td>
        <td style="text-align:center">${tick(r.info_accurate)}</td>
        <td style="text-align:center">${tick(r.professional_tone)}</td>
        <td style="text-align:center">${tick(r.message_complete)}</td>
        <td>${escHtml(r.scored_by_name || '—')}</td>
        <td style="max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escHtml(r.notes || '')}">${escHtml(r.notes || '—')}</td>
      </tr>`;
    }).join('');
  }

  return { load };
})();

/* ============================================================
   WhatsApp Inbox Panel
   ============================================================ */
const WAInbox = (() => {
  const api = (...a) => App._api(...a);
  const toast = (...a) => App._toast(...a);
  const el = (id) => document.getElementById(id);
  const escHtml = (...a) => App._escHtml(...a);
  let activeThread = null;

  async function load() {
    if (!el('admin-whatsapp')) return;
    loadThreads();
  }

  async function loadThreads() {
    const list = el('wa-thread-list');
    if (!list) return;
    list.innerHTML = '<p style="color:#666;padding:8px">Loading...</p>';
    try {
      const data = await api('GET', '/whatsapp/threads');
      const threads = data?.threads || [];
      if (!threads.length) { list.innerHTML = '<p style="color:#888;padding:8px">No WhatsApp threads</p>'; return; }
      list.innerHTML = threads.map((t) => `
        <div class="sms-thread-item ${t.unread > 0 ? 'unread' : ''}"
             onclick="WAInbox.openThread('${escHtml(t.from_number)}','${escHtml(t.client_name || '')}')"
             style="padding:8px 12px;border-bottom:1px solid #eee;cursor:pointer">
          <strong>${escHtml(t.from_number)}</strong>
          ${t.unread > 0 ? `<span style="background:#25d366;color:#fff;border-radius:999px;padding:1px 6px;font-size:0.75em;margin-left:4px">${t.unread}</span>` : ''}
          <span style="color:#888;font-size:0.85em;float:right">${escHtml(t.client_name || '')}</span>
          <div style="color:#666;font-size:0.85em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escHtml(t.last_body || '')}</div>
        </div>`).join('');
    } catch (err) { toast(`WhatsApp error: ${err.message}`, 'danger'); }
  }

  async function openThread(number, clientName) {
    activeThread = number;
    el('wa-thread-title') && (el('wa-thread-title').textContent = `${number}${clientName ? ` — ${clientName}` : ''}`);
    const msgs = el('wa-messages');
    if (msgs) msgs.innerHTML = '<p style="color:#666">Loading...</p>';
    try {
      const data = await api('GET', `/whatsapp/thread/${encodeURIComponent(number)}`);
      const messages = data?.messages || [];
      if (msgs) {
        if (!messages.length) { msgs.innerHTML = '<p style="color:#888">No messages</p>'; return; }
        msgs.innerHTML = messages.map((m) => `
          <div style="display:flex;flex-direction:${m.direction === 'outbound' ? 'row-reverse' : 'row'};margin:4px 0">
            <div style="max-width:70%;padding:8px 12px;border-radius:12px;
                        background:${m.direction === 'outbound' ? '#25d366' : '#f0f0f0'};
                        color:${m.direction === 'outbound' ? '#fff' : '#333'}">
              ${escHtml(m.body)}
              <div style="font-size:0.75em;opacity:0.7;margin-top:2px">${new Date(m.created_at).toLocaleString()}</div>
            </div>
          </div>`).join('');
        msgs.scrollTop = msgs.scrollHeight;
      }
    } catch (err) { toast(`Error loading thread: ${err.message}`, 'danger'); }
    loadThreads();
  }

  async function sendReply() {
    if (!activeThread) return;
    const input = el('wa-reply-input');
    const body  = input?.value?.trim();
    if (!body) return;
    try {
      await api('POST', '/whatsapp/send', { to: activeThread, body });
      input.value = '';
      openThread(activeThread, '');
      toast('WhatsApp message sent', 'success');
    } catch (err) { toast(`Send failed: ${err.message}`, 'danger'); }
  }

  async function openCompose() {
    const to   = prompt('WhatsApp number (e.g. +447700900000):');
    if (!to) return;
    const body = prompt('Message:');
    if (!body) return;
    try {
      await api('POST', '/whatsapp/send', { to, body });
      toast('WhatsApp message sent', 'success');
      loadThreads();
    } catch (err) { toast(`Send failed: ${err.message}`, 'danger'); }
  }

  return { load, openThread, sendReply, loadThreads, openCompose };
})();

/* ============================================================
   CsatPanel — Customer Satisfaction survey results
   ============================================================ */
const CsatPanel = (() => {
  const api = (...a) => App._api(...a);
  const el = (id) => document.getElementById(id);
  const escHtml = (...a) => App._escHtml(...a);

  function stars(n) {
    if (!n) return '<span style="color:var(--text-muted)">—</span>';
    return '&#11088;'.repeat(n) + '&#9734;'.repeat(5 - n);
  }

  async function load() {
    const clientSel = el('csat-filter-client');
    if (clientSel && clientSel.options.length <= 1) {
      try {
        const { clients } = await api('GET', '/clients');
        clients.forEach((c) => {
          const o = document.createElement('option');
          o.value = c.id; o.textContent = c.name;
          clientSel.appendChild(o);
        });
      } catch (_) {}
    }

    const clientId = clientSel?.value || '';
    const qs = clientId ? `?client_id=${clientId}` : '';

    try {
      const { responses, stats } = await api('GET', `/csat/responses${qs}`);
      el('csat-avg').textContent = stats.avg_rating ?? '—';
      el('csat-responded').textContent = stats.responded ?? '0';
      el('csat-total').textContent = stats.total ?? '0';

      const tbody = el('csat-tbody');
      if (!responses.length) {
        tbody.innerHTML = '<tr><td colspan="6" class="empty-state">No CSAT responses yet</td></tr>';
        return;
      }
      tbody.innerHTML = responses.map((r) => `
        <tr>
          <td>${escHtml(r.client_name || '—')}</td>
          <td>${escHtml(r.caller_id_name || r.phone)}</td>
          <td>${new Date(r.sent_at).toLocaleString()}</td>
          <td>${r.responded_at ? new Date(r.responded_at).toLocaleString() : '<em>Pending</em>'}</td>
          <td>${stars(r.rating)}</td>
          <td>${escHtml(r.comment || '—')}</td>
        </tr>
      `).join('');
    } catch (err) {
      el('csat-tbody').innerHTML = `<tr><td colspan="6" class="empty-state">${escHtml(err.message)}</td></tr>`;
    }
  }

  return { load };
})();

/* ============================================================
   SchedulesPanel — scheduled report email management
   ============================================================ */
const SchedulesPanel = (() => {
  const api = (...a) => App._api(...a);
  const toast = (...a) => App._toast(...a);
  const el = (id) => document.getElementById(id);
  const escHtml = (...a) => App._escHtml(...a);

  async function load() {
    // Populate client dropdown in the form
    const sfClient = el('sf-client');
    if (sfClient && sfClient.options.length <= 1) {
      try {
        const { clients } = await api('GET', '/clients');
        clients.forEach((c) => {
          const o = document.createElement('option');
          o.value = c.id; o.textContent = c.name;
          sfClient.appendChild(o);
        });
      } catch (_) {}
    }

    try {
      const { schedules } = await api('GET', '/reports/schedules');
      const tbody = el('schedules-tbody');
      if (!schedules.length) {
        tbody.innerHTML = '<tr><td colspan="8" class="empty-state">No scheduled reports configured</td></tr>';
        return;
      }
      tbody.innerHTML = schedules.map((s) => `
        <tr>
          <td><strong>${escHtml(s.report_type)}</strong></td>
          <td>${escHtml(s.frequency)}</td>
          <td style="font-size:0.8rem">${escHtml((s.recipients || []).join(', '))}</td>
          <td>${escHtml(s.client_name || 'All')}</td>
          <td>${s.last_sent_at ? new Date(s.last_sent_at).toLocaleString() : '—'}</td>
          <td>${new Date(s.next_run_at).toLocaleString()}</td>
          <td><label class="toggle-switch" style="display:inline-flex">
            <input type="checkbox" ${s.is_active ? 'checked' : ''} onchange="SchedulesPanel.toggleActive('${s.id}', this.checked)">
            <span class="toggle-slider"></span>
          </label></td>
          <td><button class="btn btn-danger btn-sm" onclick="SchedulesPanel.del('${s.id}')">Delete</button></td>
        </tr>
      `).join('');
    } catch (err) {
      el('schedules-tbody').innerHTML = `<tr><td colspan="8" class="empty-state">${escHtml(err.message)}</td></tr>`;
    }
  }

  function openNew() { el('schedule-form').style.display = 'block'; }
  function closeNew() { el('schedule-form').style.display = 'none'; }

  async function save() {
    const type = el('sf-type').value;
    const freq = el('sf-freq').value;
    const clientId = el('sf-client').value;
    const raw = el('sf-recipients').value;
    const recipients = raw.split(',').map((s) => s.trim()).filter(Boolean);
    if (!recipients.length) return toast('Enter at least one recipient email', 'error');
    try {
      await api('POST', '/reports/schedules', { report_type: type, frequency: freq, recipients, client_id: clientId || undefined });
      toast('Schedule created');
      closeNew();
      load();
    } catch (err) { toast(err.message, 'error'); }
  }

  async function toggleActive(id, active) {
    try {
      await api('PATCH', `/reports/schedules/${id}`, { is_active: active });
      toast(active ? 'Schedule enabled' : 'Schedule paused');
    } catch (err) { toast(err.message, 'error'); }
  }

  async function del(id) {
    if (!confirm('Delete this schedule?')) return;
    try {
      await api('DELETE', `/reports/schedules/${id}`);
      toast('Schedule deleted');
      load();
    } catch (err) { toast(err.message, 'error'); }
  }

  return { load, openNew, closeNew, save, toggleActive, del };
})();
