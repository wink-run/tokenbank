'use strict';
// Live model list for a ChatGPT-account Codex subscription.
// Auth headers come from the same applyAuth path the gateway uses.
// Tokens are never written to logs.

const oauth = require('./oauth');
const {
  CODEX_CLIENT_VERSION,
  codexFallbackModelNames,
  parseCodexModelsPayload,
} = require('../shared/codex-subscription-models');

const CACHE_TTL_MS = 15 * 60 * 1000;

let cache = null;

function cacheAccountKey(credentials) {
  const id = credentials && (credentials.account_id || credentials.email);
  return id ? String(id) : 'default';
}

function listedModelNames() {
  if (cache && Array.isArray(cache.names) && cache.names.length && (Date.now() - cache.at) < CACHE_TTL_MS) {
    return cache.names.slice();
  }
  return codexFallbackModelNames();
}

function resetCodexModelCache() {
  cache = null;
}

async function fetchCodexAccountModels(credentials, { requestImpl } = {}) {
  const auth = oauth.applyAuth('codex', {
    headers: { Accept: 'application/json' },
    body: undefined,
    credentials: credentials || {},
  });
  const base = String(auth.baseUrl || 'https://chatgpt.com/backend-api/codex').replace(/\/$/, '');
  const url = `${base}/models?client_version=${encodeURIComponent(CODEX_CLIENT_VERSION)}`;
  const res = requestImpl
    ? await requestImpl(url, auth.headers)
    : await oauth.oauthHttp(url, { method: 'GET', headers: auth.headers }).then((resp) => {
      let json = null;
      try { json = resp.text ? JSON.parse(resp.text) : null; } catch { json = null; }
      return { status: resp.status, json };
    });
  const status = res && res.status;
  if (!(status >= 200 && status < 300)) {
    const err = new Error(`codex models HTTP ${status || 0}`);
    err.status = status || 0;
    throw err;
  }
  const names = parseCodexModelsPayload(res.json);
  if (!names.length) throw new Error('codex models response had no listed models');
  return names;
}

async function refreshCodexAccountModels(credentials, opts = {}) {
  const key = cacheAccountKey(credentials);
  try {
    const names = await fetchCodexAccountModels(credentials, opts);
    cache = { key, names, at: Date.now(), source: 'live' };
    return { names: names.slice(), source: 'live' };
  } catch (err) {
    if (cache && cache.key === key && cache.source === 'live' && (Date.now() - cache.at) < CACHE_TTL_MS) {
      return { names: cache.names.slice(), source: 'live' };
    }
    const names = codexFallbackModelNames();
    return { names, source: 'fallback', error: String((err && err.message) || 'codex models fetch failed') };
  }
}

module.exports = {
  CACHE_TTL_MS,
  listedModelNames,
  resetCodexModelCache,
  fetchCodexAccountModels,
  refreshCodexAccountModels,
};
