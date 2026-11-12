'use strict';
// 桌面版与 Docker 共用的 config-file 写入路径：Pi/DSH/OpenClaw/WorkBuddy 等
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-cfgwrite-'));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;

const sharedCfgLoader = require('../../shared/config-loader');
const configLoader = require('../config-loader');
const writer = require('../config-file-write');

// 避免真实注册表读取失败：mock 出网关上下文与空配置
const origGatewayCtx = configLoader.gatewayCtx;
configLoader.gatewayCtx = () => ({ reverse: '127.0.0.1:11430' });
const origReadLocalConfig = sharedCfgLoader.readLocalConfig;
sharedCfgLoader.readLocalConfig = () => ({ scene_routes: [], apps: [] });
const origReadAgentConfig = sharedCfgLoader.readAgentConfig;
sharedCfgLoader.readAgentConfig = () => ({ providers: [] });
const origApiKeyApps = configLoader.apiKeyApps;
configLoader.apiKeyApps = () => [];

test.after(() => {
  configLoader.gatewayCtx = origGatewayCtx;
  sharedCfgLoader.readLocalConfig = origReadLocalConfig;
  sharedCfgLoader.readAgentConfig = origReadAgentConfig;
  configLoader.apiKeyApps = origApiKeyApps;
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch {}
});

function makeApp(overrides = {}) {
  return {
    id: 'app-test',
    preset_id: 'workbuddy',
    api_key: 'sk-test',
    route_id: 'paid:deepseek:deepseek-v4.1-flash',
    route_ids: ['paid:deepseek:deepseek-v4.1-flash'],
    config_file: path.join(HOME, '.workbuddy', 'models.json'),
    patch: {
      models: [{ id: 'placeholder', name: 'tokenbank', vendor: 'TokenBank', url: '{BASE}/v1/chat/completions', apiKey: '{KEY}', supportsToolCall: true, supportsImages: true }],
    },
    ...overrides,
  };
}

test('WorkBuddy JSON config-file app writes bound route to models list', async () => {
  const app = makeApp();
  const r = await writer.writeConfigFile({ appRec: app, allowCreate: true });
  assert.equal(r.ok, true, r.error);
  const doc = JSON.parse(fs.readFileSync(r.file, 'utf8'));
  assert.equal(doc.models[0].url, 'http://127.0.0.1:11430/v1/chat/completions');
  assert.equal(doc.models[0].apiKey, 'sk-test');
  assert.equal(doc._configManagedBy, 'tokenbank');
  // patch_route 策略 workbuddy_models 把 route_id 注入 models[].id
  assert.ok(Array.isArray(doc.models), 'models list written');
  assert.equal(doc.models[0].id, 'deepseek-v4.1-flash');
});

test('route change rewrites config with new bound route', async () => {
  const app = makeApp();
  const first = await writer.writeConfigFile({ appRec: app, allowCreate: true });
  assert.equal(first.ok, true, first.error);

  const changed = {
    ...app,
    route_id: 'paid:openai:gpt-5.6-sol',
    route_ids: ['paid:openai:gpt-5.6-sol'],
  };
  const second = await writer.writeConfigFile({ appRec: changed, allowCreate: false });
  assert.equal(second.ok, true, second.error);
  const doc = JSON.parse(fs.readFileSync(second.file, 'utf8'));
  assert.equal(doc.models[0].id, 'gpt-5.6-sol');
});

test('OpenClaw JSON config-file app writes patch and marker', async () => {
  const app = makeApp({
    preset_id: 'openclaw',
    config_file: path.join(HOME, '.openclaw', 'openclaw.json'),
    patch: {
      'models.providers.tokenbank.baseUrl': '{BASE}/v1',
      'models.providers.tokenbank.apiKey': '{KEY}',
      'models.providers.tokenbank.api': 'openai-completions',
    },
  });
  const r = await writer.writeConfigFile({ appRec: app, allowCreate: true });
  assert.equal(r.ok, true, r.error);
  const doc = JSON.parse(fs.readFileSync(r.file, 'utf8'));
  assert.equal(doc.models.providers.tokenbank.baseUrl, 'http://127.0.0.1:11430/v1');
  assert.equal(doc.models.providers.tokenbank.apiKey, 'sk-test');
  assert.equal(doc._configManagedBy, 'tokenbank');
});

test('revert restores original config from backup', async () => {
  const app = makeApp({
    config_file: path.join(HOME, '.workbuddy2', 'models.json'),
  });
  const original = { someUserField: 'keep-me', models: [{ id: 'openai', name: 'OpenAI' }] };
  fs.mkdirSync(path.dirname(app.config_file), { recursive: true });
  fs.writeFileSync(app.config_file, JSON.stringify(original, null, 2), 'utf8');

  const r = await writer.writeConfigFile({ appRec: app, allowCreate: false });
  assert.equal(r.ok, true, r.error);

  const rev = writer.revertConfigFile({ appRec: app });
  assert.equal(rev.ok, true, rev.error);
  const doc = JSON.parse(fs.readFileSync(app.config_file, 'utf8'));
  assert.equal(doc.someUserField, 'keep-me');
});

test('Pi family still writes default model from bound route', async () => {
  const piCfg = require('../pi-config');
  fs.mkdirSync(piCfg.agentDir(piCfg.profileForHandler('pi-cli')), { recursive: true });
  const app = makeApp({
    preset_id: 'pi',
    config_file: piCfg.modelsFile(piCfg.profileForHandler('pi-cli')),
    patch: {
      'providers.tokenbank.name': 'Token Bank',
      'providers.tokenbank.baseUrl': '{BASE}/v1',
      'providers.tokenbank.api': 'openai-completions',
      'providers.tokenbank.apiKey': '{KEY}',
    },
  });
  const r = await writer.writeConfigFile({ appRec: app, allowCreate: true });
  assert.equal(r.ok, true, r.error);
  const settings = JSON.parse(fs.readFileSync(path.join(piCfg.agentDir(piCfg.profileForHandler('pi-cli')), 'settings.json'), 'utf8'));
  assert.equal(settings.defaultProvider, 'tokenbank');
  assert.equal(settings.defaultModel, 'deepseek-v4.1-flash');
});
