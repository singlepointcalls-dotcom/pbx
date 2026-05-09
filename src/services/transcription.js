'use strict';

/**
 * Voicemail / call recording transcription service.
 *
 * Supports two providers (whichever is configured):
 *   - OpenAI Whisper API (OPENAI_API_KEY)
 *   - AssemblyAI (ASSEMBLYAI_API_KEY)
 *
 * After transcription, also generates a 1-2 sentence summary via Claude AI.
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const pool = require('../config/database');
const ai = require('./ai');

async function transcribeWithWhisper(audioBuffer, filename = 'recording.wav') {
  const form = new FormData();
  form.append('file', audioBuffer, { filename });
  form.append('model', 'whisper-1');
  form.append('response_format', 'text');

  const resp = await axios.post('https://api.openai.com/v1/audio/transcriptions', form, {
    headers: {
      ...form.getHeaders(),
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    maxBodyLength: 30 * 1024 * 1024,
    timeout: 120000,
  });
  return typeof resp.data === 'string' ? resp.data : resp.data?.text;
}

async function transcribeWithAssemblyAI(audioUrl) {
  const headers = { Authorization: process.env.ASSEMBLYAI_API_KEY, 'Content-Type': 'application/json' };

  const submit = await axios.post(
    'https://api.assemblyai.com/v2/transcript',
    { audio_url: audioUrl, language_detection: true },
    { headers, timeout: 30000 }
  );
  const transcriptId = submit.data.id;

  // Poll for completion (max 5 min)
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const status = await axios.get(`https://api.assemblyai.com/v2/transcript/${transcriptId}`, { headers });
    if (status.data.status === 'completed') return status.data.text;
    if (status.data.status === 'error') throw new Error(status.data.error);
  }
  throw new Error('AssemblyAI transcription timed out');
}

async function loadAudio(urlOrPath) {
  if (urlOrPath.startsWith('http')) {
    const resp = await axios.get(urlOrPath, { responseType: 'arraybuffer', timeout: 60000 });
    return Buffer.from(resp.data);
  }
  // Local file
  return fs.readFileSync(urlOrPath);
}

/**
 * Transcribe a single call recording.
 * @param {string} callLogId
 * @param {string} recordingUrl - URL or local path to audio file
 * @returns {Promise<{transcript, summary}>}
 */
async function transcribeCall(callLogId, recordingUrl) {
  if (!recordingUrl) throw new Error('No recording URL');

  let transcript = null;

  if (process.env.OPENAI_API_KEY) {
    const audioBuf = await loadAudio(recordingUrl);
    transcript = await transcribeWithWhisper(audioBuf, path.basename(recordingUrl));
  } else if (process.env.ASSEMBLYAI_API_KEY) {
    if (!recordingUrl.startsWith('http')) {
      throw new Error('AssemblyAI requires a public URL');
    }
    transcript = await transcribeWithAssemblyAI(recordingUrl);
  } else {
    throw new Error('No transcription provider configured (OPENAI_API_KEY or ASSEMBLYAI_API_KEY)');
  }

  if (!transcript) throw new Error('Empty transcript');

  // AI-generated summary (best effort)
  let summary = null;
  try {
    summary = await ai.summariseMessage({ body: transcript, client_name: 'Recording', caller_name: '' });
  } catch (_) { /* leave summary null */ }

  await pool.query(
    `UPDATE call_logs SET
       recording_transcript = $1,
       transcript_summary   = $2,
       transcribed_at       = NOW()
     WHERE id = $3`,
    [transcript, summary, callLogId]
  );

  return { transcript, summary };
}

/**
 * Background batch: transcribe any call_logs with recording_url but no transcript.
 * Returns count of newly transcribed.
 */
async function transcribePending(limit = 5) {
  const pending = await pool.query(
    `SELECT id, recording_url FROM call_logs
     WHERE recording_url IS NOT NULL AND recording_transcript IS NULL
     ORDER BY created_at DESC LIMIT $1`,
    [limit]
  );

  let done = 0;
  for (const row of pending.rows) {
    try {
      await transcribeCall(row.id, row.recording_url);
      done++;
    } catch (err) {
      console.warn(`Transcription failed for call ${row.id}:`, err.message);
    }
  }
  return done;
}

module.exports = { transcribeCall, transcribePending };
