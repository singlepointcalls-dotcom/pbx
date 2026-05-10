'use strict';

/**
 * IVR Executor — runs an ivr_flows definition against an active ARI channel.
 *
 * Nodes supported:
 *   play      — play a sound file
 *   menu      — play a background prompt and branch on DTMF digit
 *   queue     — signals "put caller in normal operator queue" (returns false)
 *   transfer  — continue call in dialplan at a specific extension
 *   voicemail — send to voicemail via dialplan
 *   hangup    — hang up the channel
 *
 * Returns true  → IVR fully handled the call (hangup or transfer to dialplan)
 * Returns false → fall through to normal MOH/operator queue handling
 */

const MAX_NODES = 50; // guard against infinite loops in circular flows

function waitForDtmf(channel, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      channel.removeListener('ChannelDtmfReceived', handler);
      resolve(null);
    }, timeoutMs);

    function handler(event) {
      clearTimeout(timer);
      resolve(event.digit);
    }
    channel.once('ChannelDtmfReceived', handler);
  });
}

async function playSound(channel, file) {
  try {
    const playback = await channel.play({ media: `sound:${file}` });
    // Wait for playback to finish
    await new Promise((resolve) => {
      playback.once('PlaybackFinished', resolve);
      setTimeout(resolve, 30_000); // bail after 30s in case event never fires
    });
  } catch (err) {
    console.warn(`[IVR] playSound(${file}) failed:`, err.message);
  }
}

/**
 * Execute an IVR flow on a channel.
 * @param {object} flow  - Row from ivr_flows (must have .nodes JSONB array)
 * @param {object} channel - ARI channel object
 * @returns {Promise<boolean>} true if IVR handled the call, false to fall through
 */
async function executeIvrFlow(flow, channel) {
  const nodes = Array.isArray(flow.nodes) ? flow.nodes : [];
  if (!nodes.length) return false;

  console.log(`[IVR] Executing flow "${flow.name}" (${nodes.length} nodes) on channel ${channel.id}`);

  // Build a lookup map of node id → index for menu branching
  const nodeIndexById = {};
  nodes.forEach((n, i) => { if (n.id) nodeIndexById[n.id] = i; });

  let idx = 0;
  let iterations = 0;

  while (idx < nodes.length && iterations < MAX_NODES) {
    iterations++;
    const node = nodes[idx];

    switch (node.type) {
      case 'play': {
        const file = node.file || 'beep';
        await playSound(channel, file);
        idx++;
        break;
      }

      case 'menu': {
        const prompt = node.prompt || 'silence/1';
        const timeoutSec = node.timeout || 5;

        // Play the prompt (non-blocking) while listening for DTMF
        const playback = channel.play({ media: `sound:${prompt}` }).catch(() => null);

        const digit = await waitForDtmf(channel, timeoutSec * 1000);

        // Try to cancel the playback
        if (playback) {
          const pb = await playback;
          if (pb) pb.stop().catch(() => {});
        }

        if (digit && node.options?.[digit]) {
          const targetId = node.options[digit];
          // targetId can be a node id or a special keyword
          if (targetId === 'queue' || targetId === '__queue__') {
            return false; // send to operator queue
          }
          if (targetId === 'hangup') {
            try { await channel.hangup(); } catch (_) {}
            return true;
          }
          const targetIdx = nodeIndexById[targetId];
          if (targetIdx !== undefined) {
            idx = targetIdx;
          } else {
            idx++; // unknown target — advance
          }
        } else {
          idx++; // timeout or unrecognised digit — advance
        }
        break;
      }

      case 'queue':
        // Explicit queue node — fall back to operator queue handling
        return false;

      case 'transfer': {
        const ext = node.extension;
        if (ext) {
          try {
            await channel.continueInDialplan({
              context:   node.context || 'from-internal',
              extension: ext,
              priority:  1,
            });
            console.log(`[IVR] Transfer to extension ${ext}`);
            return true;
          } catch (err) {
            console.warn(`[IVR] Transfer failed (${ext}):`, err.message);
          }
        }
        idx++;
        break;
      }

      case 'voicemail': {
        const mailbox = node.mailbox || '100';
        const vmContext = node.context || 'default';
        try {
          await channel.continueInDialplan({ context: `voicemail-${vmContext}`, extension: mailbox, priority: 1 });
          return true;
        } catch (err) {
          console.warn('[IVR] Voicemail redirect failed:', err.message);
        }
        idx++;
        break;
      }

      case 'hangup':
        try { await channel.hangup(); } catch (_) {}
        return true;

      default:
        console.warn(`[IVR] Unknown node type: ${node.type} — skipping`);
        idx++;
    }
  }

  // Fell off the end without explicit hangup/transfer — queue the call
  return false;
}

module.exports = { executeIvrFlow };
