// ChatGPT-account Codex (OAuth) speaks a different model list than api.openai.com.
// There is no Codex CLI version constant elsewhere in this repo. 0.166.0 is the
// client_version verified against GET /backend-api/codex/models.
export const CODEX_CLIENT_VERSION = '0.166.0';

// visibility=list names from `codex debug models` on CLI 0.166.0.
// Hidden names (gpt-reserve, codex-auto-review) are intentionally absent.
export const CODEX_LISTED_MODELS = Object.freeze([
  'gpt-6.1-sol',
  'gpt-6.1-terra',
  'gpt-6-astra',
  'gpt-6-sol',
  'gpt-6-luna',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
]);

const NON_CHAT_NAME = /^(gpt-image-|chatgpt-image-|dall-e|text-embedding-|embedding-|tts-|whisper|omni-moderation)/i;

export function isCodexNonChatModel(name) {
  return NON_CHAT_NAME.test(String(name || '').trim());
}

export function isCodexChatGptSubscription(sub) {
  if (!sub || typeof sub !== 'object') return false;
  if (sub.oauth_provider === 'codex') return true;
  const source = String(sub.source_id || '').trim();
  const agent = String(sub.agent_id || '').trim();
  return source === 'codex' || agent === 'codex';
}

export function codexFallbackModelNames() {
  return CODEX_LISTED_MODELS.slice();
}

/** Keep chat slugs. Image and embedding names never belong on the Codex subscription. */
export function filterCodexChatModels(names) {
  const out = [];
  const seen = new Set();
  for (const raw of names || []) {
    const name = String(raw || '').trim();
    if (!name || seen.has(name) || isCodexNonChatModel(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/**
 * Codex models payload. Only visibility=list entries are kept.
 * Accepts { models }, { data }, or a bare array. Hidden entries are dropped.
 */
export function parseCodexModelsPayload(payload) {
  const list = Array.isArray(payload) ? payload
    : Array.isArray(payload?.models) ? payload.models
    : Array.isArray(payload?.data) ? payload.data
    : [];
  const out = [];
  const seen = new Set();
  for (const entry of list) {
    if (entry == null) continue;
    const name = typeof entry === 'string'
      ? entry.trim()
      : String(entry.slug || entry.id || entry.name || entry.model || '').trim();
    if (!name || seen.has(name)) continue;
    const visibility = typeof entry === 'string'
      ? 'list'
      : String(entry.visibility || entry.model_visibility || '').trim().toLowerCase();
    if (visibility !== 'list') continue;
    const modality = typeof entry === 'object'
      ? String(entry.modality || entry.type || entry.model_type || '').trim().toLowerCase()
      : '';
    if (modality === 'image' || modality === 'embedding' || modality === 'embed') continue;
    if (isCodexNonChatModel(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/**
 * Names to remove from contribution model_groups.
 * A name is removed when this Codex source was advertising it and the account
 * does not support it. Names served by another provider stay.
 */
export function contributionNamesToDrop({
  supported,
  codexProviderNames,
  otherNames,
  inheritedCatalogNames,
} = {}) {
  const ok = new Set(supported || []);
  const other = new Set(otherNames || []);
  const drop = new Set();
  const candidates = new Set([...(codexProviderNames || []), ...(inheritedCatalogNames || [])]);
  for (const name of candidates) {
    const n = String(name || '').trim();
    if (!n || ok.has(n) || other.has(n)) continue;
    drop.add(n);
  }
  return drop;
}

export function stripModelList(list, drop) {
  if (!Array.isArray(list) || !drop || !drop.size) return { list: list || [], changed: false };
  let changed = false;
  const next = [];
  for (const item of list) {
    const name = typeof item === 'string'
      ? String(item).trim()
      : String(item?.name || item?.id || '').trim();
    if (name && drop.has(name)) {
      changed = true;
      continue;
    }
    next.push(item);
  }
  return { list: next, changed };
}
