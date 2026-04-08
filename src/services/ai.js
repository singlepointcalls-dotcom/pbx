'use strict';

/**
 * AI service — wraps the Anthropic Claude API for knowledge base Q&A.
 *
 * The service fetches all active knowledge base articles for a given client
 * (plus global articles), assembles them as context, and asks Claude to
 * answer a question using only that context.
 *
 * Requires ANTHROPIC_API_KEY in the environment.
 */

const Anthropic = require('@anthropic-ai/sdk');
const pool = require('../config/database');

let _client = null;

function getClient() {
  if (!_client) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY is not configured');
    }
    _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _client;
}

/**
 * Fetch active knowledge base articles relevant to a client.
 * Returns client-specific articles first, then global ones.
 *
 * @param {string|null} clientId  UUID of the client, or null for global only
 * @returns {Promise<Array>}
 */
async function fetchArticles(clientId) {
  const result = await pool.query(
    `SELECT id, title, content, category, tags
     FROM knowledge_base_articles
     WHERE is_active = true
       AND (client_id = $1 OR client_id IS NULL)
     ORDER BY client_id NULLS LAST, created_at ASC`,
    [clientId || null]
  );
  return result.rows;
}

/**
 * Ask Claude a question using the client's knowledge base as context.
 *
 * @param {string}      question  The operator's question
 * @param {string|null} clientId  UUID of the client (can be null)
 * @param {string|null} clientName Display name for the client (optional)
 * @returns {Promise<{answer: string, articles_used: number}>}
 */
async function askKnowledgeBase(question, clientId, clientName) {
  const articles = await fetchArticles(clientId);

  if (!articles.length) {
    return {
      answer: 'No knowledge base articles are available for this client yet. Add some articles in the Admin panel to get started.',
      articles_used: 0,
    };
  }

  // Build context block from articles
  const context = articles
    .map((a, i) => {
      const tags = a.tags && a.tags.length ? ` [${a.tags.join(', ')}]` : '';
      const cat  = a.category ? ` (${a.category})` : '';
      return `--- Article ${i + 1}${cat}${tags} ---\nTitle: ${a.title}\n${a.content}`;
    })
    .join('\n\n');

  const systemPrompt = `You are a knowledgeable assistant for operators at a telephone answering service.
Your role is to help operators quickly find accurate information about their client's business during live calls.

The client${clientName ? ` is "${clientName}"` : ''}.

You will be given a set of knowledge base articles for this client. Answer the operator's question concisely and accurately using ONLY the information provided. If the answer cannot be found in the articles, say so clearly rather than guessing.

Keep your response brief and practical — operators are on live calls and need quick answers.`;

  const userMessage = `Knowledge base articles:\n\n${context}\n\n---\n\nOperator question: ${question}`;

  const anthropic = getClient();
  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 512,
    messages: [{ role: 'user', content: userMessage }],
    system: systemPrompt,
  });

  const answer = response.content[0]?.text || 'No response received.';

  return {
    answer,
    articles_used: articles.length,
  };
}

module.exports = { askKnowledgeBase, fetchArticles };
