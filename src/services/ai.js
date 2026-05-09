'use strict';

/**
 * AI-powered features using Claude.
 * ANTHROPIC_API_KEY env var required. All functions are gracefully no-op if not set.
 */

const Anthropic = require('@anthropic-ai/sdk');

let client = null;
function getClient() {
  if (!client) {
    if (!process.env.ANTHROPIC_API_KEY) return null;
    client = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return client;
}

const MODEL = 'claude-haiku-4-5-20251001'; // fast + cheap for real-time features

/**
 * Summarise a message taken by an operator into 1-2 sentences.
 * Returns null if AI not configured or call fails.
 */
async function summariseMessage(message) {
  const ai = getClient();
  if (!ai) return null;
  try {
    const resp = await ai.messages.create({
      model: MODEL,
      max_tokens: 120,
      system: 'You are a concise assistant for a telephone answering service. Summarise the message in 1-2 short sentences. No preamble.',
      messages: [{
        role: 'user',
        content: `Client: ${message.client_name || 'Unknown'}\nCaller: ${message.caller_name || 'Unknown'} ${message.caller_phone || ''}\nSubject: ${message.subject || '(none)'}\nMessage: ${message.body || ''}`,
      }],
    });
    return resp.content[0]?.text?.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Classify urgency and call type from a message.
 * Returns { urgency: 'high'|'normal'|'low', call_type: string, confidence: number }
 */
async function classifyMessage(message) {
  const ai = getClient();
  if (!ai) return null;
  try {
    const resp = await ai.messages.create({
      model: MODEL,
      max_tokens: 80,
      system: 'You are a telephone answering service classifier. Reply with JSON only: {"urgency":"high"|"normal"|"low","call_type":"enquiry"|"complaint"|"emergency"|"appointment"|"sales"|"support"|"other","confidence":0.0-1.0}',
      messages: [{
        role: 'user',
        content: `Subject: ${message.subject || ''}\nMessage: ${message.body || ''}`,
      }],
    });
    const text = resp.content[0]?.text?.trim() || '{}';
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Suggest a draft SMS or email reply based on message context.
 */
async function suggestReply(message, channel = 'sms') {
  const ai = getClient();
  if (!ai) return null;
  try {
    const maxLen = channel === 'sms' ? 160 : 500;
    const resp = await ai.messages.create({
      model: MODEL,
      max_tokens: 200,
      system: `You are drafting a professional reply for a telephone answering service operator. Channel: ${channel}. Max ${maxLen} characters. Be concise, warm, and professional. No preamble — reply text only.`,
      messages: [{
        role: 'user',
        content: `Client: ${message.client_name || 'Unknown'}\nCaller: ${message.caller_name || 'Unknown'}\nOriginal message: ${message.body || ''}`,
      }],
    });
    return resp.content[0]?.text?.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Detect sentiment of a message body.
 * Returns { sentiment: 'positive'|'neutral'|'negative'|'distressed', score: -1.0 to 1.0 }
 */
async function detectSentiment(text) {
  const ai = getClient();
  if (!ai) return null;
  try {
    const resp = await ai.messages.create({
      model: MODEL,
      max_tokens: 60,
      system: 'Analyse sentiment. Reply JSON only: {"sentiment":"positive"|"neutral"|"negative"|"distressed","score":-1.0 to 1.0}',
      messages: [{ role: 'user', content: text }],
    });
    return JSON.parse(resp.content[0]?.text?.trim() || '{}');
  } catch {
    return null;
  }
}

/**
 * Extract key entities from a caller message (name, number, company, etc.)
 * Returns { name, phone, company, email, address } — any can be null.
 */
async function extractEntities(text) {
  const ai = getClient();
  if (!ai) return null;
  try {
    const resp = await ai.messages.create({
      model: MODEL,
      max_tokens: 150,
      system: 'Extract caller entities from the text. Reply JSON only: {"name":null,"phone":null,"company":null,"email":null,"address":null}. Use null for missing fields.',
      messages: [{ role: 'user', content: text }],
    });
    return JSON.parse(resp.content[0]?.text?.trim() || '{}');
  } catch {
    return null;
  }
}

/**
 * Generate a professional call script suggestion for a given client context.
 */
async function generateScript(clientInfo) {
  const ai = getClient();
  if (!ai) return null;
  try {
    const resp = await ai.messages.create({
      model: MODEL,
      max_tokens: 600,
      system: 'You write telephone answering service call scripts. Be professional, empathetic, and clear. Include: greeting, information to collect, escalation instructions.',
      messages: [{
        role: 'user',
        content: `Business name: ${clientInfo.name}\nIndustry: ${clientInfo.industry || 'general'}\nNotes: ${clientInfo.notes || 'none'}\n\nWrite a call-handling script for operators.`,
      }],
    });
    return resp.content[0]?.text?.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Translate text to a target language (ISO code, e.g. 'en', 'es', 'fr', 'pl').
 * Returns the translated string or null on failure.
 */
async function translateText(text, targetLang = 'en') {
  const ai = getClient();
  if (!ai) return null;
  try {
    const resp = await ai.messages.create({
      model: MODEL,
      max_tokens: Math.min(1000, text.length * 3),
      system: `You are a professional translator. Translate the user's text to ${targetLang}. Preserve names, numbers, and formatting. Output the translation only — no preamble.`,
      messages: [{ role: 'user', content: text }],
    });
    return resp.content[0]?.text?.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Detect the language of a piece of text. Returns ISO 639-1 code or null.
 */
async function detectLanguage(text) {
  const ai = getClient();
  if (!ai) return null;
  try {
    const resp = await ai.messages.create({
      model: MODEL,
      max_tokens: 10,
      system: 'Reply with the ISO 639-1 two-letter language code only. No other text.',
      messages: [{ role: 'user', content: text.slice(0, 500) }],
    });
    return (resp.content[0]?.text?.trim() || '').toLowerCase().slice(0, 2) || null;
  } catch {
    return null;
  }
}

module.exports = {
  summariseMessage, classifyMessage, suggestReply, detectSentiment,
  extractEntities, generateScript, translateText, detectLanguage,
};
