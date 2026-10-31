'use strict';

// Pi 编程代理纳管：合并写入 ~/.pi/agent/models.json 的 tokenbank 提供商，
// 并在 settings.json 里把默认模型指过去。其它提供商和用户字段原样保留。
// 还原只删 tokenbank，默认模型回到纳管前记下的值。

const fs = require('fs');
const path = require('path');
const os = require('os');

const PROVIDER_ID = 'tokenbank';
const STATE_NAME = '.tokenbank-pi.json';

// Pi 与仍使用它那套 models.json + settings.json 的派生。
// omp 是同一家族，但配置改成了 models.yml + config.yml 的 modelRoles.default。
// 目录只认绝对路径的环境变量；omp 与 Pi 共用 PI_CODING_AGENT_DIR，
// 只有该目录里已经有 omp 自己的 config.yml / agent.db 时才跟过去。
const FAMILY = [
  {
    id: 'pi',
    handlerId: 'pi-cli',
    command: 'pi',
    kind: 'json',
    envs: ['PI_CODING_AGENT_DIR'],
    sessionEnv: 'PI_CODING_AGENT_SESSION_DIR',
    homeRel: ['.pi', 'agent'],
  },
  {
    id: 'omo',
    handlerId: 'omo-cli',
    command: 'omo',
    kind: 'json',
    // 不读 PI_CODING_AGENT_DIR：那是 Pi 自己的目录
    envs: ['OMO_CODING_AGENT_DIR', 'SENPI_CODING_AGENT_DIR'],
    homeRel: ['.omo', 'agent'],
    // 旧版独立安装落在 ~/.senpi/agent，没有 ~/.omo 时引擎会读它
    fallbackHomeRel: ['.senpi', 'agent'],
  },
  {
    id: 'prime',
    handlerId: 'prime-cli',
    command: 'prime-agent',
    kind: 'json',
    envs: ['PRIME_AGENT_CODING_AGENT_DIR'],
    homeRel: ['.prime', 'agent'],
    // 非空 allowedModels 是硬白名单，漏了网关模型会直接失败
    touchAllowedModels: true,
  },
  {
    id: 'omp',
    handlerId: 'omp-cli',
    command: 'omp',
    kind: 'yaml',
    envs: ['PI_CODING_AGENT_DIR'],
    envMustLookLike: true,
    homeRel: ['.omp', 'agent'],
  },
];

function profileForHandler(handlerId) {
  return FAMILY.find((p) => p.handlerId === handlerId) || null;
}

function profileForEntity(id) {
  const s = String(id || '');
  return FAMILY.find((p) => p.id === s || p.handlerId === s) || null;
}

function expandUser(p) {
  if (!p) return '';
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function homeDir(rel) {
  return path.join(os.homedir(), ...rel);
}

function looksLikeOmp(dir) {
  if (!dir) return false;
  return ['config.yml', 'config.yaml', 'agent.db'].some((name) => fs.existsSync(path.join(dir, name)));
}

function agentDir(profile) {
  for (const key of profile.envs || []) {
    const raw = expandUser(String(process.env[key] || '').trim());
    if (!raw || !path.isAbsolute(raw)) continue;
    const dir = path.normalize(raw);
    if (profile.envMustLookLike && !looksLikeOmp(dir)) continue;
    return dir;
  }
  const primary = homeDir(profile.homeRel);
  if (profile.fallbackHomeRel) {
    const fallback = homeDir(profile.fallbackHomeRel);
    if (!piAgentReady(primary) && piAgentReady(fallback)) return fallback;
  }
  return primary;
}

function defaultAgentDir() {
  return agentDir(profileForEntity('pi'));
}

/** 会话 JSONL 根目录。环境变量或 senpi 回退才偏离默认路径；否则返回 null，扫描用 YAML 里的 root。 */
function sessionRootOverride(profile) {
  if (!profile || profile.kind !== 'json') return null;
  if (profile.sessionEnv) {
    const raw = expandUser(String(process.env[profile.sessionEnv] || '').trim());
    if (raw) return raw;
  }
  for (const key of profile.envs || []) {
    const raw = expandUser(String(process.env[key] || '').trim());
    if (!raw || !path.isAbsolute(raw)) continue;
    return path.join(path.normalize(raw), 'sessions');
  }
  if (profile.fallbackHomeRel) {
    const primary = homeDir(profile.homeRel);
    const fallback = homeDir(profile.fallbackHomeRel);
    if (!piAgentReady(primary) && piAgentReady(fallback)) return path.join(fallback, 'sessions');
  }
  return null;
}

function modelsFile(profile) {
  const dir = agentDir(profile);
  if (profile.kind === 'yaml') return ompModelsPath(dir);
  return path.join(dir, 'models.json');
}

function familyReady(profile) {
  const dir = agentDir(profile);
  if (profile.kind === 'yaml') return looksLikeOmp(dir);
  return piAgentReady(dir);
}

function agentDirFrom(modelsFile) {
  return path.dirname(modelsFile);
}

function readJson(file) {
  try {
    if (!fs.existsSync(file)) return null;
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return {};
    return doc;
  } catch {
    return {};
  }
}

function writeJson(file, doc) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
}

/** 已装过 Pi：有 settings / auth / sessions。models.json 可能是我们新建的，单独不算。 */
function piAgentReady(agentDir) {
  if (!agentDir) return false;
  if (fs.existsSync(path.join(agentDir, 'settings.json'))) return true;
  if (fs.existsSync(path.join(agentDir, 'auth.json'))) return true;
  try {
    const sessions = path.join(agentDir, 'sessions');
    return fs.existsSync(sessions) && fs.statSync(sessions).isDirectory();
  } catch {
    return false;
  }
}

function modelIdsFromPatch(patch) {
  const raw = patch?.['providers.tokenbank.models'];
  if (!Array.isArray(raw)) return [];
  const ids = [];
  for (const item of raw) {
    const id = typeof item === 'string' ? item : item?.id;
    if (id && !ids.includes(String(id))) ids.push(String(id));
  }
  return ids;
}

function scopeTakes(patterns, ref) {
  return (patterns || []).some((p) => {
    const s = String(p);
    return s === ref || s === `${PROVIDER_ID}/*` || s === '*';
  });
}

/**
 * 合并纳管。modelIds 为空时仍写入提供商，但不改默认模型（Pi 没有可选模型）。
 */
function applyPiGateway(modelsFile, { patch = {}, modelIds, touchAllowedModels = false } = {}) {
  const agentDir = agentDirFrom(modelsFile);
  const settingsFile = path.join(agentDir, 'settings.json');
  const ids = modelIds?.length ? modelIds : modelIdsFromPatch(patch);
  const provider = {
    name: patch['providers.tokenbank.name'] || 'Token Bank',
    baseUrl: patch['providers.tokenbank.baseUrl'] || '',
    api: patch['providers.tokenbank.api'] || 'openai-completions',
    apiKey: patch['providers.tokenbank.apiKey'] || '',
    authHeader: true,
    models: ids.map((id) => ({ id })),
  };

  const createdModels = !fs.existsSync(modelsFile);
  const models = readJson(modelsFile) || {};
  if (!models.providers || typeof models.providers !== 'object' || Array.isArray(models.providers)) {
    models.providers = {};
  }
  const previousProvider = models.providers[PROVIDER_ID];
  models.providers[PROVIDER_ID] = provider;
  writeJson(modelsFile, models);

  const createdSettings = !fs.existsSync(settingsFile);
  const settings = readJson(settingsFile) || {};
  const stateFile = path.join(agentDir, STATE_NAME);
  // 只在第一次纳管时记下原默认值，重复写入不要覆盖还原点
  if (!fs.existsSync(stateFile)) {
    writeJson(stateFile, {
      createdModels,
      createdSettings,
      hadProvider: previousProvider != null,
      provider: previousProvider ?? null,
      hadDefaultProvider: Object.prototype.hasOwnProperty.call(settings, 'defaultProvider'),
      defaultProvider: settings.defaultProvider ?? null,
      hadDefaultModel: Object.prototype.hasOwnProperty.call(settings, 'defaultModel'),
      defaultModel: settings.defaultModel ?? null,
      hadAllowedModels: Object.prototype.hasOwnProperty.call(settings, 'allowedModels'),
      allowedModels: settings.allowedModels ?? null,
    });
  }

  if (ids[0]) {
    settings.defaultProvider = PROVIDER_ID;
    settings.defaultModel = ids[0];
    // Prime 的 allowedModels 是白名单；已有列表时把所选模型加进去
    if (touchAllowedModels && Array.isArray(settings.allowedModels) && settings.allowedModels.length) {
      if (!scopeTakes(settings.allowedModels, ids[0]) && !settings.allowedModels.includes(ids[0])) {
        settings.allowedModels = [...settings.allowedModels, ids[0]];
      }
    }
    // 已有 Ctrl+P 范围时把所选模型加进去，否则 Pi 新会话不会用到它。没有范围则不新建。
    if (Array.isArray(settings.enabledModels) && settings.enabledModels.length) {
      const ref = `${PROVIDER_ID}/${ids[0]}`;
      if (!scopeTakes(settings.enabledModels, ref)) {
        settings.enabledModels = [...settings.enabledModels, ref];
      }
    }
    writeJson(settingsFile, settings);
  }
  // 没有可选模型时不改 settings，也不为纳管新建空文件。

  return { ok: true, modelsFile, settingsFile, modelIds: ids };
}

/** 去掉 tokenbank 提供商，默认模型回到纳管前。enabledModels 里 tokenbank/ 前缀一并拿掉。 */
function revertPiGateway(modelsFile) {
  if (!modelsFile) return { ok: false };
  const agentDir = agentDirFrom(modelsFile);
  const settingsFile = path.join(agentDir, 'settings.json');
  const stateFile = path.join(agentDir, STATE_NAME);
  const state = readJson(stateFile);

  if (fs.existsSync(modelsFile)) {
    const models = readJson(modelsFile) || {};
    if (models.providers && (models.providers[PROVIDER_ID] || state?.hadProvider)) {
      if (state?.hadProvider) models.providers[PROVIDER_ID] = state.provider;
      else delete models.providers[PROVIDER_ID];
      const providerCount = Object.keys(models.providers).length;
      const onlySchema = Object.keys(models).every((k) => k === 'providers' || k === '$schema');
      if (state?.createdModels && providerCount === 0 && onlySchema) {
        try { fs.unlinkSync(modelsFile); } catch { /* ignore */ }
      } else {
        writeJson(modelsFile, models);
      }
    }
  }

  if (fs.existsSync(settingsFile) && state) {
    const settings = readJson(settingsFile) || {};
    if (state.hadDefaultProvider) settings.defaultProvider = state.defaultProvider;
    else delete settings.defaultProvider;
    if (state.hadDefaultModel) settings.defaultModel = state.defaultModel;
    else delete settings.defaultModel;
    if (Object.prototype.hasOwnProperty.call(state, 'hadAllowedModels')) {
      if (state.hadAllowedModels) settings.allowedModels = state.allowedModels;
      else delete settings.allowedModels;
    }
    if (Array.isArray(settings.enabledModels)) {
      settings.enabledModels = settings.enabledModels.filter((p) => !String(p).startsWith(`${PROVIDER_ID}/`));
      if (!settings.enabledModels.length) delete settings.enabledModels;
    }
    if (state.createdSettings && Object.keys(settings).length === 0) {
      try { fs.unlinkSync(settingsFile); } catch { /* ignore */ }
    } else {
      writeJson(settingsFile, settings);
    }
  }

  try { fs.unlinkSync(stateFile); } catch { /* ignore */ }
  return { ok: true };
}

function readYaml(file) {
  const yaml = require('js-yaml');
  try {
    if (!fs.existsSync(file)) return null;
    const doc = yaml.load(fs.readFileSync(file, 'utf8'));
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return {};
    return doc;
  } catch {
    return {};
  }
}

function writeYaml(file, doc) {
  const yaml = require('js-yaml');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, yaml.dump(doc, { lineWidth: 120, noRefs: true }), 'utf8');
}

function ompModelsPath(dir) {
  const yml = path.join(dir, 'models.yml');
  const yamlFile = path.join(dir, 'models.yaml');
  if (!fs.existsSync(yml) && fs.existsSync(yamlFile)) return yamlFile;
  return yml;
}

function ompConfigPath(dir) {
  const yml = path.join(dir, 'config.yml');
  const yamlFile = path.join(dir, 'config.yaml');
  if (!fs.existsSync(yml) && fs.existsSync(yamlFile)) return yamlFile;
  return yml;
}

function providerFromPatch(patch, ids) {
  return {
    name: patch['providers.tokenbank.name'] || 'Token Bank',
    baseUrl: patch['providers.tokenbank.baseUrl'] || '',
    api: patch['providers.tokenbank.api'] || 'openai-completions',
    apiKey: patch['providers.tokenbank.apiKey'] || '',
    authHeader: true,
    models: ids.map((id) => ({ id })),
  };
}

/**
 * oh-my-pi：providers 写 models.yml，默认角色写 config.yml 的 modelRoles.default。
 * 只有 models.json 时把它读进来写到 yml（omp 在已有 yml 时不再迁移 json）。
 */
function applyOmpGateway(agentDirPath, { patch = {}, modelIds } = {}) {
  const ids = modelIds?.length ? modelIds : modelIdsFromPatch(patch);
  const modelsFilePath = ompModelsPath(agentDirPath);
  const configFile = ompConfigPath(agentDirPath);
  const createdModels = !fs.existsSync(modelsFilePath);
  let models = readYaml(modelsFilePath);
  if (models == null) {
    const legacy = path.join(agentDirPath, 'models.json');
    models = fs.existsSync(legacy) ? (readJson(legacy) || {}) : {};
  }
  if (!models.providers || typeof models.providers !== 'object' || Array.isArray(models.providers)) {
    models.providers = {};
  }
  const previousProvider = models.providers[PROVIDER_ID];
  models.providers[PROVIDER_ID] = providerFromPatch(patch, ids);
  writeYaml(modelsFilePath, models);

  const createdConfig = !fs.existsSync(configFile);
  const config = readYaml(configFile) || {};
  const roles = config.modelRoles && typeof config.modelRoles === 'object' && !Array.isArray(config.modelRoles)
    ? config.modelRoles
    : null;
  const stateFile = path.join(agentDirPath, STATE_NAME);
  if (!fs.existsSync(stateFile)) {
    writeJson(stateFile, {
      createdModels,
      createdConfig,
      hadProvider: previousProvider != null,
      provider: previousProvider ?? null,
      hadDefaultRole: !!(roles && Object.prototype.hasOwnProperty.call(roles, 'default')),
      defaultRole: roles ? (roles.default ?? null) : null,
    });
  }

  if (ids[0]) {
    if (!config.modelRoles || typeof config.modelRoles !== 'object' || Array.isArray(config.modelRoles)) {
      config.modelRoles = {};
    }
    const ref = `${PROVIDER_ID}/${ids[0]}`;
    config.modelRoles.default = ref;
    if (Array.isArray(config.enabledModels) && config.enabledModels.length && !scopeTakes(config.enabledModels, ref)) {
      config.enabledModels = [...config.enabledModels, ref];
    }
    writeYaml(configFile, config);
  }

  return { ok: true, modelsFile: modelsFilePath, settingsFile: configFile, modelIds: ids };
}

function revertOmpGateway(agentDirPath) {
  if (!agentDirPath) return { ok: false };
  const stateFile = path.join(agentDirPath, STATE_NAME);
  const state = readJson(stateFile);
  const modelsFilePath = ompModelsPath(agentDirPath);
  if (fs.existsSync(modelsFilePath)) {
    const models = readYaml(modelsFilePath) || {};
    if (models.providers && (models.providers[PROVIDER_ID] || state?.hadProvider)) {
      if (state?.hadProvider) models.providers[PROVIDER_ID] = state.provider;
      else delete models.providers[PROVIDER_ID];
      const providerCount = Object.keys(models.providers).length;
      const onlyProviders = Object.keys(models).every((k) => k === 'providers');
      if (state?.createdModels && providerCount === 0 && onlyProviders) {
        try { fs.unlinkSync(modelsFilePath); } catch { /* ignore */ }
      } else {
        writeYaml(modelsFilePath, models);
      }
    }
  }

  const configFile = ompConfigPath(agentDirPath);
  if (fs.existsSync(configFile) && state) {
    const config = readYaml(configFile) || {};
    if (!config.modelRoles || typeof config.modelRoles !== 'object' || Array.isArray(config.modelRoles)) {
      config.modelRoles = {};
    }
    if (state.hadDefaultRole) config.modelRoles.default = state.defaultRole;
    else delete config.modelRoles.default;
    if (!Object.keys(config.modelRoles).length) delete config.modelRoles;
    if (Array.isArray(config.enabledModels)) {
      config.enabledModels = config.enabledModels.filter((p) => !String(p).startsWith(`${PROVIDER_ID}/`));
      if (!config.enabledModels.length) delete config.enabledModels;
    }
    if (state.createdConfig && Object.keys(config).length === 0) {
      try { fs.unlinkSync(configFile); } catch { /* ignore */ }
    } else {
      writeYaml(configFile, config);
    }
  }

  try { fs.unlinkSync(stateFile); } catch { /* ignore */ }
  return { ok: true };
}

function applyFamily(profile, opts) {
  if (!profile) return { ok: false };
  if (profile.kind === 'yaml') return applyOmpGateway(agentDir(profile), opts);
  return applyPiGateway(modelsFile(profile), { ...opts, touchAllowedModels: !!profile.touchAllowedModels });
}

function revertFamily(profile) {
  if (!profile) return { ok: false };
  if (profile.kind === 'yaml') return revertOmpGateway(agentDir(profile));
  return revertPiGateway(modelsFile(profile));
}

module.exports = {
  PROVIDER_ID,
  FAMILY,
  applyPiGateway,
  revertPiGateway,
  applyOmpGateway,
  revertOmpGateway,
  applyFamily,
  revertFamily,
  piAgentReady,
  familyReady,
  defaultAgentDir,
  agentDir,
  modelsFile,
  sessionRootOverride,
  modelIdsFromPatch,
  profileForHandler,
  profileForEntity,
};
