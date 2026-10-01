'use strict';
const { createHash } = require('crypto');
const decision = require('./jev-shadow');

function safeEndpoint(endpoint) {
  try { const u = new URL(endpoint); return u.origin + u.pathname; } catch { return ''; }
}
function isLocalOpenDecision(cfg) {
  try {
    const u = new URL(cfg.endpoint);
    return cfg.provider === 'opendecision' && u.protocol === 'http:' &&
      ['127.0.0.1', '[::1]'].includes(u.hostname) && !u.username && !u.password && !u.search && !u.hash &&
      u.pathname === '/v1/systemone';
  } catch { return false; }
}
const fingerprint = cfg => createHash('sha256').update(JSON.stringify(cfg)).digest('hex');
const probeKey = ({ enabled, ...cfg }) => fingerprint(cfg);

function createManager({ getConfig, saveConfig, getYamlRouting = () => ({}), fetchImpl } = {}) {
  let lastProbe = null, pendingProbe = null, generation = 0;
  function config() {
    const routing = decision.effectiveRouting(getYamlRouting(), getConfig()?.routing);
    return { routing, dc: decision.loadDecisionConfig(routing), shadow: decision.loadConfig(routing) };
  }
  function status() {
    const { dc, shadow } = config();
    const active = dc.engine === 'systemone' ? dc : shadow;
    return {
      mode: dc.engine === 'systemone' ? 'active' : shadow.enabled ? 'shadow' : 'off',
      endpoint: safeEndpoint(shadow.endpoint), provider: shadow.provider,
      activeEndpoint: safeEndpoint(active.endpoint), activeProvider: active.provider,
      supported: isLocalOpenDecision(shadow), timeoutMs: shadow.timeoutMs,
      minConfidence: dc.minConfidence, fallbackLlm: dc.fallbackLlm,
      circuit: decision.getServiceState(active), metrics: decision.getMetrics(),
      probe: lastProbe?.key === probeKey(shadow) ? lastProbe.result : null,
    };
  }
  async function probe() {
    const cfg = config().shadow;
    if (!isLocalOpenDecision(cfg)) return { ok: false, error: 'unsupported_endpoint' };
    const key = probeKey(cfg);
    if (pendingProbe) return pendingProbe.key === key ? pendingProbe.task : { ok: false, error: 'busy' };
    const task = (async () => {
      const out = await decision.probeService(cfg, fetchImpl);
      const result = {
        ok: !!(out && !out.error && out.choice), checkedAt: new Date().toISOString(),
        ms: out?.ms || 0, choice: out?.choice || null, confidence: out?.confidence ?? null,
        error: out?.error || (!out?.choice ? 'no_result' : null),
      };
      lastProbe = { key, result };
      return result;
    })();
    pendingProbe = { key, task };
    try { return await task; } finally { pendingProbe = null; }
  }
  async function setMode(mode) {
    if (!['off', 'shadow'].includes(mode)) return { ok: false, error: 'unsupported_mode' };
    const request = ++generation;
    if (mode === 'shadow') {
      const before = fingerprint(config().shadow);
      const checked = await probe();
      if (request !== generation) return { ok: false, error: 'superseded' };
      if (!checked.ok) return { ok: false, error: checked.error, status: status() };
      if (before !== fingerprint(config().shadow)) return { ok: false, error: 'config_changed' };
    }
    // Re-read after async work and only patch our two fields/sections. Never write
    // a renderer's stale full config or copy resolved secrets from environment/YAML.
    const current = getConfig() || {};
    const routing = current.routing || {};
    saveConfig({ ...current, routing: {
      ...routing,
      decision_classifier: { ...routing.decision_classifier, engine: 'llm', enabled: false },
      jev_shadow: { ...routing.jev_shadow, enabled: mode === 'shadow' },
    } });
    return { ok: true, status: status() };
  }
  return { status, probe, setMode };
}

function registerIpc(ipcMain, deps) {
  const manager = createManager(deps);
  ipcMain.handle('decision:status', () => manager.status());
  ipcMain.handle('decision:probe', () => manager.probe());
  ipcMain.handle('decision:setMode', (_event, mode) => manager.setMode(mode));
  return manager;
}
module.exports = { createManager, registerIpc, isLocalOpenDecision };
