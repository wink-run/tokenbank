'use strict';
// Docker/CLI 与桌面共用的 shim key 解析与 Claude settings 引导
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  resolveShimAppApiKeyForTool,
  installShimLinkerResolvers,
  syncShimClaudeEndpointConfig,
} = require('../../shared/shim-linker-bootstrap');
const { buildGatewayEnv, setKeyResolver } = require('../agent-linker');
const { PROXY_MANAGED_TOKEN } = require('../cli-endpoint-config');

const APPS = [
  {
    id: 'app-shim-claude-code',
    link_method: 'shim',
    agent_id: 'claude-code',
    hosted: true,
    route_id: 'deepseek-v4.1-flash',
    api_key: 'sk-local-test-41-chars-xxxxxxxxxxxxxxxx',
  },
  {
    id: 'app-shim-claude-noroute',
    link_method: 'shim',
    agent_id: 'claude-code',
    hosted: true,
    route_id: null,
    api_key: 'sk-local-unused',
  },
];

test('resolveShimAppApiKeyForTool: 已托管且绑路由才返回 key', () => {
  assert.equal(resolveShimAppApiKeyForTool(APPS, 'claude-code'), APPS[0].api_key);
  assert.equal(resolveShimAppApiKeyForTool(APPS, 'codex'), null);
  const noRoute = [{ ...APPS[0], route_id: null, route_ids: [] }];
  assert.equal(resolveShimAppApiKeyForTool(noRoute, 'claude-code'), null);
  const unhosted = [{ ...APPS[0], hosted: false }];
  assert.equal(resolveShimAppApiKeyForTool(unhosted, 'claude-code'), null);
});

test('installShimLinkerResolvers: buildGatewayEnv 注入 AUTH_TOKEN', () => {
  setKeyResolver(null);
  try {
    const envBefore = buildGatewayEnv('claude-code');
    assert.equal(envBefore.ANTHROPIC_AUTH_TOKEN, undefined);

    installShimLinkerResolvers(() => ({ apps: APPS }));
    const envAfter = buildGatewayEnv('claude-code');
    assert.equal(envAfter.ANTHROPIC_AUTH_TOKEN, APPS[0].api_key);
    assert.ok(envAfter.ANTHROPIC_BASE_URL);
  } finally {
    setKeyResolver(null);
  }
});

test('syncShimClaudeEndpointConfig: 无 instance 写入 ~/.claude/settings.json', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-bootstrap-'));
  const prev = process.env.HOME;
  process.env.HOME = home;
  const GW = 'http://127.0.0.1:11430';
  try {
    const app = { ...APPS[0] };
    delete app.instance;
    assert.equal(syncShimClaudeEndpointConfig(app, {
      gatewayOrigin: GW,
      expandHome: (p) => String(p).replace(/^~(?=$|[/\\])/, home),
    }), 'routed');
    const settings = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
    assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN, PROXY_MANAGED_TOKEN);
    assert.equal(settings.env.ANTHROPIC_BASE_URL, GW);
  } finally {
    if (prev === undefined) delete process.env.HOME;
    else process.env.HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
    setKeyResolver(null);
  }
});
