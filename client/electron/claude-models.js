'use strict';

// Official public, active Claude API models, checked 2026-11-27.
// https://platform.claude.com/docs/en/models/overview
// https://platform.claude.com/docs/en/about-claude/model-deprecations
// A catalog entry is not a guarantee of OAuth plan entitlement. Invitation-only
// Mythos models and retired models are deliberately not added to defaults.
// 新的在前：withClaudeOAuthModels 靠这个顺序判断哪些是用户保存清单之后才发布的。
const DEFINITIONS = Object.freeze([
  // 2026-11：Claude Code 默认已经是 claude-opus-5-5。这几个都关不掉思考（Sonnet 5.5 的 disabled 也会 400），
  // 采样参数一律 400
  { name: 'claude-opus-5-5', context_window: 1000000, max_output_tokens: 128000, adaptiveOnly: true, alwaysThinking: true },
  { name: 'claude-sonnet-5-5', context_window: 1000000, max_output_tokens: 128000, adaptiveOnly: true, alwaysThinking: true },
  { name: 'claude-haiku-5-5', context_window: 1000000, max_output_tokens: 128000, adaptiveOnly: true },
  { name: 'claude-fable-5-2', context_window: 1000000, max_output_tokens: 128000, adaptiveOnly: true, alwaysThinking: true },
  { name: 'claude-opus-5', context_window: 1000000, max_output_tokens: 128000, adaptiveOnly: true },
  { name: 'claude-sonnet-5', context_window: 1000000, max_output_tokens: 128000, adaptiveOnly: true },
  { name: 'claude-haiku-4-5-20251001', context_window: 200000, max_output_tokens: 64000 },
  { name: 'claude-fable-5-1', context_window: 1000000, max_output_tokens: 128000, adaptiveOnly: true, alwaysThinking: true },
  { name: 'claude-fable-5', context_window: 1000000, max_output_tokens: 128000, adaptiveOnly: true, alwaysThinking: true },
  { name: 'claude-opus-4-8', context_window: 1000000, max_output_tokens: 128000, adaptiveOnly: true },
  { name: 'claude-opus-4-7', context_window: 1000000, max_output_tokens: 128000, adaptiveOnly: true },
  { name: 'claude-opus-4-6', context_window: 1000000, max_output_tokens: 128000 },
  { name: 'claude-sonnet-4-6', context_window: 1000000, max_output_tokens: 128000 },
  { name: 'claude-opus-4-5-20251101', context_window: 200000, max_output_tokens: 64000 },
  { name: 'claude-sonnet-4-5-20250929', context_window: 200000, max_output_tokens: 64000 },
].map(Object.freeze));

function claudeModelInfo(name) {
  const id = String(name || '').toLowerCase();
  return DEFINITIONS.find((m) => m.name === id || m.name.replace(/-\d{8}$/, '') === id) || null;
}

function claudeOAuthModels() {
  return DEFINITIONS.map(({ name, context_window, max_output_tokens }) => ({
    name, type: 'chat', vision: true, context_window, max_output_tokens,
  }));
}

function isClaudeOAuthProvider(provider) {
  if (!provider) return false;
  if (provider.oauth_provider === 'claude' || provider.oauth?.provider === 'claude') return true;
  if (provider.auth_type !== 'oauth') return false;
  try { return new URL(provider.base_url).hostname === 'api.anthropic.com'; } catch { return false; }
}

// Empty lists include catalog-sync resets; explicit selections remain authoritative.
// 已保存的清单像是当时整份同步的官方目录（含它那时一半以上的官方模型）时，补上「比清单里最新的还新」的模型：
// 那些是保存之后才发布的，用户没机会勾选（例如 Claude Code 升级后默认发 claude-opus-5-5，旧清单没有就报模型不可用）。
// 只挑了几个的清单是用户的选择，不动；比清单里最新的旧的模型，删掉的也不会被加回来。
function withClaudeOAuthModels(provider) {
  if (!isClaudeOAuthProvider(provider)) return provider;
  if (!Array.isArray(provider.models) || !provider.models.length) return { ...provider, models: claudeOAuthModels() };
  const nameOf = (m) => String(typeof m === 'string' ? m : (m && (m.name || m.id)) || '').toLowerCase();
  const have = new Set(provider.models.map(nameOf));
  const known = DEFINITIONS.map((d, i) => ({ i, hit: have.has(d.name) || have.has(d.name.replace(/-\d{8}$/, '')) }))
    .filter((x) => x.hit).map((x) => x.i);
  if (!known.length) return provider;   // 清单里没有官方目录里的名字：是用户自定义的，不动
  const newest = Math.min(...known);
  if (known.length * 2 < DEFINITIONS.length - newest) return provider;
  const fresh = claudeOAuthModels().slice(0, newest);
  return fresh.length ? { ...provider, models: [...fresh, ...provider.models] } : provider;
}

// Apply only in Claude OAuth's outbound body hook, after protocol conversion.
// Migration guides: /models/opus-5/migration-guide and /models/fable-5-1/migration-guide.
function normalizeClaudeOAuthBody(body) {
  const info = claudeModelInfo(body?.model);
  if (!info || !body || typeof body !== 'object') return body;
  const out = { ...body };
  if (Number.isFinite(out.max_tokens) && out.max_tokens > info.max_output_tokens) {
    out.max_tokens = info.max_output_tokens;
  }
  if (info.adaptiveOnly) {
    delete out.temperature;
    delete out.top_p;
    delete out.top_k;
    const thinking = out.thinking;
    if (thinking && (thinking.type === 'enabled' || thinking.type === 'adaptive'
      || (info.alwaysThinking && thinking.type === 'disabled'))) {
      out.thinking = { ...thinking, type: 'adaptive' };
      delete out.thinking.budget_tokens;
    }
  }
  // Preserve explicit tool choice and signed history. Incompatible forced-tool
  // requests on Fable 5.1 must not silently become optional tool use.
  return out;
}

module.exports = { claudeModelInfo, claudeOAuthModels, isClaudeOAuthProvider, withClaudeOAuthModels, normalizeClaudeOAuthBody };
