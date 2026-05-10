'use strict';

/**
 * Asterisk ARI (REST Interface) Integration
 *
 * Connects to Asterisk via the ARI WebSocket to receive real-time call events.
 * When a call enters the Stasis app (answering-service), we:
 *   1. Look up the client by DID
 *   2. Log the call
 *   3. Emit the call event to the operator console via Socket.io
 *   4. Answer the call and bridge to the operator who picks it up
 */

const ari = require('ari-client');
const pool = require('../config/database');
const { broadcast } = require('../services/realtime');
const { transcribeCall } = require('../services/transcription');
const { sendCsatSurvey } = require('../api/routes/csat');

let ariClient = null;

// Active calls: channelId -> { channel, callLogId, clientId, ... }
const activeCalls = new Map();

// Exponential backoff reconnect: 5s → 10s → 20s → 40s → 60s cap
const ARI_RECONNECT_DELAYS = [5000, 10000, 20000, 40000, 60000];
let _reconnectAttempt = 0;
let _reconnectTimer = null;

function _scheduleReconnect() {
  if (_reconnectTimer) return;
  const delay = ARI_RECONNECT_DELAYS[Math.min(_reconnectAttempt, ARI_RECONNECT_DELAYS.length - 1)];
  _reconnectAttempt++;
  console.log(`[ARI] Reconnecting in ${delay / 1000}s (attempt ${_reconnectAttempt})...`);
  _reconnectTimer = setTimeout(async () => {
    _reconnectTimer = null;
    try {
      await connectARI();
      _reconnectAttempt = 0;
      console.log('[ARI] Reconnected successfully.');
    } catch (err) {
      console.warn('[ARI] Reconnect failed:', err.message);
      _scheduleReconnect();
    }
  }, delay);
}

async function connectARI() {
  const host = process.env.ARI_HOST || 'localhost';
  const port = process.env.ARI_PORT || '8088';
  const user = process.env.ARI_USER || 'asterisk';
  const password = process.env.ARI_PASSWORD || '';
  const appName = process.env.ARI_APP || 'answering-service';

  const url = `http://${host}:${port}`;
  console.log(`Connecting to Asterisk ARI at ${url} as app="${appName}"...`);

  ariClient = await ari.connect(url, user, password);
  ariClient.on('StasisStart', handleStasisStart);
  ariClient.on('StasisEnd', handleStasisEnd);
  ariClient.on('ChannelHangupRequest', handleHangupRequest);

  ariClient.start(appName);
  console.log(`ARI connected. Listening for Stasis app: ${appName}`);

  ariClient.on('WebsocketReconnecting', () => console.log('[ARI] WebSocket reconnecting...'));
  ariClient.on('WebsocketMaxRetries', () => {
    console.error('[ARI] WebSocket max retries reached — scheduling reconnect');
    ariClient = null;
    _scheduleReconnect();
  });

  return ariClient;
}

async function handleStasisStart(event, channel) {
  // Skip channels originated for operator legs — identified by the first Stasis app arg
  const args = event.args || [];
  if (args[0] === 'operator') {
    console.log(`[ARI] StasisStart: skipping operator leg channel=${channel.id}`);
    return;
  }

  const channelId = channel.id;
  const callerIdNum = channel.caller.number || 'Unknown';
  const callerIdName = channel.caller.name || '';
  const did = channel.dialplan.exten || '';

  console.log(`[ARI] StasisStart: channel=${channelId} from=${callerIdNum} DID=${did}`);

  // Look up client by DID
  let client = null;
  try {
    const result = await pool.query(
      'SELECT * FROM clients WHERE $1 = ANY(dids) AND is_active = true',
      [did]
    );
    client = result.rows[0] || null;
  } catch (err) {
    console.error('[ARI] DB lookup failed:', err.message);
  }

  // DNC check — if caller is on the Do-Not-Call list for this client, reject immediately
  if (client && callerIdNum && callerIdNum !== 'Unknown') {
    try {
      const dncResult = await pool.query(
        `SELECT id FROM dnc_numbers
         WHERE phone = $1 AND (client_id = $2 OR client_id IS NULL)
           AND (expires_at IS NULL OR expires_at > NOW())
         LIMIT 1`,
        [callerIdNum, client.id]
      );
      if (dncResult.rows.length > 0) {
        console.log(`[ARI] DNC: rejecting channel=${channelId} caller=${callerIdNum}`);
        await pool.query(
          `INSERT INTO call_logs (asterisk_channel_id, client_id, caller_id_num, caller_id_name, did, call_start, call_end, disposition)
           VALUES ($1, $2, $3, $4, $5, NOW(), NOW(), 'dnc_blocked')`,
          [channelId, client.id, callerIdNum, callerIdName, did]
        );
        broadcast('call:dnc_blocked', { channelId, callerIdNum, clientId: client.id });
        try { await channel.hangup(); } catch { /* best-effort */ }
        return;
      }
    } catch (err) {
      console.warn('[ARI] DNC check failed (proceeding with call):', err.message);
    }
  }

  // Log the call
  let callLogId = null;
  try {
    const callResult = await pool.query(
      `INSERT INTO call_logs (asterisk_channel_id, client_id, caller_id_num, caller_id_name, did, call_start)
       VALUES ($1, $2, $3, $4, $5, NOW())
       RETURNING id`,
      [channelId, client?.id || null, callerIdNum, callerIdName, did]
    );
    callLogId = callResult.rows[0].id;
  } catch (err) {
    console.error('[ARI] Failed to log call:', err.message);
  }

  // Track in memory
  activeCalls.set(channelId, {
    channel,
    callLogId,
    clientId: client?.id || null,
    clientName: client?.name || 'Unknown Client',
    script: client?.script || '',
    greeting: client?.greeting || '',
    callerIdNum,
    callerIdName,
    did,
    startTime: new Date(),
  });

  // Play hold music while waiting for operator
  try {
    await channel.setChannelVar({ variable: 'CHANNEL(musicclass)', value: 'default' });
    await channel.startMoh();
  } catch (err) {
    // Non-fatal — channel may not support MOH
    console.warn('[ARI] MOH failed:', err.message);
  }

  // Broadcast to all connected operators
  broadcast('call:ringing', {
    channelId,
    callLogId,
    callerIdNum,
    callerIdName,
    did,
    client: client
      ? { id: client.id, name: client.name, account_number: client.account_number, script: client.script, greeting: client.greeting }
      : null,
  });
}

async function handleStasisEnd(event, channel) {
  const channelId = channel.id;
  const callData = activeCalls.get(channelId);

  if (!callData) return;

  const durationSec = Math.floor((Date.now() - callData.startTime.getTime()) / 1000);

  // Update call log
  if (callData.callLogId) {
    try {
      await pool.query(
        `UPDATE call_logs SET call_end = NOW(), duration_seconds = $1,
         disposition = COALESCE(disposition, 'no_answer')
         WHERE id = $2`,
        [durationSec, callData.callLogId]
      );
      // Auto-transcribe if a recording was captured
      const rec = await pool.query(
        'SELECT recording_url FROM call_logs WHERE id = $1', [callData.callLogId]
      );
      const recordingUrl = rec.rows[0]?.recording_url;
      if (recordingUrl) {
        transcribeCall(callData.callLogId, recordingUrl).catch(err =>
          console.warn('[ARI] Auto-transcription failed:', err.message)
        );
      }
      // Send CSAT survey asynchronously (only if client has csat_enabled)
      sendCsatSurvey(callData.callLogId).catch(err =>
        console.warn('[ARI] CSAT survey send failed:', err.message)
      );
    } catch (err) {
      console.error('[ARI] Failed to update call log:', err.message);
    }
  }

  activeCalls.delete(channelId);

  broadcast('call:ended', { channelId, callLogId: callData.callLogId, duration: durationSec });
  console.log(`[ARI] StasisEnd: channel=${channelId} duration=${durationSec}s`);
}

async function handleHangupRequest(event, channel) {
  broadcast('call:hangup_request', { channelId: channel.id });
}

/**
 * Answer a call and bridge to an operator's SIP extension.
 * Called when an operator clicks "Answer" in the console.
 */
async function answerCall(channelId, operatorExtension) {
  if (!ariClient) throw new Error('ARI not connected');

  const callData = activeCalls.get(channelId);
  if (!callData) throw new Error(`No active call for channel ${channelId}`);

  const { channel } = callData;

  // Stop MOH
  try { await channel.stopMoh(); } catch (_) {}

  // Answer the inbound channel
  await channel.answer();

  // Originate a call to the operator's extension
  const bridge = ariClient.Bridge();
  await bridge.create({ type: 'mixing' });

  const operatorChannel = await ariClient.channels.originate({
    endpoint: `SIP/${operatorExtension}`,
    app: process.env.ARI_APP || 'answering-service',
    appArgs: `operator,${channelId}`,
    callerId: `${callData.callerIdName} <${callData.callerIdNum}>`,
    timeout: 30,
  });

  // Store bridge ID for hold/unhold
  callData.bridgeId = bridge.id;

  // Add inbound channel to bridge
  await bridge.addChannel({ channel: channelId });

  // When operator channel answers, add it to the bridge
  operatorChannel.on('StasisStart', async () => {
    await bridge.addChannel({ channel: operatorChannel.id });

    // Update call log with answer time and operator
    broadcast('call:answered', { channelId, callLogId: callData.callLogId });
  });

  operatorChannel.on('StasisEnd', async () => {
    // Operator hung up
    try { await channel.hangup(); } catch (_) {}
    try { await bridge.destroy(); } catch (_) {}
  });

  return { bridgeId: bridge.id, operatorChannelId: operatorChannel.id };
}

/**
 * Transfer a call to another extension.
 */
async function transferCall(channelId, targetExtension) {
  if (!ariClient) throw new Error('ARI not connected');

  const callData = activeCalls.get(channelId);
  if (!callData) throw new Error(`No active call for channel ${channelId}`);

  await callData.channel.redirect({ endpoint: `SIP/${targetExtension}` });

  // Update call log disposition
  if (callData.callLogId) {
    await pool.query(
      "UPDATE call_logs SET disposition = 'transferred', call_answered = COALESCE(call_answered, NOW()) WHERE id = $1",
      [callData.callLogId]
    );
  }

  broadcast('call:transferred', { channelId, callLogId: callData.callLogId, target: targetExtension });
}

/**
 * Hang up a call.
 */
async function hangupCall(channelId) {
  if (!ariClient) throw new Error('ARI not connected');
  const callData = activeCalls.get(channelId);
  if (!callData) throw new Error(`No active call for channel ${channelId}`);
  await callData.channel.hangup();
}

/**
 * Get all currently active (ringing/in-progress) calls.
 */
function getActiveCalls() {
  return Array.from(activeCalls.entries()).map(([channelId, data]) => ({
    channelId,
    callLogId: data.callLogId,
    clientId: data.clientId,
    clientName: data.clientName,
    callerIdNum: data.callerIdNum,
    callerIdName: data.callerIdName,
    did: data.did,
    startTime: data.startTime,
    onHold: data.onHold || false,
  }));
}

/**
 * Place a call on hold by moving the caller into a holding bridge (plays MOH).
 */
async function holdCall(channelId) {
  if (!ariClient) throw new Error('ARI not connected');
  const callData = activeCalls.get(channelId);
  if (!callData) throw new Error(`No active call for channel ${channelId}`);
  if (callData.onHold) throw new Error('Call is already on hold');
  if (!callData.bridgeId) throw new Error('Call has not been answered yet');

  // Create a holding bridge — Asterisk plays MOH to channels in it automatically
  const holdingBridge = ariClient.Bridge();
  await holdingBridge.create({ type: 'holding' });
  callData.holdBridgeId = holdingBridge.id;

  // Move caller from mixing bridge to holding bridge
  const mixingBridge = ariClient.Bridge({ id: callData.bridgeId });
  await mixingBridge.removeChannel({ channel: channelId });
  await holdingBridge.addChannel({ channel: channelId });

  callData.onHold = true;
  broadcast('call:held', { channelId, callLogId: callData.callLogId });
  console.log(`[ARI] Call held: channel=${channelId}`);
}

/**
 * Take a call off hold, moving the caller back into the mixing bridge.
 */
async function unholdCall(channelId) {
  if (!ariClient) throw new Error('ARI not connected');
  const callData = activeCalls.get(channelId);
  if (!callData) throw new Error(`No active call for channel ${channelId}`);
  if (!callData.onHold) throw new Error('Call is not on hold');

  const holdingBridge = ariClient.Bridge({ id: callData.holdBridgeId });
  const mixingBridge = ariClient.Bridge({ id: callData.bridgeId });

  await holdingBridge.removeChannel({ channel: channelId });
  await mixingBridge.addChannel({ channel: channelId });
  try { await holdingBridge.destroy(); } catch (_) {}

  callData.holdBridgeId = null;
  callData.onHold = false;
  broadcast('call:unheld', { channelId, callLogId: callData.callLogId });
  console.log(`[ARI] Call unheld: channel=${channelId}`);
}

/**
 * Originate an outbound call from an operator to a destination number.
 * Uses the client's outbound_caller_id if set, otherwise the global setting.
 */
async function originateOutbound(operatorExtension, destination, clientId) {
  if (!ariClient) throw new Error('ARI not connected');

  // Determine caller ID: client override → global setting → default
  let callerId = process.env.OUTBOUND_CALLER_ID || operatorExtension;
  if (clientId) {
    try {
      const result = await pool.query(
        'SELECT outbound_caller_id FROM clients WHERE id = $1',
        [clientId]
      );
      if (result.rows[0]?.outbound_caller_id) {
        callerId = result.rows[0].outbound_caller_id;
      }
    } catch (err) {
      console.warn('[ARI] Could not fetch client outbound_caller_id:', err.message);
    }
  }

  // Also check system_settings for global outbound caller id
  if (!clientId || callerId === operatorExtension) {
    try {
      const settingResult = await pool.query(
        "SELECT value FROM system_settings WHERE key = 'outbound_caller_id'"
      );
      if (settingResult.rows[0]?.value) {
        callerId = settingResult.rows[0].value;
      }
    } catch (_) {}
  }

  // Create a bridge for the two legs
  const bridge = ariClient.Bridge();
  await bridge.create({ type: 'mixing' });

  // Originate to operator first
  const operatorChannel = await ariClient.channels.originate({
    endpoint: `SIP/${operatorExtension}`,
    app: process.env.ARI_APP || 'answering-service',
    appArgs: `outbound,${destination}`,
    callerId: `Outbound <${callerId}>`,
    timeout: 30,
  });

  // When operator answers, originate the outbound leg
  operatorChannel.on('StasisStart', async () => {
    await bridge.addChannel({ channel: operatorChannel.id });

    const outboundChannel = await ariClient.channels.originate({
      endpoint: `SIP/${destination}@trunk`,
      app: process.env.ARI_APP || 'answering-service',
      appArgs: `outbound-dest,${operatorChannel.id}`,
      callerId: `${callerId} <${callerId}>`,
      timeout: 60,
    });

    outboundChannel.on('StasisStart', async () => {
      await bridge.addChannel({ channel: outboundChannel.id });
      broadcast('call:outbound_connected', {
        operatorChannelId: operatorChannel.id,
        outboundChannelId: outboundChannel.id,
        destination,
      });
    });

    outboundChannel.on('StasisEnd', async () => {
      try { await operatorChannel.hangup(); } catch (_) {}
      try { await bridge.destroy(); } catch (_) {}
    });

    // Log the outbound call
    try {
      await pool.query(
        `INSERT INTO call_logs (asterisk_channel_id, client_id, caller_id_num, did, call_start, call_direction)
         VALUES ($1, $2, $3, $4, NOW(), 'outbound')`,
        [outboundChannel.id, clientId || null, callerId, destination]
      );
    } catch (err) {
      console.error('[ARI] Failed to log outbound call:', err.message);
    }
  });

  operatorChannel.on('StasisEnd', async () => {
    try { await bridge.destroy(); } catch (_) {}
  });

  return { bridgeId: bridge.id, operatorChannelId: operatorChannel.id };
}

function isConnected() { return ariClient !== null; }

module.exports = { connectARI, answerCall, holdCall, unholdCall, transferCall, hangupCall, getActiveCalls, originateOutbound, isConnected };
