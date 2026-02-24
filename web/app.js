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

    // Show admin tab for admins and supervisors
    if (currentOperator.role === 'admin' || currentOperator.role === 'supervisor') {
      el('admin-tab').style.display = '';
    }

    connectSocket();
    loadClients();
    loadMessages();
  }

  function switchView(view) {
    document.querySelectorAll('.nav-tab').forEach((t) => t.classList.remove('active'));
    if (view === 'console') {
      el('view-console').style.display = '';
      el('view-admin').style.display = 'none';
      document.querySelectorAll('.nav-tab')[0].classList.add('active');
    } else {
      el('view-console').style.display = 'none';
      el('view-admin').style.display = 'flex';
      el('admin-tab').classList.add('active');
      Admin.init();
    }
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
    switchView,
    // expose api helper for Admin module
    _api: api,
    _toast: toast,
    _escHtml: escHtml,
  };

})();

/* ============================================================
   Admin Module — Client, Contact, and Operator Management
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

  /* ---- Init ---- */
  async function init() {
    if (!initialized) {
      initialized = true;
    }
    showSection('clients');
  }

  function showSection(name, evt) {
    document.querySelectorAll('.admin-section').forEach((s) => s.style.display = 'none');
    document.querySelectorAll('.admin-nav-item').forEach((b) => b.classList.remove('active'));
    el(`admin-${name}`).style.display = 'block';
    if (evt && evt.target) evt.target.classList.add('active');

    if (name === 'clients') loadClients();
    else if (name === 'operators') loadOperators();
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
    el('cf-account').disabled = !!clientId; // account number is immutable after creation

    // Reset form
    el('client-form').reset();
    el('cf-active').checked = true;
    el('contacts-section').style.display = 'none';

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
        el('contacts-section').style.display = 'block';
        loadContacts(clientId);
      } catch (err) {
        toast(`Failed to load client: ${err.message}`, 'danger');
        return;
      }
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

      const body = {
        name: el('cf-name').value.trim(),
        dids,
        timezone: el('cf-timezone').value,
        is_active: el('cf-active').checked,
        greeting: el('cf-greeting').value.trim() || null,
        script: el('cf-script').value.trim() || null,
        notes: el('cf-notes').value.trim() || null,
      };

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
    tbody.innerHTML = contacts.map((c) => `
      <tr>
        <td>${escHtml(c.name)}</td>
        <td>${escHtml(c.title || '—')}</td>
        <td>${escHtml(c.phone || '—')}</td>
        <td>${escHtml(c.email || '—')}</td>
        <td>${c.notify_email ? '&#10003;' : ''}</td>
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

    if (contactId && editingClientId) {
      try {
        const data = await api('GET', `/clients/${editingClientId}/contacts`);
        const contact = data.contacts.find((c) => c.id === contactId);
        if (contact) {
          el('ctf-name').value = contact.name || '';
          el('ctf-title').value = contact.title || '';
          el('ctf-phone').value = contact.phone || '';
          el('ctf-email').value = contact.email || '';
          el('ctf-priority').value = contact.priority || 1;
          el('ctf-notify-email').checked = !!contact.notify_email;
        }
      } catch (err) {
        toast(`Failed to load contact: ${err.message}`, 'danger');
      }
    }

    el('contact-modal').style.display = 'flex';
  }

  function closeContactModal() {
    el('contact-modal').style.display = 'none';
    editingContactId = null;
  }

  async function saveContact() {
    if (!editingClientId) return;
    const body = {
      name: el('ctf-name').value.trim(),
      title: el('ctf-title').value.trim() || null,
      phone: el('ctf-phone').value.trim() || null,
      email: el('ctf-email').value.trim() || null,
      priority: parseInt(el('ctf-priority').value) || 1,
      notify_email: el('ctf-notify-email').checked,
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

  /* ---- Public ---- */
  return {
    init, showSection,
    searchClients,
    openClientModal, closeClientModal, saveClient, toggleClient,
    openContactModal, closeContactModal, saveContact, deleteContact,
    openOperatorModal, closeOperatorModal, saveOperator, toggleOperator,
  };

})();
