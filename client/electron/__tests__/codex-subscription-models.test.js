'use strict';
// Codex ChatGPT OAuth must not advertise the OpenAI pay-as-you-go catalog.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const configLoader = require('../config-loader');
const policy = require('../../shared/codex-subscription-models');
const accountModels = require('../codex-account-models');
const billing = require('../billing-config');

const REGISTRY = {
  version: 1,
  providers: [{
    id: 'openai',
    label: 'OpenAI',
    models: [
      { name: 'gpt-5.4', type: 'chat' },
      { name: 'gpt-5.5', type: 'chat' },
      { name: 'gpt-image-1', type: 'image' },
      { name: 'text-embedding-3-small', type: 'embedding' },
    ],
    pricing: {
      'gpt-5.4': { in: 1, out: 2 },
      'gpt-5.5': { in: 1, out: 2 },
      'gpt-image-1': { image: 1 },
      'text-embedding-3-small': { in: 0.1 },
    },
  }],
  billing_sources: [
    {
      id: 'openai',
      category: 'payg',
      source_id: 'openai',
      label: 'OpenAI',
      models: [
        { id: 'gpt-5.4' },
        { id: 'gpt-5.5' },
        { id: 'gpt-image-1' },
        { id: 'text-embedding-3-small' },
      ],
      pricing: {
        'gpt-5.4': { in: 1, out: 2 },
        'gpt-5.5': { in: 1, out: 2 },
        'gpt-image-1': { image: 1 },
        'text-embedding-3-small': { in: 0.1 },
      },
    },
    {
      id: 'codex',
      category: 'app_sub',
      source_id: 'codex',
      agent_id: 'codex',
      plan_provider_id: 'openai',
      subscription_to_api: true,
      label: 'Codex',
      models: [],
    },
  ],
};

before(() => { configLoader.setRegistryDocForTests(REGISTRY); });
after(() => { configLoader.reloadRegistryDoc(); });

const PAYG = ['gpt-5.4', 'gpt-5.5', 'gpt-image-1', 'text-embedding-3-small'];
const LIVE = ['gpt-6.1-sol', 'gpt-5.6-sol', 'gpt-6-luna'];

function codexSub(extra = {}) {
  return {
    id: 'sub-codex',
    source_id: 'codex',
    subscription_to_api: true,
    gateway_id: 'openai',
    models: PAYG.slice(),
    ...extra,
  };
}

function reset() {
  accountModels.resetCodexModelCache();
}

test('parser keeps visibility=list chat models and drops hidden, image, and embedding', () => {
  const names = policy.parseCodexModelsPayload({
    models: [
      { slug: 'gpt-5.6-sol', visibility: 'list' },
      { slug: 'gpt-6.1-sol', visibility: 'LIST' },
      { slug: 'gpt-reserve', visibility: 'hidden' },
      { slug: 'codex-auto-review', visibility: 'hide' },
      { slug: 'gpt-image-1', visibility: 'list' },
      { slug: 'text-embedding-3-small', visibility: 'list' },
      { slug: 'gpt-5.6-terra', visibility: 'list', modality: 'embedding' },
      { id: 'gpt-6-astra', visibility: 'list' },
      { slug: 'no-visibility' },
    ],
  });
  assert.deepEqual(names, ['gpt-5.6-sol', 'gpt-6.1-sol', 'gpt-6-astra']);
});

test('fetch success caches the listed models; failure falls back to the eight names', async () => {
  reset();
  const seen = [];
  const ok = await accountModels.refreshCodexAccountModels(
    { access_token: 'test-token', account_id: 'acct_test' },
    {
      requestImpl: async (url, headers) => {
        seen.push({ url, headers });
        return {
          status: 200,
          json: {
            models: [
              ...LIVE.map(slug => ({ slug, visibility: 'list' })),
              { slug: 'gpt-reserve', visibility: 'hidden' },
              { slug: 'gpt-image-2', visibility: 'list' },
            ],
          },
        };
      },
    },
  );
  assert.equal(ok.source, 'live');
  assert.deepEqual(ok.names, LIVE);
  assert.deepEqual(accountModels.listedModelNames(), LIVE);
  assert.equal(seen.length, 1);
  assert.match(seen[0].url, /\/backend-api\/codex\/models\?client_version=0\.166\.0$/);
  assert.equal(seen[0].headers.Authorization, 'Bearer test-token');
  assert.equal(seen[0].headers['chatgpt-account-id'], 'acct_test');
  assert.equal(seen[0].headers.originator, 'codex_cli_rs');
  assert.equal(JSON.stringify(seen[0].headers).includes('test-token') ? 'header-only' : 'missing', 'header-only');

  reset();
  const failed = await accountModels.refreshCodexAccountModels(
    { access_token: 'test-token', account_id: 'acct_test' },
    { requestImpl: async () => ({ status: 400, json: { error: 'nope' } }) },
  );
  assert.equal(failed.source, 'fallback');
  assert.equal(failed.error, 'codex models HTTP 400');
  assert.equal(failed.error.includes('test-token'), false);
  assert.deepEqual(failed.names, policy.CODEX_LISTED_MODELS);
  assert.equal(failed.names.includes('gpt-5.4'), false);
  assert.equal(failed.names.includes('gpt-image-1'), false);
  assert.deepEqual(accountModels.listedModelNames(), policy.codexFallbackModelNames());
});

test('Codex subscription model list excludes the pay-as-you-go catalog', () => {
  reset();
  const catalog = billing.paygProviderCatalog().find(p => (p.provider_id || p.id) === 'openai');
  assert.ok(catalog, 'test registry should expose the openai payg catalog');
  assert.ok((catalog.models || []).map(m => (typeof m === 'string' ? m : m.name || m.id)).includes('gpt-5.4'));

  const names = [...billing.collectModelsForGatewayProvider('openai', {
    user_subscriptions: [codexSub()],
    user_payg_providers: [],
    provider_pricing_overrides: { openai: { 'gpt-5.4': { in: 9, out: 9 }, 'gpt-image-1': { image: 1 } } },
  })];
  assert.deepEqual(names.sort(), policy.codexFallbackModelNames().slice().sort());
  for (const banned of PAYG) assert.equal(names.includes(banned), false, banned);
});

test('API-key OpenAI still inherits the pay-as-you-go catalog', () => {
  reset();
  const names = [...billing.collectModelsForGatewayProvider('openai', {
    user_subscriptions: [],
    user_payg_providers: [{ id: 'payg-1', provider_id: 'openai', gateway_id: 'openai', models: ['gpt-5.4'] }],
  })];
  for (const kept of PAYG) assert.equal(names.includes(kept), true, kept);

  const agentCfg = {
    providers: [{
      id: 'openai',
      type: 'paid',
      auth_type: 'api_key',
      token: 'sk-test',
      enabled: true,
      models: [{ name: 'gpt-5.4', type: 'chat' }],
    }],
    model_groups: [{ base_url: 'http://127.0.0.1:11430/v1', token: '', models: ['gpt-5.4', 'gpt-image-1'] }],
  };
  const { cfg, changed } = billing.syncGatewayProvidersFromAccounts(agentCfg, {
    user_subscriptions: [],
    user_payg_providers: [{ id: 'payg-1', provider_id: 'openai', gateway_id: 'openai', models: ['gpt-5.4'] }],
  });
  assert.equal(changed, true);
  const synced = cfg.providers[0].models.map(m => m.name);
  for (const kept of PAYG) assert.equal(synced.includes(kept), true, kept);
  assert.deepEqual(cfg.model_groups[0].models, ['gpt-5.4', 'gpt-image-1']);
});

test('saved contribution names the Codex account cannot serve are removed, not renamed', () => {
  reset();
  const localCfg = {
    user_subscriptions: [codexSub()],
    user_payg_providers: [],
    provider_pricing_overrides: { openai: { 'gpt-5.5': { in: 1, out: 1 } } },
  };
  const agentCfg = {
    providers: [
      {
        id: 'openai',
        type: 'paid',
        auth_type: 'oauth',
        oauth_provider: 'codex',
        enabled: true,
        credentials: { access_token: 'test-token', account_id: 'acct_test' },
        models: [
          { name: 'gpt-5.4', type: 'chat' },
          { name: 'gpt-5.6-sol', type: 'chat' },
          { name: 'gpt-image-1', type: 'image' },
          { name: 'text-embedding-3-small', type: 'embedding' },
        ],
      },
      {
        id: 'anthropic-paid',
        type: 'paid',
        auth_type: 'oauth',
        oauth_provider: 'claude',
        enabled: true,
        models: [{ name: 'claude-fable-5', type: 'chat' }],
      },
    ],
    model_groups: [{
      base_url: 'http://127.0.0.1:11430/v1',
      token: '',
      models: [
        { name: 'gpt-5.4', type: 'chat' },
        'gpt-5.5',
        { name: 'gpt-5.6-sol', type: 'chat' },
        { name: 'gpt-image-1', type: 'image' },
        { name: 'text-embedding-3-small', type: 'embedding' },
        { name: 'claude-fable-5', type: 'chat' },
      ],
    }],
    models: ['gpt-5.4', 'claude-fable-5', 'gpt-5.6-sol'],
  };
  const { cfg, changed } = billing.syncGatewayProvidersFromAccounts(agentCfg, localCfg);
  assert.equal(changed, true);
  assert.deepEqual(
    cfg.providers[0].models.map(m => m.name),
    policy.codexFallbackModelNames(),
  );
  assert.equal(cfg.providers[0].models.some(m => m.type !== 'chat'), false);
  const contributed = cfg.model_groups[0].models.map(m => (typeof m === 'string' ? m : m.name));
  assert.deepEqual(contributed, ['gpt-5.6-sol', 'claude-fable-5']);
  assert.equal(contributed.includes('gpt-5.6-luna'), false, 'unsupported names are dropped, not aliased');
  assert.deepEqual(cfg.models, ['claude-fable-5', 'gpt-5.6-sol']);
  assert.deepEqual(cfg.providers[1].models.map(m => m.name), ['claude-fable-5']);
});

test('a separate API-key provider keeps gpt-5.4 in the contribution list', () => {
  reset();
  const agentCfg = {
    providers: [
      {
        id: 'openai',
        type: 'paid',
        auth_type: 'oauth',
        oauth_provider: 'codex',
        enabled: true,
        models: [{ name: 'gpt-5.4', type: 'chat' }],
      },
      {
        id: 'openai-key',
        type: 'paid',
        auth_type: 'api_key',
        enabled: true,
        models: [{ name: 'gpt-5.4', type: 'chat' }],
      },
    ],
    model_groups: [{ base_url: 'http://127.0.0.1:11430/v1', models: ['gpt-5.4', 'gpt-5.6-sol'] }],
  };
  const { cfg } = billing.syncGatewayProvidersFromAccounts(agentCfg, {
    user_subscriptions: [codexSub()],
    user_payg_providers: [{ id: 'payg-1', provider_id: 'openai', gateway_id: 'openai-key', models: ['gpt-5.4'] }],
  });
  assert.deepEqual(cfg.model_groups[0].models, ['gpt-5.4', 'gpt-5.6-sol']);
  assert.equal(cfg.providers.find(p => p.id === 'openai').models.some(m => m.name === 'gpt-5.4'), false);
  assert.equal(cfg.providers.find(p => p.id === 'openai-key').models.some(m => m.name === 'gpt-5.4'), true);
});
