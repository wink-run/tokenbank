'use strict';
// Docker / 网页版：给 Claude Code 选的模型要真的生效——绑到它会发的所有 claude-* 名上，外加兜底
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-docker-cc-'));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.LLM_AGENT_CONFIG_DIR = path.join(HOME, '.llm-agent');

test('Claude Code 选了 glm-5.3：claude-opus-5-5 这种新名字也走 glm-5.3', () => {
  const admin = require('../admin-api');
  const calls = {};
  const gw = new Proxy({}, { get: (_t, k) => (...args) => { calls[k] = args[0]; } });
  admin._syncGatewayForTests({
    scene_routes: [],
    apps: [{ id: 'claude-code', name: 'Claude Code', link_method: 'shim', agent_id: 'claude-code', route_id: 'glm-5.3', api_key: 'sk-app-cc' }],
  }, gw);
  assert.ok(calls.setClaudeShimScene, '没 app key 时（claude 用自己的登录）按 shim 绑定');
  assert.equal(calls.setClaudeShimScene.steps[0].model, 'glm-5.3');
  const bucket = calls.setKeySceneMap['sk-app-cc'];
  assert.ok(bucket && bucket['*'], '带 app key 时有 * 兜底，列表外的新名字也命中');
  assert.equal(bucket['*'].steps[0].model, 'glm-5.3');
  assert.ok(calls.setAppControls.some((c) => c.match?.key === 'sk-app-cc'));
});
