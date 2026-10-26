'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isLocalUserRoute, mergeSceneRoutesReplace } = require('../scene-routes-sync');

test('isLocalUserRoute: 仅匹配客户端新建形态', () => {
  assert.equal(isLocalUserRoute({ id: 'a1b2c3d4', model_key: 'llm-router-abcdef' }), true);
  assert.equal(isLocalUserRoute({ id: 'strategy-auto', model_key: 'llm-router-auto' }), false);
});

test('replace 同步：只删系统下发且目录已无的；用户配置保留且不被覆盖', () => {
  const local = [
    { id: 'strategy-auto', scene_name: '综合最优', model_key: 'llm-router-auto' },
    { id: 'strategy-free', scene_name: '免费源', model_key: 'llm-router-free' },
    { id: 'vision-x', scene_name: '识图增强', model_key: 'llm-router-b755e0afa0df', from_server: true },
    { id: 'a1b2c3d4', scene_name: '我的路由', model_key: 'llm-router-abcdef', user_owned: true },
    // 用户改过的系统路由
    { id: 'edited-sys', scene_name: '我改过的', model_key: 'llm-router-edited1', user_owned: true, steps: [{ model: 'local-model' }] },
  ];
  const server = [
    { id: 'strategy-auto', scene_name: '自动', model_key: 'llm-router-auto', flow: 'auto', icon: '✨' },
    { id: 'strategy-cost', scene_name: '实惠优先', model_key: 'llm-router-cost', flow: 'cost' },
    // 服务端仍有，但本地已 user_owned → 不得覆盖
    { id: 'edited-sys', scene_name: '服务端名', model_key: 'llm-router-edited1', steps: [{ model: 'server-model' }] },
  ];
  const r = mergeSceneRoutesReplace(local, server, {
    prevSyncedIds: ['strategy-auto', 'strategy-free', 'vision-x', 'edited-sys'],
    now: '2026-01-01T00:00:00.000Z',
  });
  const ids = r.routes.map(x => x.id).sort();
  assert.deepEqual(ids, ['a1b2c3d4', 'edited-sys', 'strategy-auto', 'strategy-cost']);
  assert.ok(r.removedRoutes.includes('免费源'));
  assert.ok(r.removedRoutes.includes('识图增强'));
  assert.ok(!r.removedRoutes.includes('我的路由'));
  assert.ok(!r.removedRoutes.includes('我改过的'));
  // strategy-* 名称以服务端为准
  assert.equal(r.routes.find(x => x.id === 'strategy-auto').scene_name, '自动');
  assert.equal(r.routes.find(x => x.id === 'strategy-auto').from_server, true);
  const edited = r.routes.find(x => x.id === 'edited-sys');
  assert.equal(edited.scene_name, '我改过的');
  assert.equal(edited.steps[0].model, 'local-model');
  assert.equal(edited.user_owned, true);
});

test('strategy-* 同步后名称/图标与服务端一致', () => {
  const local = [
    {
      id: 'strategy-free', scene_name: '免费源', model_key: 'llm-router-free', icon: '🆓',
      from_server: true, caveman_level: 'lite',
      steps: [{ model: 'x', vision_assist: { model: 'y' } }],
    },
  ];
  const server = [
    { id: 'strategy-free', scene_name: '免费', model_key: 'llm-router-free', icon: '🆓', tier: 'free', flow: 'auto' },
  ];
  const r = mergeSceneRoutesReplace(local, server, { prevSyncedIds: ['strategy-free'] });
  const free = r.routes.find(x => x.id === 'strategy-free');
  assert.equal(free.scene_name, '免费');
  assert.equal(free.tier, 'free');
  assert.equal(free.flow, 'auto');
  assert.equal(free.caveman_level, undefined);
  assert.deepEqual(free.steps, undefined);
});

test('同步以服务端为准：没标用户自有、目录里没有的本地路由删掉', () => {
  const local = [
    { id: 'strategy-free', scene_name: '免费源', model_key: 'llm-router-free' },
    { id: 'a1b2c3d4', scene_name: '我的路由', model_key: 'llm-router-abcdef', user_owned: true },
  ];
  const server = [
    { id: 'strategy-auto', scene_name: '自动', model_key: 'llm-router-auto', flow: 'auto' },
  ];
  const r = mergeSceneRoutesReplace(local, server, { prevSyncedIds: [] });
  assert.deepEqual(r.routes.map(x => x.id).sort(), ['a1b2c3d4', 'strategy-auto']);
  assert.deepEqual(r.removedRoutes, ['免费源']);
});

test('空目录：只删已下发的，保留 user_owned', () => {
  const local = [
    { id: 'strategy-auto', scene_name: '综合最优', model_key: 'llm-router-auto', from_server: true },
    { id: 'a1b2c3d4', scene_name: '我的路由', model_key: 'llm-router-abcdef', user_owned: true },
  ];
  const r = mergeSceneRoutesReplace(local, [], { prevSyncedIds: ['strategy-auto'] });
  assert.deepEqual(r.routes.map(x => x.id), ['a1b2c3d4']);
  assert.deepEqual(r.removedRoutes, ['综合最优']);
});
