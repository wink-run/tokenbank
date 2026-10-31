'use strict';

// Pi 纳管：合并 models.json，不覆盖用户已有提供商；还原只撤回 tokenbank。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const pi = require('../pi-config');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pi-cfg-'));
}

test('applyPiGateway merges tokenbank and keeps other providers', () => {
  const dir = tmpDir();
  const modelsFile = path.join(dir, 'models.json');
  fs.writeFileSync(modelsFile, JSON.stringify({
    providers: { ollama: { baseUrl: 'http://127.0.0.1:11434/v1', api: 'openai-completions' } },
  }));
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({
    defaultProvider: 'ollama',
    defaultModel: 'qwen',
    enabledModels: ['ollama/qwen'],
    theme: 'dark',
  }));

  pi.applyPiGateway(modelsFile, {
    patch: {
      'providers.tokenbank.baseUrl': 'http://127.0.0.1:11430/v1',
      'providers.tokenbank.apiKey': 'tb-key',
      'providers.tokenbank.models': [{ id: 'deepseek-v4-flash' }],
    },
  });

  const models = JSON.parse(fs.readFileSync(modelsFile, 'utf8'));
  assert.equal(models.providers.ollama.baseUrl, 'http://127.0.0.1:11434/v1');
  assert.equal(models.providers.tokenbank.baseUrl, 'http://127.0.0.1:11430/v1');
  assert.equal(models.providers.tokenbank.apiKey, 'tb-key');
  assert.equal(models.providers.tokenbank.authHeader, true);
  assert.deepEqual(models.providers.tokenbank.models, [{ id: 'deepseek-v4-flash' }]);

  const settings = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
  assert.equal(settings.defaultProvider, 'tokenbank');
  assert.equal(settings.defaultModel, 'deepseek-v4-flash');
  assert.deepEqual(settings.enabledModels, ['ollama/qwen', 'tokenbank/deepseek-v4-flash']);
  assert.equal(settings.theme, 'dark');
});

test('revertPiGateway restores the previous default and drops only tokenbank', () => {
  const dir = tmpDir();
  const modelsFile = path.join(dir, 'models.json');
  fs.writeFileSync(modelsFile, JSON.stringify({
    providers: { anthropic: { baseUrl: 'https://api.anthropic.com' } },
  }));
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({
    defaultProvider: 'anthropic',
    defaultModel: 'claude-sonnet',
    enabledModels: ['anthropic/*'],
  }));

  pi.applyPiGateway(modelsFile, {
    patch: {
      'providers.tokenbank.baseUrl': 'http://127.0.0.1:11430/v1',
      'providers.tokenbank.apiKey': 'tb-key',
      'providers.tokenbank.models': [{ id: 'gpt-5' }],
    },
  });
  pi.revertPiGateway(modelsFile);

  const models = JSON.parse(fs.readFileSync(modelsFile, 'utf8'));
  assert.equal(models.providers.tokenbank, undefined);
  assert.ok(models.providers.anthropic);

  const settings = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
  assert.equal(settings.defaultProvider, 'anthropic');
  assert.equal(settings.defaultModel, 'claude-sonnet');
  assert.deepEqual(settings.enabledModels, ['anthropic/*']);
  assert.equal(fs.existsSync(path.join(dir, '.tokenbank-pi.json')), false);
});

test('revert restores a tokenbank provider the user already had', () => {
  const dir = tmpDir();
  const modelsFile = path.join(dir, 'models.json');
  fs.writeFileSync(modelsFile, JSON.stringify({
    providers: { tokenbank: { baseUrl: 'http://old.example/v1', api: 'openai-completions', models: [{ id: 'mine' }] } },
  }));
  pi.applyPiGateway(modelsFile, {
    patch: {
      'providers.tokenbank.baseUrl': 'http://127.0.0.1:11430/v1',
      'providers.tokenbank.models': [{ id: 'gw' }],
    },
  });
  pi.revertPiGateway(modelsFile);
  const models = JSON.parse(fs.readFileSync(modelsFile, 'utf8'));
  assert.equal(models.providers.tokenbank.baseUrl, 'http://old.example/v1');
  assert.deepEqual(models.providers.tokenbank.models, [{ id: 'mine' }]);
});

test('Prime allowedModels 白名单会补上所选模型，还原后回到原列表', () => {
  const dir = tmpDir();
  const modelsFile = path.join(dir, 'models.json');
  fs.writeFileSync(modelsFile, JSON.stringify({ providers: {} }));
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({
    allowedModels: ['claude'],
  }));
  pi.applyPiGateway(modelsFile, {
    touchAllowedModels: true,
    patch: {
      'providers.tokenbank.baseUrl': 'http://127.0.0.1:11430/v1',
      'providers.tokenbank.apiKey': 'tb-key',
      'providers.tokenbank.models': [{ id: 'deepseek-v4-flash' }],
    },
  });
  const settings = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
  assert.deepEqual(settings.allowedModels, ['claude', 'deepseek-v4-flash']);
  pi.revertPiGateway(modelsFile);
  const restored = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
  assert.deepEqual(restored.allowedModels, ['claude']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('omp 写入 models.yml 和 modelRoles.default，还原只撤回 tokenbank', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'models.yml'), [
    'providers:',
    '  ollama:',
    '    baseUrl: http://127.0.0.1:11434/v1',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'config.yml'), [
    'theme: dark',
    'modelRoles:',
    '  default: ollama/qwen',
    '  smol: ollama/tiny',
    'enabledModels:',
    '  - ollama/qwen',
    '',
  ].join('\n'));
  pi.applyOmpGateway(dir, {
    patch: {
      'providers.tokenbank.baseUrl': 'http://127.0.0.1:11430/v1',
      'providers.tokenbank.apiKey': 'tb-key',
      'providers.tokenbank.models': [{ id: 'deepseek-v4-flash' }],
    },
  });
  const yaml = require('js-yaml');
  const models = yaml.load(fs.readFileSync(path.join(dir, 'models.yml'), 'utf8'));
  const config = yaml.load(fs.readFileSync(path.join(dir, 'config.yml'), 'utf8'));
  assert.equal(models.providers.ollama.baseUrl, 'http://127.0.0.1:11434/v1');
  assert.equal(models.providers.tokenbank.apiKey, 'tb-key');
  assert.equal(config.modelRoles.default, 'tokenbank/deepseek-v4-flash');
  assert.equal(config.modelRoles.smol, 'ollama/tiny');
  assert.equal(config.theme, 'dark');
  assert.ok(config.enabledModels.includes('tokenbank/deepseek-v4-flash'));
  pi.revertOmpGateway(dir);
  const models2 = yaml.load(fs.readFileSync(path.join(dir, 'models.yml'), 'utf8'));
  const config2 = yaml.load(fs.readFileSync(path.join(dir, 'config.yml'), 'utf8'));
  assert.equal(models2.providers.tokenbank, undefined);
  assert.equal(models2.providers.ollama.baseUrl, 'http://127.0.0.1:11434/v1');
  assert.equal(config2.modelRoles.default, 'ollama/qwen');
  assert.equal(config2.modelRoles.smol, 'ollama/tiny');
  assert.deepEqual(config2.enabledModels, ['ollama/qwen']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('revert removes a models.json that takeover created', () => {
  const dir = tmpDir();
  const modelsFile = path.join(dir, 'models.json');
  pi.applyPiGateway(modelsFile, {
    patch: {
      'providers.tokenbank.baseUrl': 'http://127.0.0.1:11430/v1',
      'providers.tokenbank.models': [{ id: 'm1' }],
    },
  });
  assert.equal(fs.existsSync(modelsFile), true);
  pi.revertPiGateway(modelsFile);
  assert.equal(fs.existsSync(modelsFile), false);
  assert.equal(fs.existsSync(path.join(dir, 'settings.json')), false);
});
