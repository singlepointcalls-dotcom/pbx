'use strict';

/**
 * CRM integration service.
 * Pushes messages into client-configured CRM systems.
 *
 * Supported: salesforce | hubspot | zoho | pipedrive | custom_webhook
 *
 * Per-client config stored in clients.crm_type + clients.crm_config (JSONB).
 * Secrets in crm_config are never returned to the client in GET responses.
 *
 * crm_config shapes:
 *   salesforce:  { instance_url, client_id, client_secret, subject_prefix? }
 *   hubspot:     { access_token, pipeline_id?, deal_stage? }
 *   zoho:        { client_id, client_secret, refresh_token, org_id? }
 *   pipedrive:   { api_token, pipeline_id? }
 *   custom_webhook: { url, secret?, headers? }
 */

const axios = require('axios');

// Per-client OAuth2 token cache
const crmTokenCache = new Map();

// ── Salesforce ─────────────────────────────────────────────────────────────
async function getSalesforceToken(cfg, clientId) {
  const cached = crmTokenCache.get(`sf:${clientId}`);
  if (cached && cached.expiresAt > Date.now() + 30000) return cached;

  const resp = await axios.post(
    `${cfg.instance_url}/services/oauth2/token`,
    new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: cfg.client_id,
      client_secret: cfg.client_secret,
    }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 }
  );

  const entry = {
    token: resp.data.access_token,
    instanceUrl: resp.data.instance_url || cfg.instance_url,
    expiresAt: Date.now() + (resp.data.expires_in || 3600) * 1000,
  };
  crmTokenCache.set(`sf:${clientId}`, entry);
  return entry;
}

async function pushToSalesforce(message, client, cfg) {
  const { token, instanceUrl } = await getSalesforceToken(cfg, client.id);
  const subject = `${cfg.subject_prefix || ''}${message.subject || 'Phone message'}: ${message.caller_name || message.caller_phone || 'Unknown'}`;
  const description = [
    `Caller: ${message.caller_name || 'Unknown'} ${message.caller_phone || ''}`,
    `Urgency: ${(message.urgency || 'normal').toUpperCase()}`,
    `Taken by: ${message.operator_name || 'Operator'}`,
    '',
    message.body,
  ].join('\n');

  const resp = await axios.post(
    `${instanceUrl}/services/data/v59.0/sobjects/Case`,
    { Subject: subject, Description: description, Status: 'New', Origin: 'Phone' },
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 15000 }
  );
  return { crm: 'salesforce', id: resp.data.id };
}

// ── HubSpot ────────────────────────────────────────────────────────────────
async function pushToHubSpot(message, cfg) {
  const note = [
    `📞 Phone message for ${message.client_name}`,
    `From: ${message.caller_name || 'Unknown'} ${message.caller_phone || ''}`,
    `Priority: ${(message.urgency || 'normal').toUpperCase()}`,
    `\n${message.body}`,
  ].join('\n');

  const resp = await axios.post(
    'https://api.hubapi.com/crm/v3/objects/notes',
    {
      properties: {
        hs_note_body: note,
        hs_timestamp: Date.now().toString(),
      },
    },
    {
      headers: {
        Authorization: `Bearer ${cfg.access_token}`,
        'Content-Type': 'application/json',
      },
      timeout: 15000,
    }
  );
  return { crm: 'hubspot', id: resp.data.id };
}

// ── Zoho CRM ───────────────────────────────────────────────────────────────
async function getZohoToken(cfg, clientId) {
  const cached = crmTokenCache.get(`zoho:${clientId}`);
  if (cached && cached.expiresAt > Date.now() + 30000) return cached.token;

  const resp = await axios.post(
    'https://accounts.zoho.com/oauth/v2/token',
    new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: cfg.client_id,
      client_secret: cfg.client_secret,
      refresh_token: cfg.refresh_token,
    }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 }
  );

  const token = resp.data.access_token;
  crmTokenCache.set(`zoho:${clientId}`, { token, expiresAt: Date.now() + 3500000 });
  return token;
}

async function pushToZoho(message, client, cfg) {
  const token = await getZohoToken(cfg, client.id);
  const apiDomain = cfg.api_domain || 'https://www.zohoapis.com';

  const resp = await axios.post(
    `${apiDomain}/crm/v3/Cases`,
    {
      data: [{
        Subject: `Phone message: ${message.caller_name || message.caller_phone || 'Unknown'}`,
        Description: message.body,
        Status: 'Open',
        Priority: message.urgency === 'high' ? 'High' : 'Normal',
        Phone: message.caller_phone || null,
      }],
    },
    { headers: { Authorization: `Zoho-oauthtoken ${token}`, 'Content-Type': 'application/json' }, timeout: 15000 }
  );
  return { crm: 'zoho', id: resp.data?.data?.[0]?.details?.id };
}

// ── Pipedrive ──────────────────────────────────────────────────────────────
async function pushToPipedrive(message, cfg) {
  const note = `📞 Phone message for ${message.client_name}\nFrom: ${message.caller_name || 'Unknown'} ${message.caller_phone || ''}\nPriority: ${(message.urgency || 'normal').toUpperCase()}\n\n${message.body}`;

  const resp = await axios.post(
    `https://api.pipedrive.com/v1/notes?api_token=${cfg.api_token}`,
    { content: note, pinned_to_deal_flag: 0 },
    { headers: { 'Content-Type': 'application/json' }, timeout: 15000 }
  );
  return { crm: 'pipedrive', id: resp.data?.data?.id };
}

// ── Custom webhook ─────────────────────────────────────────────────────────
async function pushToCustomWebhook(message, cfg) {
  const crypto = require('crypto');
  const payload = {
    event: 'message.created',
    source: 'answering_service',
    message: {
      id: message.id,
      client_name: message.client_name,
      caller_name: message.caller_name,
      caller_phone: message.caller_phone,
      subject: message.subject,
      body: message.body,
      urgency: message.urgency,
      created_at: message.created_at,
    },
  };

  const headers = { 'Content-Type': 'application/json', ...(cfg.headers || {}) };
  if (cfg.secret) {
    headers['X-CRM-Signature'] = 'sha256=' +
      crypto.createHmac('sha256', cfg.secret).update(JSON.stringify(payload)).digest('hex');
  }

  await axios.post(cfg.url, payload, { headers, timeout: 10000 });
  return { crm: 'custom_webhook' };
}

// ── Main dispatcher ────────────────────────────────────────────────────────
async function pushMessageToCrm(message, client) {
  if (!client.crm_type || !client.crm_config) return null;
  const cfg = client.crm_config;

  switch (client.crm_type) {
    case 'salesforce':     return pushToSalesforce(message, client, cfg);
    case 'hubspot':        return pushToHubSpot(message, cfg);
    case 'zoho':           return pushToZoho(message, client, cfg);
    case 'pipedrive':      return pushToPipedrive(message, cfg);
    case 'custom_webhook': return pushToCustomWebhook(message, cfg);
    default:
      throw new Error(`Unknown CRM type: ${client.crm_type}`);
  }
}

module.exports = { pushMessageToCrm };
