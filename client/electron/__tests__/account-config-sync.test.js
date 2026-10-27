'use strict';
// 跨终端账户配置合并：本机同 id 优先，只补对方多出来的账户和模型，凭证不上报。
const { test } = require('node:test');
const assert = require('node:assert');
const {
  buildAccountsConfig,
  mergeRemoteAccountConfigs,
  mergeGatewayProviders,
  pickSyncAccountSecrets,
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

test('打开同步密钥后上报 token，合并时只补本机空密钥', () => {
  const cfg = buildAccountsConfig({
    user_payg_providers: [{ id: 'a1', provider_id: 'deepseek', models: ['m'], token: 'sk-acct' }],
  }, [
    { id: 'deepseek', type: 'paid', token: 'sk-live', credentials: { refresh_token: 'r1' }, auth_type: 'oauth', base_url: 'https://api.deepseek.com' },
  ], { includeSecrets: true });
  assert.equal(cfg.user_payg_providers[0].token, 'sk-acct');
  assert.equal(cfg.gateway_providers[0].token, 'sk-live');
  assert.equal(cfg.gateway_providers[0].credentials.refresh_token, 'r1');

  const kept = mergeRemoteAccountConfigs(
    { user_payg_providers: [{ id: 'a1', token: 'local' }] },
    [{ user_payg_providers: [{ id: 'a1', token: 'remote' }] }],
    { includeSecrets: true },
  );
  assert.equal(kept.user_payg_providers[0].token, 'local');

  const filled = mergeRemoteAccountConfigs(
    { user_payg_providers: [{ id: 'a1', models: ['m'] }] },
    [{ user_payg_providers: [{ id: 'a1', models: ['m'], token: 'remote' }] }],
    { includeSecrets: true },
  );
  assert.equal(filled.user_payg_providers[0].token, 'remote');

  const off = mergeGatewayProviders(
    [{ id: 'deepseek', token: '', base_url: 'https://api.deepseek.com', models: [] }],
    [[{ id: 'deepseek', token: 'remote-key', base_url: 'https://api.deepseek.com' }]],
  );
  assert.equal(off.providers.find(p => p.id === 'deepseek').token, '');

  const on = mergeGatewayProviders(
    [{ id: 'deepseek', token: '', base_url: 'https://api.deepseek.com', models: [] }],
    [[{ id: 'deepseek', token: 'remote-key', base_url: 'https://api.deepseek.com' }]],
    { includeSecrets: true },
  );
  assert.equal(on.providers.find(p => p.id === 'deepseek').token, 'remote-key');
  assert.equal(on.changed, true);
});

test('同步进来的供给源默认打开，即使对方是关闭的', () => {
  const added = mergeGatewayProviders([], [[
    { id: 'volcengine-ark', enabled: false, base_url: 'https://ark.cn-beijing.volces.com/api/v3', type: 'paid' },
  ]]);
  assert.equal(added.providers[0].enabled, true);

  const turnedOn = mergeGatewayProviders(
    [{ id: 'volcengine-ark', enabled: false, token: '', base_url: '', models: [] }],
    [[{ id: 'volcengine-ark', base_url: 'https://ark.cn-beijing.volces.com/api/v3' }]],
  );
  assert.equal(turnedOn.providers[0].enabled, true);
  assert.equal(turnedOn.providers[0].base_url, 'https://ark.cn-beijing.volces.com/api/v3');
});

test('没有可合并项时 changed 为 false', () => {
  const local = { user_payg_providers: [{ id: 'a1', models: ['m'] }] };
  const merged = mergeRemoteAccountConfigs(local, [{ user_payg_providers: [{ id: 'a1', models: ['m'] }] }]);
  assert.equal(merged.changed, false);
  assert.equal(merged.count, 0);
});

test('同步密钥开关按较新的修改时间在各终端间对齐', () => {
  const cfg = buildAccountsConfig({ user_payg_providers: [], user_subscriptions: [] }, [], {
    syncAccountSecrets: false,
    syncAccountSecretsAt: 20,
  });
  assert.equal(cfg.sync_account_secrets, false);
  assert.equal(cfg.sync_account_secrets_at, 20);

  // 其它终端更晚关掉：本机即使开着也跟关
  const followOff = pickSyncAccountSecrets(
    { value: true, at: 10 },
    [{ sync_account_secrets: false, sync_account_secrets_at: 30, user_payg_providers: [{ token: 'sk-old' }] }],
  );
  assert.equal(followOff.value, false);
  assert.equal(followOff.at, 30);

  // 没有时间戳的旧上报不能把本机已关闭的开关重新打开
  const keepOff = pickSyncAccountSecrets(
    { value: false, at: 50 },
    [{ sync_account_secrets: true }],
  );
  assert.equal(keepOff.value, false);

  // 本机是关（即便还没有时间戳），其它终端更晚打开也不改成本机打开
  const stayOff = pickSyncAccountSecrets(
    { value: false, at: 0 },
    [{ sync_account_secrets: true, sync_account_secrets_at: 999, user_payg_providers: [{ token: 'sk-remote' }] }],
  );
  assert.equal(stayOff.value, false);

  // 关掉时，即使对方上报里带着密钥，也不写入本机空位
  const merged = mergeRemoteAccountConfigs(
    { user_payg_providers: [{ id: 'a1', provider_id: 'openrouter', token: '' }] },
    [{ user_payg_providers: [{ id: 'a1', provider_id: 'openrouter', token: 'sk-remote' }] }],
    { includeSecrets: false },
  );
  assert.equal(merged.user_payg_providers[0].token, undefined);

  // 对方整行带密钥的新账户，开关关闭时也不写入
  const added = mergeRemoteAccountConfigs(
    { user_payg_providers: [] },
    [{ user_payg_providers: [{ id: 'b2', provider_id: 'openrouter', token: 'sk-new', models: ['m'] }] }],
    { includeSecrets: false },
  );
  assert.equal(added.user_payg_providers[0].token, undefined);
  assert.equal(added.user_payg_providers[0].models[0], 'm');

  const gw = mergeGatewayProviders(
    [{ id: 'openrouter', token: '', base_url: '', models: [] }],
    [[{ id: 'openrouter', token: 'sk-remote', base_url: 'https://openrouter.ai/api/v1' }]],
    { includeSecrets: false },
  );
  assert.equal(gw.providers[0].token, '');
});
