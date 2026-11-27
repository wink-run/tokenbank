'use strict';
// 借鉴 agentmesh：发布前先探活、发现只是线索、连不上说清楚试过哪些路
const test = require('node:test');
const assert = require('node:assert/strict');
const scheduler = require('../mesh/scheduler');
const { MeshNode, friendlyDialError } = require('../mesh/node');

const dev = (id, assistants, extra = {}) => ({ device_id: id, name: id, online: true, descriptor: { assistants, apps: [], externals: [] }, path: { kind: 'direct', rttMs: 5 }, ...extra });

test('设备描述里列着、但跑不了的智能体不派过去，原因说清楚', () => {
  const target = scheduler.parseMineHarness('mine:assistant:r1');
  const broken = dev('macmini', [{ id: 'assistant:r1', name: '视频导演', ready: false, why: '缺技能：seedance' }]);
  const r = scheduler.pickDevice({ target, devices: [broken] });
  assert.equal(r.device, null);
  assert.match(r.reason, /视频导演 在 macmini 上暂时跑不了：缺技能：seedance/);
  const ok = dev('mbp', [{ id: 'assistant:r1', name: '视频导演' }]);
  assert.equal(scheduler.pickDevice({ target, devices: [broken, ok] }).device.device_id, 'mbp', '有能跑的就选能跑的');
});

test('连接失败的原因换成看得懂的话', () => {
  assert.match(friendlyDialError(Object.assign(new Error('connect ECONNREFUSED 1.2.3.4:41750'), { code: 'ECONNREFUSED' })), /没在这个地址等连接/);
  assert.match(friendlyDialError(new Error('timeout')), /超时/);
  assert.match(friendlyDialError(Object.assign(new Error('x'), { code: 'EHOSTUNREACH' })), /网络不通/);
  assert.match(friendlyDialError(new Error('cert expired')), /证书/);
});

test('诊断：每台试过哪些地址、结果如何，官方中继在不在', () => {
  const n = new MeshNode({ log: () => {}, relayUrls: ['wss://relay.example/mesh'] });
  n.knownPeers.set('EP_B', { endpoint_id: 'EP_B', name: 'macmini', source: 'cloud', direct_addrs: ['ws://192.168.1.5:41750/mesh/ws'],
    attempts: { 'ws://192.168.1.5:41750/mesh/ws': { ok: false, error: '超时：不在同一个网络，或被防火墙挡住了', at: 1 } } });
  n.knownPeers.set('EP_C', { endpoint_id: 'EP_C', name: 'gateway', source: 'cloud', direct_addrs: [], waiting: true });
  const d = n.diagnose();
  assert.deepEqual(d.official, { configured: true, connected: false, peers: [] });
  const b = d.peers.find((p) => p.name === 'macmini');
  assert.equal(b.attempts[0].addr, 'ws://192.168.1.5:41750/mesh/ws');
  assert.match(b.attempts[0].error, /超时/);
  assert.equal(d.peers.find((p) => p.name === 'gateway').waiting, true);
});

test('本机项目目录在那台设备上找同名工作区；找不到在默认工作区跑并说清楚', () => {
  const { mapWorkspace } = require('../mesh/glue');
  const dev = { device_id: 'dev-mini', name: 'macmini', descriptor: { workspaces: [{ name: 'Demo' }, { name: 'site' }] } };
  const hit = mapWorkspace(dev, '/Users/ully/githubprojects/demo/');
  assert.equal(hit.workspace, 'Demo', '不分大小写');
  assert.match(hit.note, /macmini 的工作区「Demo」/);
  const miss = mapWorkspace(dev, '/Users/ully/projects/tokenbank');
  assert.equal(miss.workspace, null);
  assert.match(miss.note, /macmini 上没有「tokenbank」工作区，在它的默认工作区里跑/);
  assert.deepEqual(mapWorkspace(dev, ''), { workspace: null, note: '' });
});

test('续聊时上一轮的设备离线：说清楚，列出还能接着做的设备（新会话，上下文带不过去）', () => {
  const { prevOfflineError } = require('../mesh/glue');
  const desc = (apps) => ({ apps: apps.map((id) => ({ id, name: id })) });
  const devices = [
    { device_id: 'self', self: true, online: true, name: 'mbp', descriptor: desc(['codex']) },
    { device_id: 'd-mini', online: false, name: 'mini', descriptor: desc(['codex']) },
    { device_id: 'd-nas', online: true, name: 'nas', descriptor: desc(['codex']) },
    { device_id: 'd-pi', online: true, name: 'pi', descriptor: desc(['cursor']) },
  ];
  const e = prevOfflineError({ kind: 'app', id: 'codex', device: null }, devices[1], devices);
  assert.equal(e.code, 'mesh_prev_offline');
  assert.equal(e.device, 'mini');
  assert.deepEqual(e.alternatives.map((a) => a.harnessId), ['codex', 'mine:codex@nas'], '本机和 nas 能做，pi 没装');
  assert.match(e.message, /mini 现在离线/);
  assert.match(e.message, /上下文带不过去/);
  const none = prevOfflineError({ kind: 'app', id: 'codex', device: null }, devices[1], [devices[1], devices[3]]);
  assert.deepEqual(none.alternatives, []);
  assert.match(none.message, /等它上线/);
});
