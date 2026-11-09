'use strict';
// CommonJS 入口，供 Electron 主进程、CLI gateway（Node 20）和 node:test 的 require()。
// 不能 require() 旁边的 .mjs：Node 20.18 会抛 ERR_REQUIRE_ESM，网关进程起不来。
// Vite 具名导入走 contribute-autostart.mjs。两份实现必须保持同一套导出。

const DEFINITIVE_AUTH_STATUSES = new Set([401, 403]);
const DEFINITIVE_WORKER_CLOSE = 4001;

function classifyProfileFailure(err) {
  const status = Number(err?.response?.status || err?.status || 0);
  if (DEFINITIVE_AUTH_STATUSES.has(status)) return 'auth';
  return 'transient';
}

function isDefinitiveWorkerClose(code) {
  return Number(code) === DEFINITIVE_WORKER_CLOSE;
}

/** 只改凭证字段，保留 model_groups / auto_start / 圈子范围。 */
function withContributionCredentials(cfg, workerKey, serverUrl) {
  const next = { ...(cfg && typeof cfg === 'object' ? cfg : {}) };
  if (workerKey) next.worker_key = workerKey;
  if (serverUrl) next.server_url = serverUrl;
  return next;
}

/** 去掉不能再用的贡献凭证。不改上架模型和圈子。 */
function withoutContributionCredentials(cfg) {
  const next = { ...(cfg && typeof cfg === 'object' ? cfg : {}) };
  delete next.worker_key;
  delete next.server_url;
  return next;
}

function decideAutoStart({ autoStart, hasCredentials, running, suppressed }) {
  if (suppressed) return 'suppressed';
  if (running) return 'already-running';
  if (!autoStart) return 'disabled';
  if (!hasCredentials) return 'no-credentials';
  return 'start';
}

/**
 * @param {{
 *   readConfig: () => object|null,
 *   writeConfig: (cfg: object) => void,
 *   isRunning: () => boolean,
 *   start: () => void,
 *   stop: () => void,
 * }} deps
 */
function createContributeAutoStart(deps) {
  let suppressed = false;
  let appliedKey = '';
  let authHandled = false;

  function read() {
    const cfg = deps.readConfig();
    return cfg && typeof cfg === 'object' ? cfg : {};
  }

  function maybeAutoStart() {
    const cfg = read();
    const action = decideAutoStart({
      autoStart: !!cfg.auto_start,
      hasCredentials: !!cfg.worker_key,
      running: !!deps.isRunning(),
      suppressed,
    });
    if (action !== 'start') return action;
    appliedKey = String(cfg.worker_key);
    authHandled = false;
    deps.start();
    return 'start';
  }

  return {
    maybeAutoStart,
    noteExplicitStart() {
      suppressed = false;
      authHandled = false;
    },
    noteManualStop() {
      suppressed = true;
      deps.stop();
    },
    noteLogout() {
      suppressed = true;
      authHandled = true;
      deps.stop();
      const raw = deps.readConfig();
      if (!raw || typeof raw !== 'object') return;
      deps.writeConfig(withoutContributionCredentials(raw));
    },
    noteTransientFailure() {
      return 'transient';
    },
    noteAuthRejected() {
      suppressed = true;
      if (authHandled) return 'auth-already';
      authHandled = true;
      deps.stop();
      const raw = deps.readConfig();
      if (raw && typeof raw === 'object') deps.writeConfig(withoutContributionCredentials(raw));
      return 'auth';
    },
    noteCredentialsReady(workerKey, serverUrl) {
      const key = String(workerKey || '');
      if (!key) return 'no-credentials';
      const cfg = read();
      const next = withContributionCredentials(cfg, key, serverUrl || cfg.server_url || '');
      if (cfg.worker_key !== next.worker_key || cfg.server_url !== next.server_url) {
        deps.writeConfig(next);
      }
      if (suppressed) {
        if (deps.isRunning()) deps.stop();
        return 'suppressed';
      }
      if (deps.isRunning()) {
        if (appliedKey && appliedKey !== key) {
          appliedKey = key;
          authHandled = false;
          deps.start();
          return 'reconnected';
        }
        appliedKey = key;
        return 'already-running';
      }
      return maybeAutoStart();
    },
  };
}

module.exports = {
  classifyProfileFailure,
  isDefinitiveWorkerClose,
  withContributionCredentials,
  withoutContributionCredentials,
  decideAutoStart,
  createContributeAutoStart,
};
