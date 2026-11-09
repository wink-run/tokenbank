'use strict';
// direct_source_billing 是直连订阅的登记处。启动清理不能因为它不在
// user_subscriptions / 按量账户里，就把对应供给源关掉并清空模型。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const billing = require('../billing-config');

const FABLE = [
  { name: 'claude-fable-5', type: 'chat' },
  { name: 'claude-fable-5-1', type: 'chat' },
];

function claudeBilling() {
  return {
    'claude-code': {
      mode: 'subscription',
      source_id: 'claude',
      name: 'Claude',
      plan_id: 'claude-pro',
      monthly_usd: 20,
    },
  };
}

test('migrateAgentProviders 保留直连 Claude 订阅源及其模型', () => {
  const cfg = {
    user_subscriptions: [],
    user_payg_providers: [],
    direct_source_billing: claudeBilling(),
    providers: [
      { id: 'anthropic-paid', type: 'paid', enabled: true, models: FABLE },
      { id: 'claude-pro-1', type: 'paid', enabled: true, auth_type: 'oauth', oauth_provider: 'claude', models: FABLE },
      { id: 'deepseek', type: 'paid', enabled: true, models: [{ name: 'deepseek-v4-flash' }] },
    ],
  };
  const { cfg: next, changed } = billing.migrateAgentProviders(cfg);
  assert.equal(changed, true);
  const byId = Object.fromEntries(next.providers.map(p => [p.id, p]));
  assert.equal(byId['anthropic-paid'].enabled, true);
  assert.deepEqual(byId['anthropic-paid'].models, FABLE);
  assert.equal(byId['claude-pro-1'].enabled, true);
  assert.deepEqual(byId['claude-pro-1'].models, FABLE);
  assert.equal(byId.deepseek.enabled, false);
  assert.deepEqual(byId.deepseek.models, []);
  assert.equal(next.direct_source_billing['claude-code'].name, 'Claude');
});

test('条目上的 gateway_id 保住自建供给源，无关的 custom 源仍删除', () => {
  const cfg = {
    direct_source_billing: {
      'claude-code': { source_id: 'claude', gateway_id: 'custom-claude', mode: 'subscription' },
    },
    providers: [
      { id: 'custom-claude', type: 'paid', enabled: true, models: FABLE },
      { id: 'custom-orphan', type: 'paid', enabled: true, models: [{ name: 'orphan' }] },
    ],
  };
  const { cfg: next } = billing.migrateAgentProviders(cfg);
  assert.deepEqual(next.providers.map(p => p.id), ['custom-claude']);
  assert.equal(next.providers[0].enabled, true);
  assert.deepEqual(next.providers[0].models, FABLE);
});

test('没有直连计费时，已启用但不在个人页的付费源仍会被关掉', () => {
  const cfg = {
    direct_source_billing: {},
    providers: [
      { id: 'anthropic-paid', type: 'paid', enabled: true, oauth_provider: 'claude', models: FABLE },
    ],
  };
  const { cfg: next, changed } = billing.migrateAgentProviders(cfg);
  assert.equal(changed, true);
  assert.equal(next.providers[0].enabled, false);
  assert.deepEqual(next.providers[0].models, []);
});

test('prune 保留直连计费、其供给源模型和目录外的对应订阅', () => {
  const billingEntry = {
    ...claudeBilling()['claude-code'],
    pricing: { 'claude-fable-5': { in: 10, out: 50 } },
  };
  const cfg = {
    direct_source_billing: { 'claude-code': billingEntry, cursor: { source_id: 'cursor', mode: 'subscription', name: 'Cursor' } },
    user_subscriptions: [
      { id: 'ghost', source_id: 'not-in-catalog', app_name: 'Ghost', models: ['ghost-model'] },
      { id: 'kept', source_id: 'private-claude', agent_id: 'my-claude', models: ['claude-fable-5'] },
    ],
    user_payg_providers: [],
    providers: [
      { id: 'anthropic-paid', type: 'paid', enabled: true, models: FABLE.map(m => ({ ...m })) },
    ],
  };
  cfg.direct_source_billing['my-claude'] = { source_id: 'private-claude', mode: 'subscription', name: 'Private' };
  const before = structuredClone(cfg.direct_source_billing);
  const { cfg: next } = billing.pruneLocalBillingAgainstServer(cfg);
  assert.deepEqual(next.direct_source_billing, before);
  const claude = next.providers.find(p => p.id === 'anthropic-paid');
  assert.equal(claude.enabled, true);
  assert.deepEqual(claude.models.map(m => m.name), ['claude-fable-5', 'claude-fable-5-1']);
  assert.deepEqual(next.user_subscriptions.map(s => s.id), ['kept']);
  assert.deepEqual(next.user_subscriptions[0].models, ['claude-fable-5']);
});

test('内存订阅目录里的 plan_provider_id 也算直连源', () => {
  billing.setLiveCatalogPayload({
    providers: [],
    subscription_sources: [{
      id: 'acme',
      kind: 'app_sub',
      agent_id: 'acme-app',
      plan_provider_id: 'acme-paid',
    }],
  });
  try {
    const cfg = {
      direct_source_billing: { 'acme-app': { source_id: 'acme', mode: 'subscription' } },
      providers: [
        { id: 'acme-paid', type: 'paid', enabled: true, models: [{ name: 'acme-1' }] },
        { id: 'other-paid', type: 'paid', enabled: true, models: [{ name: 'other' }] },
      ],
    };
    const { cfg: next } = billing.migrateAgentProviders(cfg);
    const byId = Object.fromEntries(next.providers.map(p => [p.id, p]));
    assert.equal(byId['acme-paid'].enabled, true);
    assert.deepEqual(byId['acme-paid'].models, [{ name: 'acme-1' }]);
    assert.equal(byId['other-paid'].enabled, false);
    assert.deepEqual(byId['other-paid'].models, []);
  } finally {
    billing.setLiveCatalogPayload({ providers: [], subscription_sources: [] });
  }
});
