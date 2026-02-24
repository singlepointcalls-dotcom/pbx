/* ============================================================
   Answering Service — Operator Console Application
   ============================================================ */

'use strict';

const App = (() => {

  /* ---- State ---- */
  let token = localStorage.getItem('as_token');
  let currentOperator = null;
  let socket = null;
  let clients = [];

  // Active call state
  let activeCall = null;
  let activeCallStart = null;
  let timerInterval = null;

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

      if (!data.token) throw new Error(data.error || 'Login failed');

      token = data.token;
      currentOperator = data.operator;
      localStorage.setItem('as_token', token);
      showConsole();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.classList.remove('hidden');
    }
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
    connectSocket();
    loadClients();
    loadMessages();
  }

  /* ---- Socket.io ---- */
  function connectSocket() {
    if (socket) socket.disconnect();

    socket = io({ auth: { token } });

    socket.on('connect', () => {
      console.log('Socket connected');
      toast('Connected to live call stream', 'success', 2000);
    });

    socket.on('disconnect', () => {
      toast('Disconnected — reconnecting...', 'warning');
    });

    socket.on('call:ringing', handleCallRinging);
    socket.on('call:answered', handleCallAnswered);
    socket.on('call:ended', handleCallEnded);
    socket.on('call:transferred', (data) => {
      if (activeCall?.channelId === data.channelId) clearActiveCall();
      toast(`Call transferred`, 'info');
    });
    socket.on('operators:list', (data) => renderOperators(data.operators));
    socket.on('message:new', () => loadMessages());
  }

  /* ---- Call Queue ---- */
  const callQueue = new Map(); // channelId -> call data

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
    // If WE answered it — show active call panel
    if (activeCall?.channelId === data.channelId) {
      el('status-badge').className = 'status-badge busy';
      el('status-badge').textContent = 'ON CALL';
      socket.emit('operator:busy');
    } else if (callQueue.size === 0) {
      el('status-badge').className = 'status-badge ready';
      el('status-badge').textContent = 'READY';
    }
  }

  function handleCallEnded(data) {
    callQueue.delete(data.channelId);
    renderCallQueue();

    if (activeCall?.channelId === data.channelId) {
      clearActiveCall();
      toast('Call ended', 'info');
    }

    if (callQueue.size === 0) {
      el('status-badge').className = 'status-badge ready';
      el('status-badge').textContent = 'READY';
      socket.emit('operator:ready');
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
      const item = document.createElement('div');
      item.className = 'call-item ringing';
      item.innerHTML = `
        <div class="call-item-caller">${escHtml(call.callerIdName || call.callerIdNum)}</div>
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
      })
      .catch((err) => toast(`Failed to answer: ${err.message}`, 'danger'));
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
    if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
    el('active-call-panel').style.display = 'none';
    el('call-timer').textContent = '0:00';
    el('status-badge').className = 'status-badge ready';
    el('status-badge').textContent = 'READY';
    el('script-panel').style.display = 'none';
    if (socket) socket.emit('operator:ready');
  }

  function hangup() {
    if (!activeCall) return;
    api('POST', `/callcontrol/${activeCall.channelId}/hangup`, {})
      .catch((err) => toast(`Hangup failed: ${err.message}`, 'danger'));
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
    el('client-greeting').textContent = call.client.greeting || '';
    el('client-script').textContent = call.client.script || 'No script configured for this client.';
  }

  function prefillMessageForm(call) {
    if (call.client) {
      el('msg-client').value = call.client.id;
    }
    el('msg-caller-phone').value = call.callerIdNum || '';
    el('msg-caller-name').value = call.callerIdName || '';
  }

  /* ---- Clients ---- */
  async function loadClients() {
    try {
      const data = await api('GET', '/clients?active=true');
      if (!data) return;
      clients = data.clients;

      // Populate client selects
      const options = clients.map((c) => `<option value="${c.id}">${escHtml(c.name)}</option>`).join('');
      el('msg-client').innerHTML = '<option value="">— Select Client —</option>' + options;
      el('msg-filter-client').innerHTML = '<option value="">All Clients</option>' + options;
    } catch (err) {
      console.error('loadClients error:', err.message);
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
      <div class="message-item" onclick="App.showMessageDetail('${m.id}')">
        <div class="message-item-client">${escHtml(m.client_name || '—')}</div>
        <div class="message-item-caller">${escHtml(m.caller_name || m.caller_phone || 'Unknown')}</div>
        <div class="message-item-preview">${escHtml(m.body)}</div>
        <div class="message-item-meta">
          <span class="message-item-time">${relTime(m.created_at)}</span>
          <span class="message-item-status status-${m.status}">${m.status}</span>
        </div>
      </div>
    `).join('');
  }

  async function showMessageDetail(messageId) {
    try {
      const data = await api('GET', `/messages/${messageId}`);
      if (!data) return;
      const m = data.message;
      const detail = [
        `Client: ${m.client_name}`,
        `Caller: ${m.caller_name || '—'} ${m.caller_phone ? `(${m.caller_phone})` : ''}${m.caller_company ? ` — ${m.caller_company}` : ''}`,
        `Urgency: ${m.urgency.toUpperCase()}`,
        `Status: ${m.status}`,
        '',
        m.subject ? `Subject: ${m.subject}` : '',
        '',
        m.body,
      ].filter((l) => l !== undefined).join('\n');

      const action = confirm(`${detail}\n\nClick OK to redeliver, Cancel to dismiss.`);
      if (action) {
        await api('POST', `/messages/${messageId}/deliver`, {});
        toast('Message delivered', 'success');
        loadMessages();
      }
    } catch (err) {
      toast(`Error: ${err.message}`, 'danger');
    }
  }

  async function submitMessage(andDeliver = true) {
    const feedback = el('msg-feedback');
    feedback.className = 'feedback hidden';

    const clientId = el('msg-client').value;
    const body = el('msg-body').value.trim();
    if (!clientId || !body) return;

    const payload = {
      client_id: clientId,
      call_log_id: activeCall?.callLogId || null,
      caller_name: el('msg-caller-name').value.trim() || null,
      caller_phone: el('msg-caller-phone').value.trim() || null,
      caller_company: el('msg-caller-company').value.trim() || null,
      subject: el('msg-subject').value.trim() || null,
      body,
      urgency: el('msg-urgency').value,
      auto_deliver: andDeliver,
    };

    try {
      el('msg-submit').disabled = true;
      await api('POST', '/messages', payload);
      feedback.className = 'feedback success';
      feedback.textContent = andDeliver ? 'Message saved and delivered.' : 'Message saved.';
      clearMessageForm();
      loadMessages();
    } catch (err) {
      feedback.className = 'feedback error';
      feedback.textContent = `Error: ${err.message}`;
    } finally {
      el('msg-submit').disabled = false;
    }
  }

  function saveMessageOnly() {
    submitMessage(false);
  }

  function clearMessageForm() {
    el('msg-client').value = '';
    el('msg-caller-name').value = '';
    el('msg-caller-phone').value = '';
    el('msg-caller-company').value = '';
    el('msg-subject').value = '';
    el('msg-body').value = '';
    el('msg-urgency').value = 'normal';
    el('msg-feedback').className = 'feedback hidden';
  }

  /* ---- Operators ---- */
  function renderOperators(operators) {
    const container = el('operators-list');
    if (!operators.length) {
      container.innerHTML = '<p class="empty-state">No operators online</p>';
      return;
    }
    container.innerHTML = operators.map((op) => `
      <div class="operator-item">
        <span class="op-dot ${op.status}"></span>
        <span>${escHtml(op.username)}</span>
      </div>
    `).join('');
  }

  /* ---- Utilities ---- */
  function escHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function formatTime(date) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function relTime(isoStr) {
    if (!isoStr) return '';
    const diff = (Date.now() - new Date(isoStr).getTime()) / 1000;
    if (diff < 60) return 'just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return new Date(isoStr).toLocaleDateString();
  }

  /* ---- Bootstrap ---- */
  document.addEventListener('DOMContentLoaded', init);

  /* ---- Public interface ---- */
  return {
    logout,
    pickupCall,
    hangup,
    showTransfer,
    transfer,
    viewScript,
    clearMessageForm,
    saveMessageOnly,
    loadMessages,
    showMessageDetail,
  };

})();
