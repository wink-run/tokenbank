'use strict';
// Claude Code settings.json 托管：选路由→写 PROXY_MANAGED + 网关；直连/还原→还原原始配置。
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  syncCliInstanceEndpointConfig, isGatewayBaseUrl, PROXY_MANAGED_TOKEN,
} = require('../cli-endpoint-config');

const GW = 'http://127.0.0.1:11430';
const OPTS = { expandHome: (p) => p, gatewayOrigin: GW };

function mkInstance(settings) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-endpoint-'));
  if (settings) fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(settings, null, 2));
  return dir;
}
const rd = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const FORTINET = {
  env: {
    ANTHROPIC_AUTH_TOKEN: 'sk-orig',
    ANTHROPIC_BASE_URL: 'https://nac-ai-dev.fortinet-us.com/',
    ANTHROPIC_SMALL_FAST_MODEL: 'forti-coder',
    DISABLE_TELEMETRY: 'true',
  },
  model: 'forti-coder',
  theme: 'dark',
};
const appFor = (dir, extra = {}) => ({
  link_method: 'shim', agent_id: 'claude-code', api_key: 'sk-local-abc',
  hosted: true, route_id: 'p2p:minimax-m3', instance: { config_dir: dir }, ...extra,
});

test('选路由：改写 settings.json 为 PROXY_MANAGED + 网关，备份保留原始 Fortinet', () => {
  const dir = mkInstance(FORTINET);
  const file = path.join(dir, 'settings.json');
  const bak = file + '.tokenbank-bak';
  assert.equal(syncCliInstanceEndpointConfig(appFor(dir), OPTS), 'routed');
  const s = rd(file);
  assert.equal(s.env.ANTHROPIC_BASE_URL, GW);
  assert.equal(s.env.ANTHROPIC_AUTH_TOKEN, PROXY_MANAGED_TOKEN);
  // 整段替换：env 只剩网关两项，原兼容端点的任何 env 键都不残留
  assert.deepEqual(Object.keys(s.env).sort(), ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL']);
  assert.ok(!('ANTHROPIC_SMALL_FAST_MODEL' in s.env), '去掉写死的 fast model');
  assert.ok(!('DISABLE_TELEMETRY' in s.env), '原 env 其它键也不保留');
  assert.ok(!('model' in s), '去掉写死的 model（路由由网关决定）');
  assert.equal(s.theme, 'dark', '顶层非 env 键保留');
  assert.ok(fs.existsSync(bak));
  assert.match(rd(bak).env.ANTHROPIC_BASE_URL, /fortinet/);
  assert.equal(rd(bak).env.ANTHROPIC_AUTH_TOKEN, 'sk-orig');
  assert.equal(rd(bak).env.DISABLE_TELEMETRY, 'true', '备份保留原始完整 env');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('幂等：再次选路由不会把网关配置当作原始配置备份', () => {
  const dir = mkInstance(FORTINET);
  const bak = path.join(dir, 'settings.json.tokenbank-bak');
  syncCliInstanceEndpointConfig(appFor(dir), OPTS);
  syncCliInstanceEndpointConfig(appFor(dir), OPTS);
  assert.match(rd(bak).env.ANTHROPIC_BASE_URL, /fortinet/, '备份仍是 Fortinet');
  assert.equal(rd(path.join(dir, 'settings.json')).env.ANTHROPIC_AUTH_TOKEN, PROXY_MANAGED_TOKEN);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('直连（route 清空，hosted 仍 true）：还原回原始 Fortinet 配置', () => {
  const dir = mkInstance(FORTINET);
  const file = path.join(dir, 'settings.json');
  syncCliInstanceEndpointConfig(appFor(dir), OPTS);                       // 先托管
  const r = syncCliInstanceEndpointConfig(appFor(dir, { route_id: null, route_ids: null }), OPTS);
  assert.equal(r, 'direct');
  const s = rd(file);
  assert.match(s.env.ANTHROPIC_BASE_URL, /fortinet/);
  assert.equal(s.env.ANTHROPIC_AUTH_TOKEN, 'sk-orig');
  assert.equal(s.env.DISABLE_TELEMETRY, 'true', '还原后原 env 键完整回来');
  assert.equal(s.model, 'forti-coder');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('forceDirect（取消托管/退出）：即便记录里仍有 route 也强制还原', () => {
  const dir = mkInstance(FORTINET);
  const file = path.join(dir, 'settings.json');
  syncCliInstanceEndpointConfig(appFor(dir), OPTS);
  const r = syncCliInstanceEndpointConfig(appFor(dir), { ...OPTS, forceDirect: true });
  assert.equal(r, 'direct');
  assert.match(rd(file).env.ANTHROPIC_BASE_URL, /fortinet/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('OAuth 实例（无自定义 base_url）：选路由也写入 PROXY_MANAGED，占住 settings', () => {
  const dir = mkInstance({ theme: 'dark' });
  const file = path.join(dir, 'settings.json');
  assert.equal(syncCliInstanceEndpointConfig(appFor(dir), OPTS), 'routed');
  const s = rd(file);
  assert.equal(s.env.ANTHROPIC_BASE_URL, GW);
  assert.equal(s.env.ANTHROPIC_AUTH_TOKEN, PROXY_MANAGED_TOKEN);
  assert.equal(s.theme, 'dark');
  assert.ok(fs.existsSync(file + '.tokenbank-bak'), '原 settings 应备份');
  assert.equal(rd(file + '.tokenbank-bak').theme, 'dark');
  // 直连：还原备份
  assert.equal(syncCliInstanceEndpointConfig(appFor(dir, { route_id: null }), OPTS), 'direct');
  assert.ok(!rd(file).env, '还原后无托管 env');
  assert.equal(rd(file).theme, 'dark');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('无 settings.json 的实例：选路由新建托管配置；还原则删除空文件', () => {
  const dir = mkInstance(null);
  const file = path.join(dir, 'settings.json');
  assert.equal(syncCliInstanceEndpointConfig(appFor(dir), OPTS), 'routed');
  assert.deepEqual(rd(file).env, {
    ANTHROPIC_AUTH_TOKEN: PROXY_MANAGED_TOKEN,
    ANTHROPIC_BASE_URL: GW,
  });
  assert.ok(!fs.existsSync(file + '.tokenbank-bak'), '原本无文件则无备份');
  assert.equal(syncCliInstanceEndpointConfig(appFor(dir), { ...OPTS, forceDirect: true }), 'direct');
  assert.ok(!fs.existsSync(file), '清空托管键后空对象应删文件');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('其他代理改写 base_url 后再次 sync：重新占回网关', () => {
  const dir = mkInstance(FORTINET);
  const file = path.join(dir, 'settings.json');
  syncCliInstanceEndpointConfig(appFor(dir), OPTS);
  // 模拟其他代理改写
  fs.writeFileSync(file, JSON.stringify({
    env: { ANTHROPIC_BASE_URL: 'https://other-proxy.example/', ANTHROPIC_AUTH_TOKEN: 'sk-other' },
  }, null, 2));
  assert.equal(syncCliInstanceEndpointConfig(appFor(dir), OPTS), 'routed');
  const s = rd(file);
  assert.equal(s.env.ANTHROPIC_BASE_URL, GW);
  assert.equal(s.env.ANTHROPIC_AUTH_TOKEN, PROXY_MANAGED_TOKEN);
  // bak 仍是首次 Fortinet，不被其他代理配置污染
  assert.match(rd(file + '.tokenbank-bak').env.ANTHROPIC_BASE_URL, /fortinet/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('无 instance：默认写入 HOME/.claude/settings.json（Docker 单实例）', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-claude-home-'));
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const app = {
      link_method: 'shim', agent_id: 'claude-code', api_key: 'sk-local-abc',
      hosted: true, route_id: 'p2p:minimax-m3',
    };
    const expandHome = (p) => String(p).replace(/^~(?=$|[/\\])/, home);
    const file = path.join(home, '.claude', 'settings.json');
    assert.equal(syncCliInstanceEndpointConfig(app, { ...OPTS, expandHome }), 'routed');
    assert.ok(fs.existsSync(file));
    assert.equal(rd(file).env.ANTHROPIC_AUTH_TOKEN, PROXY_MANAGED_TOKEN);
    assert.equal(rd(file).env.ANTHROPIC_BASE_URL, GW);
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('未托管或无路由：不写默认 settings', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-claude-skip-'));
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const expandHome = (p) => String(p).replace(/^~(?=$|[/\\])/, home);
    const file = path.join(home, '.claude', 'settings.json');
    assert.equal(syncCliInstanceEndpointConfig({
      link_method: 'shim', agent_id: 'claude-code', hosted: false, route_id: 'r1',
    }, { ...OPTS, expandHome }), 'skip');
    assert.equal(syncCliInstanceEndpointConfig({
      link_method: 'shim', agent_id: 'claude-code', hosted: true, route_id: null,
    }, { ...OPTS, expandHome }), 'skip');
    assert.ok(!fs.existsSync(file));
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('非 claude-code agent：跳过', () => {
  const dir = mkInstance(FORTINET);
  assert.equal(syncCliInstanceEndpointConfig(appFor(dir, { agent_id: 'codex' }), OPTS), 'skip');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('isGatewayBaseUrl 判定', () => {
  assert.ok(isGatewayBaseUrl('http://127.0.0.1:11430'));
  assert.ok(isGatewayBaseUrl('http://localhost:11430/'));
  assert.ok(!isGatewayBaseUrl('https://nac-ai-dev.fortinet-us.com/'));
  assert.ok(!isGatewayBaseUrl(''));
});
