'use strict';
/**
 * System One 决策客户端（OpenDecision / TypeSafe Jev / custom）。
 *
 * 用途：
 * 1) decision_classifier：真实参与场景路由分类（可回退小模型）
 * 2) jev_shadow：旁路并行对比，不参与决策
 *
 * provider:
 *   - opendecision：本地 OpenDecision，默认无 key
 *   - typesafe：官方 Jev，需 API key
 *   - custom：自填 endpoint / model
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const yaml = require('js-yaml');
const { createHash } = require('crypto');

const LOG_FILE = path.join(os.homedir(), '.tokenbank', 'jev-shadow-log.jsonl');
const DEFAULT_YAML = path.join(__dirname, 'config', 'tokenbank.default.yaml');

const PRESETS = {
  opendecision: {
    endpoint: 'http://127.0.0.1:18080/v1/systemone',
    model: 'opendecision',
    requireApiKey: false,
  },
  typesafe: {
    endpoint: 'https://api.typesafe.ai/v1/systemone',
    model: 'jev-latest',
    requireApiKey: true,
  },
};

let _builtinRouting = null;

function builtinRouting() {
  if (_builtinRouting) return _builtinRouting;
  try {
    const doc = yaml.load(fs.readFileSync(DEFAULT_YAML, 'utf8')) || {};
    _builtinRouting = doc.routing || {};
  } catch {
    _builtinRouting = {};
  }
  return _builtinRouting;
}

/** 用户 routing 覆盖内置默认（浅合并一级 key，decision/shadow 段再浅合并）。 */
function mergedRouting(routingCfg) {
  const base = builtinRouting();
  const user = routingCfg || {};
  return {
    ...base,
    ...user,
    decision_classifier: { ...(base.decision_classifier || {}), ...(user.decision_classifier || {}) },
    jev_shadow: { ...(base.jev_shadow || {}), ...(user.jev_shadow || {}) },
  };
}

function isLoopbackUrl(url) {
  try {
    const u = new URL(String(url));
    return ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  } catch {
    return false;
  }
}

function resolveApiKey(raw, apiKeyEnv, provider) {
  // Local/custom services must never inherit another provider's credentials.
  let apiKey = String((apiKeyEnv && process.env[apiKeyEnv]) || '').trim();
  if (!apiKey && raw && raw.api_key_file) {
    try { apiKey = String(fs.readFileSync(String(raw.api_key_file), 'utf8')).trim(); } catch {}
  }
  if (!apiKey && provider === 'typesafe' && !raw.api_key_env && !raw.api_key_file) {
    const fallback = path.join(os.homedir(), '.tokenbank', 'typesafe-api-key');
    try { apiKey = String(fs.readFileSync(fallback, 'utf8')).trim(); } catch {}
  }
  return apiKey;
}

// Shared by the gateway and management IPC: do not display/save a different
// effective configuration from the one used for routing.
function effectiveRouting(yamlRouting, runtimeRouting) {
  const base = mergedRouting(yamlRouting);
  const runtime = runtimeRouting || {};
  return {
    ...base, ...runtime,
    decision_classifier: { ...base.decision_classifier, ...runtime.decision_classifier },
    jev_shadow: { ...base.jev_shadow, ...runtime.jev_shadow },
  };
}

function boundedNumber(value, fallback, min, max) {
  const n = Number(value);
  return value != null && Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

/** 解析 provider / endpoint / model / key 等公共字段。 */
function resolveProviderFields(raw, defaults) {
  const src = raw || {};
  const provider = String(src.provider || (defaults && defaults.provider) || 'opendecision').trim().toLowerCase() || 'opendecision';
  const preset = PRESETS[provider] || null;
  const endpoint = String(src.endpoint || (preset && preset.endpoint) || PRESETS.opendecision.endpoint).trim();
  const model = String(
    src.model != null && String(src.model).trim() !== ''
      ? src.model
      : (preset && preset.model) || 'opendecision',
  ).trim();
  const timeoutMs = boundedNumber(src.timeout_ms, 1500, 200, 10000);
  const maxChars = Math.floor(boundedNumber(src.max_chars, 600, 64, 16000));
  const apiKeyEnv = String(src.api_key_env || (provider === 'typesafe' ? 'TYPESAFE_API_KEY' : '')).trim();
  const apiKey = resolveApiKey(src, apiKeyEnv, provider);
  const requireApiKey = src.require_api_key != null
    ? !!src.require_api_key
    : (preset ? preset.requireApiKey : !isLoopbackUrl(endpoint));

  return {
    provider: PRESETS[provider] ? provider : 'custom',
    endpoint,
    model,
    timeoutMs,
    maxChars,
    apiKey,
    requireApiKey,
    healthCheck: src.health_check != null ? !!src.health_check : provider === 'opendecision',
    healthTtlMs: boundedNumber(src.health_ttl_ms, 30000, 1000, 300000),
    failureThreshold: Math.floor(boundedNumber(src.failure_threshold, 3, 1, 20)),
    cooldownMs: boundedNumber(src.cooldown_ms, 30000, 1000, 300000),
    maxConcurrent: Math.floor(boundedNumber(src.max_concurrent, 2, 1, 8)),
  };
}

/** 旁路配置：routing.jev_shadow */
function loadConfig(routingCfg) {
  const raw = mergedRouting(routingCfg).jev_shadow || {};
  return { enabled: !!raw.enabled, ...resolveProviderFields(raw) };
}

/**
 * 真实决策配置：routing.decision_classifier
 * engine: llm（默认）| systemone
 */
function loadDecisionConfig(routingCfg) {
  const raw = mergedRouting(routingCfg).decision_classifier || {};
  const engine = raw.enabled !== false && String(raw.engine || 'llm').trim().toLowerCase() === 'systemone' ? 'systemone' : 'llm';
  const fallbackLlm = raw.fallback_llm !== false;
  const minConfidence = boundedNumber(raw.min_confidence, 0.35, 0, 1);
  const fields = resolveProviderFields(raw);
  return {
    engine,
    fallbackLlm,
    minConfidence,
    llmTimeoutMs: boundedNumber(raw.llm_timeout_ms, 3000, 200, 15000),
    enabled: engine === 'systemone',
    ...fields,
  };
}

const metrics = { since: new Date().toISOString(), decisions: {}, shadow: { total: 0, comparable: 0, agreed: 0, errors: 0 } };
function getMetrics() { return JSON.parse(JSON.stringify(metrics)); }

function appendLog(rec) {
  if (rec.mode === 'shadow') {
    metrics.shadow.total++;
    if (rec.jev_error) metrics.shadow.errors++;
    if (rec.local_label && rec.jev_choice && !rec.jev_error) {
      metrics.shadow.comparable++;
      if (rec.local_label === rec.jev_choice) metrics.shadow.agreed++;
    }
  } else if (rec.mode === 'decision' && typeof rec.used === 'string') {
    metrics.decisions[rec.used] = (metrics.decisions[rec.used] || 0) + 1;
  }
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 5 * 1024 * 1024) {
      fs.copyFileSync(LOG_FILE, LOG_FILE + '.1');
      fs.truncateSync(LOG_FILE, 0);
    }
    const safe = { ...rec };
    delete safe.text_preview;
    if (safe.endpoint) {
      const url = new URL(safe.endpoint);
      safe.endpoint = url.origin + url.pathname;
    }
    fs.appendFileSync(LOG_FILE, JSON.stringify(safe) + '\n');
  } catch {}
}

/**
 * 调兼容 /v1/systemone 的 Choice。
 * @returns {Promise<{choice:string|null, confidence:number|null, probabilities:object|null, ms:number, provider?:string, error?:string}|null>}
 */
async function requestChoice(text, categories, cfg, fetchImpl, signal, state) {
  if (!cfg || !cfg.enabled) return null;
  const cats = (categories || []).map(String).filter(Boolean);
  if (!cats.length) return null;
  if (cfg.requireApiKey && !cfg.apiKey) {
    return null;
  }
  const snippet = String(text || '').slice(0, cfg.maxChars);
  if (!snippet) return null;

  const criteria = {};
  for (const c of cats) criteria[c] = `Matches category "${c}"`;

  const body = {
    state: snippet,
    questions: {
      intent: {
        type: 'choice',
        instructions: 'Classify the user request into exactly one of the given categories.',
        criteria,
      },
    },
  };
  if (cfg.model) body.model = cfg.model;

  const fetchFn = fetchImpl || globalThis.fetch;
  if (typeof fetchFn !== 'function') {
    return { choice: null, confidence: null, probabilities: null, ms: 0, provider: cfg.provider, error: 'no_fetch' };
  }

  const t0 = Date.now();
  try {
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;

    // A health response only proves reachability; inference below must also finish
    // within the SAME deadline (including cold model loading and response body).
    if (cfg.healthCheck && Date.now() >= state.healthyUntil) {
      const health = await fetchFn(new URL('/health', cfg.endpoint).href, {
        headers, signal, redirect: 'error',
      });
      if (!health.ok) {
        if (health.body && typeof health.body.cancel === 'function') await health.body.cancel();
        throw new Error(`health_http_${health.status}`);
      }
      const status = await health.json();
      if (!status || status.ready === false || status.ok === false ||
          ['error', 'unhealthy', 'loading', 'not_ready'].includes(status.status)) {
        throw new Error('not_ready');
      }
    }

    const resp = await fetchFn(cfg.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
      redirect: 'error',
    });
    if (!resp.ok) {
      if (resp.body && typeof resp.body.cancel === 'function') await resp.body.cancel();
      return {
        choice: null,
        confidence: null,
        probabilities: null,
        ms: Date.now() - t0,
        provider: cfg.provider,
        error: `http_${resp.status}`,
      };
    }
    const data = await resp.json();
    const ans = data && data.answers && data.answers.intent;
    let choice = ans && typeof ans.choice === 'string' ? ans.choice : null;
    if (choice && !cats.includes(choice)) {
      const low = choice.toLowerCase();
      choice = cats.find((c) => c.toLowerCase() === low) || null;
    }
    const confidence = ans && Number.isFinite(ans.confidence) && ans.confidence >= 0 && ans.confidence <= 1 ? ans.confidence : null;
    const probabilities = ans && ans.probabilities && typeof ans.probabilities === 'object' ? ans.probabilities : null;
    const error = !choice ? 'invalid_choice' : confidence == null ? 'invalid_confidence' : null;
    return { choice: error ? null : choice, confidence, probabilities, ms: Date.now() - t0, provider: cfg.provider, ...(error ? { error } : {}) };
  } catch (e) {
    return {
      choice: null,
      confidence: null,
      probabilities: null,
      ms: Date.now() - t0,
      provider: cfg.provider,
      error: signal.aborted ? 'timeout' : (e && /^health_http_\d+$|^not_ready$/.test(e.message) ? e.message : 'request_failed'),
    };
  }
}

// Also bounds a misbehaving adapter that ignores AbortSignal. Production fetch
// and internal HTTP requests honor the signal so timed-out work is cancelled.
async function withDeadline(timeoutMs, work) {
  const ac = new AbortController();
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => work(ac.signal)),
      new Promise((_, reject) => {
        timer = setTimeout(() => { reject(new Error('timeout')); ac.abort(); }, timeoutMs);
      }),
    ]);
  } finally { clearTimeout(timer); }
}

const serviceStates = new Map();
const decisionCache = new Map();
const pending = new Map();
let activeRequests = 0;
function fingerprint(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function unavailable(cfg, error, ms = 0) {
  return { choice: null, confidence: null, probabilities: null, provider: cfg.provider, error, ms };
}

function serviceKey(cfg) {
  return fingerprint([cfg.provider, cfg.endpoint, cfg.model, cfg.apiKey, cfg.healthCheck]);
}

function getServiceState(cfg) {
  const state = serviceStates.get(serviceKey(cfg));
  return {
    state: !state ? 'unused' : state.openUntil > Date.now() ? 'open' : state.openUntil ? 'half_open' : 'closed',
    failures: state?.failures || 0,
    active: state?.active || 0,
    retryAfterMs: Math.max(0, (state?.openUntil || 0) - Date.now()),
  };
}

// A synthetic check must not populate routing caches, trip/reset its circuit,
// write user-request logs, or call the paid LLM fallback.
async function probeService(cfg, fetchImpl) {
  const start = Date.now();
  try {
    return await withDeadline(cfg.timeoutMs, signal => requestChoice(
      'Please write a Python function that sorts a list of integers.',
      ['coding', 'general'], { ...cfg, enabled: true, healthCheck: true },
      fetchImpl, signal, { healthyUntil: 0 },
    ));
  } catch { return unavailable(cfg, 'timeout', Date.now() - start); }
}

async function classifyWithJev(text, categories, cfg, fetchImpl) {
  if (!cfg || !cfg.enabled || !String(text || '') || !categories?.length) return null;
  if (cfg.requireApiKey && !cfg.apiKey) return unavailable(cfg, 'missing_api_key');
  const key = serviceKey(cfg);
  let state = serviceStates.get(key);
  if (!state) {
    if (serviceStates.size >= 128) {
      const idle = [...serviceStates].find(([, s]) => !s.active);
      if (!idle) return unavailable(cfg, 'busy');
      serviceStates.delete(idle[0]);
    }
    state = { failures: 0, openUntil: 0, active: 0, healthyUntil: 0 };
    serviceStates.set(key, state);
  }
  if (state.openUntil > Date.now()) return unavailable(cfg, 'circuit_open');
  // After cooldown only one trial is allowed, including while an older call ends.
  if (state.openUntil && state.active) return unavailable(cfg, 'circuit_open');
  if (activeRequests >= 8 || state.active >= (cfg.maxConcurrent || 2)) return unavailable(cfg, 'busy');
  state.active++; activeRequests++;
  const start = Date.now();
  try {
    const result = await withDeadline(cfg.timeoutMs || 1500,
      signal => requestChoice(text, categories, cfg, fetchImpl, signal, state));
    if (!result || result.error || !result.choice) {
      state.failures++;
      state.healthyUntil = 0;
      if (state.failures >= (cfg.failureThreshold || 3)) state.openUntil = Date.now() + (cfg.cooldownMs || 30000);
    } else {
      state.failures = 0; state.openUntil = 0;
      state.healthyUntil = Date.now() + (cfg.healthTtlMs || 30000);
    }
    return result;
  } catch {
    state.failures++; state.healthyUntil = 0;
    if (state.failures >= (cfg.failureThreshold || 3)) state.openUntil = Date.now() + (cfg.cooldownMs || 30000);
    return unavailable(cfg, 'timeout', Date.now() - start);
  } finally { state.active--; activeRequests--; }
}

/** 真实路由用：接受 decision cfg，强制 enabled。 */
async function classifyForRouting(text, categories, decisionCfg, fetchImpl) {
  if (!decisionCfg || decisionCfg.engine !== 'systemone') return null;
  const cfg = { ...decisionCfg, enabled: true };
  const snippet = String(text || '').slice(0, cfg.maxChars);
  // Include the final input and all policy/provider settings, never plaintext keys.
  const key = fingerprint([cfg, categories, snippet]);
  const hit = decisionCache.get(key);
  if (hit && Date.now() - hit.ts < 300000) return { ...hit.result, cached: true };
  if (pending.has(key)) return pending.get(key);
  const task = (async () => {
    const result = await classifyWithJev(snippet, categories, cfg, fetchImpl);
    if (!result || result.error || !result.choice) return result;
    if (result.confidence < cfg.minConfidence) return { ...result, choice: null, error: 'low_confidence' };
    decisionCache.set(key, { ts: Date.now(), result });
    if (decisionCache.size > 500) decisionCache.delete(decisionCache.keys().next().value);
    return result;
  })();
  pending.set(key, task);
  try { return await task; } finally { pending.delete(key); }
}

/**
 * 与本地分类并行旁路：不 await 进路由。
 */
function observeParallel(opts) {
  const cfg = loadConfig(opts && opts.routingCfg);
  if (!cfg.enabled) return;
  const cats = (opts.categories || []).map(String);
  const localP = opts.localLabelPromise;
  if (!localP || typeof localP.then !== 'function') return;

  const jevP = classifyWithJev(opts.text, cats, cfg, opts.fetchImpl);

  void Promise.allSettled([localP, jevP]).then(([localRes, jevRes]) => {
    const local = localRes.status === 'fulfilled' ? localRes.value : null;
    const jev = jevRes.status === 'fulfilled' ? jevRes.value : null;
    const agree = !!(local && jev && jev.choice && String(local) === String(jev.choice));
    appendLog({
      ts: new Date().toISOString(),
      mode: 'shadow',
      provider: (jev && jev.provider) || cfg.provider,
      endpoint: cfg.endpoint,
      agree,
      local_label: local || null,
      jev_choice: jev && jev.choice || null,
      jev_confidence: jev && jev.confidence,
      jev_ms: jev && jev.ms,
      jev_error: jev && jev.error || (jevRes.status === 'rejected' ? String(jevRes.reason) : null),
      categories: cats,
      ...(opts.meta && typeof opts.meta === 'object' ? opts.meta : {}),
    });
  });
}

function logDecision(rec) {
  appendLog({ ts: new Date().toISOString(), mode: 'decision', ...rec });
}

module.exports = {
  LOG_FILE,
  PRESETS,
  loadConfig,
  loadDecisionConfig,
  classifyWithJev,
  classifyForRouting,
  observeParallel,
  appendLog,
  logDecision,
  isLoopbackUrl,
  withDeadline,
  mergedRouting,
  effectiveRouting,
  getServiceState,
  getMetrics,
  probeService,
};
