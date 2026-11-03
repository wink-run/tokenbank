'use strict';
// Claude 透明改写标记：不可把 Codex 自指的 claude-* 真实模型误标成 Claude 映射
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { bindClaudeCliRouteToKeyScene, bindRouteToKeyScene } = require('../../shared/route-binding');
const { routeModelId } = require('../app-handlers');
const { resolveBoundScene, expandBoundListRoute, setRouterModelMap } = require('../local-gateway');

/** 与 local-gateway route() 内 claudeFrom 判定一致 */
function resolveClaudeFrom({
  origModel, claudeKey, shimClaudeScene, isApiKeyCaller, isClaudeClientName, callerKey, keyScene,
}) {
  if (shimClaudeScene) return origModel;
  const keyBucket = (isApiKeyCaller && callerKey) ? keyScene[callerKey] : null;
  const slot = keyBucket
    ? ((claudeKey && keyBucket[claudeKey]) || (isClaudeClientName && keyBucket['*']) || null)
    : null;
  if (!slot) return null;
  const target = slot.steps?.[0]?.model || slot.scene_name || '';
  if (target && (target === origModel || (claudeKey && target === claudeKey))) return null;
  return claudeKey || origModel;
}

test('Claude Code：claude-opus → k3 时标记透明映射', () => {
  const keyScene = {};
  const apiKey = 'sk-claude';
  const cms = ['claude-opus-4-8', 'claude-sonnet-4-5'];
  bindClaudeCliRouteToKeyScene(keyScene, apiKey, 'paid:k3', [], cms);

  const origModel = 'claude-opus-4-8';
  const hit = resolveBoundScene({
    origModel, callerKey: apiKey, isApiKeyCaller: true,
    isClaudeClientName: true, claudeKey: origModel, keyScene, codexGptFallback: {},
  });
  assert.equal(hit.steps[0].model, 'k3');
  const from = resolveClaudeFrom({
    origModel, claudeKey: origModel, shimClaudeScene: null,
    isApiKeyCaller: true, isClaudeClientName: true, callerKey: apiKey, keyScene,
  });
  assert.equal(from, 'claude-opus-4-8');
});

test('Codex 自指绑定 claude-opus-4-8：不标记 Claude 透明映射', () => {
  const keyScene = {};
  const apiKey = 'sk-codex';
  const rid = 'paid:claude-opus-4-8';
  const mid = routeModelId(rid, []);
  const sub = keyScene[apiKey] || (keyScene[apiKey] = {});
  bindRouteToKeyScene(sub, mid, rid, []);

  const origModel = 'claude-opus-4-8';
  const hit = resolveBoundScene({
    origModel, callerKey: apiKey, isApiKeyCaller: true,
    isClaudeClientName: true, claudeKey: origModel, keyScene, codexGptFallback: {},
  });
  assert.equal(hit.steps[0].model, 'claude-opus-4-8');
  const from = resolveClaudeFrom({
    origModel, claudeKey: origModel, shimClaudeScene: null,
    isApiKeyCaller: true, isClaudeClientName: true, callerKey: apiKey, keyScene,
  });
  assert.equal(from, null, '自指不得标成 Claude 映射');
});

test('paid/free 前缀：同名走降级链并保留层级，没有链则保持单模型', () => {
  const routes = [{
    id: 'chain1',
    model_key: 'deepseek-v4-flash',
    scene_name: 'deepseek-v4-flash',
    list_route: true,
    flow: 'fallback',
    steps: [
      { model: 'deepseek-v4-flash' },
      { model: 'deepseek-v4-flash-ga-260731', provider: 'volc-payg' },
    ],
  }];
  const keyScene = {};
  bindRouteToKeyScene(keyScene, 'claude-opus-5-5', 'paid:deepseek-v4-flash', routes);
  const scene = keyScene['claude-opus-5-5'];
  assert.equal(scene.steps.length, 2);
  assert.equal(scene.steps[0].model, 'deepseek-v4-flash');
  assert.equal(scene.steps[0].tier, 'paid');
  assert.equal(scene.steps[0].provider, undefined);
  assert.equal(scene.steps[1].provider, 'volc-payg');
  assert.equal(scene.steps[1].tier, 'paid');
  assert.equal(scene.flow, 'fallback');

  // 不同名不借用别的链，层级留在这一步
  const other = {};
  bindRouteToKeyScene(other, 'm', 'paid:deepseek-v4.1-flash', routes);
  assert.equal(other.m.steps.length, 1);
  assert.equal(other.m.steps[0].model, 'deepseek-v4.1-flash');
  assert.equal(other.m.steps[0].tier, 'paid');

  // 没有链的单模型：层级和供给源都留在这一步
  const pinned = {};
  bindRouteToKeyScene(pinned, 's', 'free:volcengine:deepseek-v4-pro', routes);
  assert.equal(pinned.s.steps.length, 1);
  assert.equal(pinned.s.steps[0].model, 'deepseek-v4-pro');
  assert.equal(pinned.s.steps[0].tier, 'free');
  assert.equal(pinned.s.steps[0].provider, 'volcengine');

  // 链头没钉源时，前缀里的供给源只补在链头；后面已钉的源不动
  const headPin = {};
  bindRouteToKeyScene(headPin, 'h', 'paid:volcengine:deepseek-v4-flash', routes);
  assert.equal(headPin.h.steps.length, 2);
  assert.equal(headPin.h.steps[0].provider, 'volcengine');
  assert.equal(headPin.h.steps[0].tier, 'paid');
  assert.equal(headPin.h.steps[1].provider, 'volc-payg');

  // p2p 是社区层，不并进个人源降级链
  const p2p = {};
  bindRouteToKeyScene(p2p, 'p', 'p2p:deepseek-v4-flash', routes);
  assert.equal(p2p.p.steps.length, 1);
  assert.equal(p2p.p.steps[0].model, 'deepseek-v4-flash');
  assert.equal(p2p.p.steps[0].tier, 'p2p');
});

test('paid:模型名 绑定时接上同名降级链', () => {
  const routes = [{
    id: 'chain1',
    model_key: 'deepseek-v4-flash',
    scene_name: 'deepseek-v4-flash',
    list_route: true,
    flow: 'fallback',
    steps: [
      { model: 'deepseek-v4-flash', provider: 'volc' },
      { model: 'deepseek-v4-flash-ga-260731', provider: 'volc-payg' },
    ],
  }];
  const keyScene = {};
  bindRouteToKeyScene(keyScene, 'claude-opus-5-5', 'paid:deepseek-v4-flash', routes);
  const scene = keyScene['claude-opus-5-5'];
  assert.equal(scene.steps.length, 2);
  assert.equal(scene.steps[0].provider, 'volc');
  assert.equal(scene.steps[0].tier, 'paid');
  assert.equal(scene.steps[1].model, 'deepseek-v4-flash-ga-260731');
  assert.equal(scene.steps[1].provider, 'volc-payg');
  assert.equal(scene.steps[1].tier, 'paid');
  assert.equal(scene.flow, 'fallback');
});

test('已收成单步的绑定，请求时仍展开降级链', () => {
  setRouterModelMap({
    'deepseek-v4-flash': {
      list_route: true,
      flow: 'fallback',
      scene_name: 'deepseek-v4-flash',
      steps: [
        { model: 'deepseek-v4-flash', provider: 'volc' },
        { model: 'deepseek-v4-flash-ga-260731', provider: 'volc-payg' },
      ],
    },
  });
  const expanded = expandBoundListRoute({
    scene_name: 'deepseek-v4-flash',
    steps: [{ model: 'deepseek-v4-flash', tier: 'paid' }],
  });
  assert.equal(expanded.steps.length, 2);
  assert.equal(expanded.steps[0].provider, 'volc');
  assert.equal(expanded.steps[0].tier, 'paid');
  assert.equal(expanded.steps[1].provider, 'volc-payg');
  assert.equal(expanded.steps[1].tier, 'paid');

  const p2pOnly = expandBoundListRoute({
    scene_name: 'deepseek-v4-flash',
    steps: [{ model: 'deepseek-v4-flash', tier: 'p2p' }],
  });
  assert.equal(p2pOnly.steps.length, 1);
  assert.equal(p2pOnly.steps[0].tier, 'p2p');
  setRouterModelMap({});
});
