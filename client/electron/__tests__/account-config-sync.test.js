'use strict';
// 跨终端账户配置合并：本机同 id 优先，只补对方多出来的账户和模型，凭证不上报。
const { test } = require('node:test');
const assert = require('node:assert');
const {
  buildAccountsConfig,
  mergeRemoteAccountConfigs,
  mergeGatewayProviders,
} = require('../../shared/account-config-sync');

test('buildAccountsConfig 去掉 key，并带上网关 base_url', () => {
  const cfg = buildAccountsConfig({
    user_payg_providers: [{ id: 'a1', provider_id: 'deepseek', models: ['deepseek-v4-flash'], token: 'sk-secret' }],
    user_subscriptions: [],
  }, [
    { id: 'deepseek', type: 'paid', token: 'sk-live', base_url: 'https://api.deepseek.com', models: [{ name: 'deepseek-v4-flash' }] },
    { id: 'unrelated', type: 'paid', token: 'sk-other', base_url: 'https://example.com' },
    { id: 'p2p', type: 'p2p', token: 'nope' },
  ]);
  assert.equal(cfg.user_payg_providers[0].token, undefined);
  assert.equal(cfg.user_payg_providers[0].models[0], 'deepseek-v4-flash');
  assert.equal(cfg.gateway_providers.length, 1);
  assert.equal(cfg.gateway_providers[0].base_url, 'https://api.deepseek.com');
  assert.equal(cfg.gateway_providers[0].token, undefined);
});

test('merge 追加其他终端独有账户，同 id 只补模型且不覆盖本机', () => {
  const local = {
    user_payg_providers: [{ id: 'a1', provider_id: 'deepseek', models: ['deepseek-v4-flash'], label: '本机' }],
    user_subscriptions: [],
  };
  const remote = {
    user_payg_providers: [
      { id: 'a1', provider_id: 'deepseek', models: ['deepseek-v4-flash', 'deepseek-v4-pro'], label: '对方' },
      { id: 'b2', provider_id: 'glm', models: ['glm-4.7'], label: 'GLM' },
    ],
    user_subscriptions: [{ id: 's1', source_id: 'claude', models: ['claude-sonnet-4-6'], app_name: 'Claude' }],
    direct_source_billing: { cursor: { source_id: 'cursor', mode: 'subscription', name: 'Cursor' } },
  };
  const merged = mergeRemoteAccountConfigs(local, [remote]);
  assert.equal(merged.changed, true);
  const a1 = merged.user_payg_providers.find(p => p.id === 'a1');
  assert.equal(a1.label, '本机');
  assert.deepEqual(a1.models, ['deepseek-v4-flash', 'deepseek-v4-pro']);
  assert.ok(merged.user_payg_providers.some(p => p.id === 'b2'));
  assert.equal(merged.user_subscriptions[0].id, 's1');
  assert.equal(merged.direct_source_billing.cursor.name, 'Cursor');
  assert.equal(merged.count, 4);
});

test('mergeGatewayProviders 不覆盖本机 token，空地址才用对方的', () => {
  const { providers, changed } = mergeGatewayProviders(
    [{ id: 'deepseek', token: 'local-key', base_url: '', models: [] }],
    [[{ id: 'deepseek', token: 'remote-key', base_url: 'https://api.deepseek.com', models: [{ name: 'deepseek-v4-flash' }] },
      { id: 'glm', type: 'paid', base_url: 'https://open.bigmodel.cn', models: ['glm-4.7'] }]],
  );
  assert.equal(changed, true);
  const ds = providers.find(p => p.id === 'deepseek');
  assert.equal(ds.token, 'local-key');
  assert.equal(ds.base_url, 'https://api.deepseek.com');
  assert.equal(ds.models.length, 1);
  const glm = providers.find(p => p.id === 'glm');
  assert.equal(glm.token, '');
  assert.equal(glm.base_url, 'https://open.bigmodel.cn');
});

test('没有可合并项时 changed 为 false', () => {
  const local = { user_payg_providers: [{ id: 'a1', models: ['m'] }] };
  const merged = mergeRemoteAccountConfigs(local, [{ user_payg_providers: [{ id: 'a1', models: ['m'] }] }]);
  assert.equal(merged.changed, false);
  assert.equal(merged.count, 0);
});
