'use strict';
// 贡献自动上线：冷启动、凭证晚到、瞬时失败、登出/手动停止、圈子与模型名单不被改写。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  classifyProfileFailure,
  isDefinitiveWorkerClose,
  createContributeAutoStart,
  withContributionCredentials,
  withoutContributionCredentials,
} = require('../../shared/contribute-autostart');

function savedContribution(extra = {}) {
  return {
    auto_start: true,
    worker_key: 'wk-user-a',
    server_url: 'wss://example.test/ws/worker',
    model_groups: [{ base_url: 'http://127.0.0.1:11430/v1', models: [{ name: 'gpt-5.4', type: 'chat' }, { name: 'gpt-5.5', type: 'chat' }] }],
    contribute_circle_ids: [7],
    contribute_circle_id: 7,
    name: 'mac',
    ...extra,
  };
}

function harness(initial) {
  let cfg = initial ? { ...initial, model_groups: initial.model_groups, contribute_circle_ids: [...(initial.contribute_circle_ids || [])] } : null;
  let running = false;
  const calls = [];
  const session = createContributeAutoStart({
    readConfig: () => cfg,
    writeConfig: (next) => { cfg = next; calls.push('write'); },
    isRunning: () => running,
    start: () => { calls.push('start'); running = true; },
    stop: () => { calls.push('stop'); running = false; },
  });
  return {
    session,
    calls,
    config: () => cfg,
    setRunning: (v) => { running = v; },
  };
}

function assertContributionKept(cfg) {
  assert.equal(cfg.auto_start, true);
  assert.deepEqual(cfg.model_groups[0].models.map((m) => m.name), ['gpt-5.4', 'gpt-5.5']);
  assert.deepEqual(cfg.contribute_circle_ids, [7]);
  assert.equal(cfg.contribute_circle_id, 7);
}

test('classifyProfileFailure：401/403 是凭证失效，断网和 5xx 是瞬时失败', () => {
  assert.equal(classifyProfileFailure({ response: { status: 401 } }), 'auth');
  assert.equal(classifyProfileFailure({ status: 403 }), 'auth');
  assert.equal(classifyProfileFailure({ response: { status: 0 } }), 'transient');
  assert.equal(classifyProfileFailure({ response: { status: 502 } }), 'transient');
  assert.equal(classifyProfileFailure({ code: 'ECONNRESET' }), 'transient');
  assert.equal(isDefinitiveWorkerClose(4001), true);
  assert.equal(isDefinitiveWorkerClose(1006), false);
});

test('冷启动已有凭证：只拉起一次，重复调用不重连', () => {
  const h = harness(savedContribution());
  assert.equal(h.session.maybeAutoStart(), 'start');
  assert.equal(h.session.maybeAutoStart(), 'already-running');
  assert.deepEqual(h.calls, ['start']);
  assertContributionKept(h.config());
});

test('凭证晚于窗口就绪：写入后拉起，模型与圈子原样保留', () => {
  const h = harness(savedContribution({ worker_key: '', server_url: '' }));
  delete h.config().worker_key;
  assert.equal(h.session.maybeAutoStart(), 'no-credentials');
  assert.equal(h.session.noteTransientFailure(), 'transient');
  assert.equal(h.calls.includes('start'), false);
  const action = h.session.noteCredentialsReady('wk-user-a', 'wss://example.test/ws/worker');
  assert.equal(action, 'start');
  assert.equal(h.session.noteCredentialsReady('wk-user-a', 'wss://example.test/ws/worker'), 'already-running');
  assert.equal(h.calls.filter((c) => c === 'start').length, 1);
  assertContributionKept(h.config());
  assert.equal(h.config().worker_key, 'wk-user-a');
});

test('auto_start 关闭时不自动拉起', () => {
  const h = harness(savedContribution({ auto_start: false }));
  assert.equal(h.session.maybeAutoStart(), 'disabled');
  assert.equal(h.session.noteCredentialsReady('wk-user-a', 'wss://example.test/ws/worker'), 'disabled');
  assert.equal(h.calls.includes('start'), false);
});

test('手动停止后，迟到的登录同步不能再自动拉起', () => {
  const h = harness(savedContribution());
  h.session.maybeAutoStart();
  h.session.noteManualStop();
  assert.equal(h.session.noteCredentialsReady('wk-user-a', 'wss://example.test/ws/worker'), 'suppressed');
  assert.equal(h.calls.filter((c) => c === 'start').length, 1);
  assert.equal(h.config().worker_key, 'wk-user-a');
  assertContributionKept(h.config());
  h.session.noteExplicitStart();
  assert.equal(h.session.maybeAutoStart(), 'start');
});

test('明确登出会停贡献并丢掉凭证，但保留上架模型和圈子', () => {
  const h = harness(savedContribution());
  h.session.maybeAutoStart();
  h.session.noteLogout();
  assert.equal(h.config().worker_key, undefined);
  assert.equal(h.config().server_url, undefined);
  assertContributionKept(h.config());
  assert.equal(h.session.noteCredentialsReady('wk-user-b', 'wss://example.test/ws/worker'), 'suppressed');
  assert.equal(h.calls.filter((c) => c === 'start').length, 1);
  assert.equal(h.config().worker_key, 'wk-user-b');
  assertContributionKept(h.config());
});

test('服务端拒绝 worker_key 只处理一次，不再用失效凭证重连', () => {
  const h = harness(savedContribution());
  h.session.maybeAutoStart();
  assert.equal(h.session.noteAuthRejected(), 'auth');
  assert.equal(h.session.noteAuthRejected(), 'auth-already');
  assert.equal(h.config().worker_key, undefined);
  assertContributionKept(h.config());
  assert.equal(h.session.maybeAutoStart(), 'suppressed');
  assert.equal(h.calls.filter((c) => c === 'start').length, 1);
});

test('瞬时资料失败不停止、不改配置；恢复后若尚未运行则拉起', () => {
  const h = harness(savedContribution({ worker_key: undefined }));
  h.session.noteTransientFailure();
  assert.equal(h.calls.length, 0);
  assertContributionKept(h.config());
  assert.equal(h.session.noteCredentialsReady('wk-user-a', 'wss://example.test/ws/worker'), 'start');
  h.session.noteTransientFailure();
  assert.equal(h.calls.filter((c) => c === 'stop').length, 0);
  assert.equal(h.calls.filter((c) => c === 'start').length, 1);
  assertContributionKept(h.config());
});

test('并发 maybeAutoStart 只启动一次；换账号只重连一次', () => {
  const h = harness(savedContribution());
  const results = [];
  for (let i = 0; i < 20; i++) results.push(h.session.maybeAutoStart());
  assert.equal(results[0], 'start');
  assert.ok(results.slice(1).every((r) => r === 'already-running'));
  assert.equal(h.calls.filter((c) => c === 'start').length, 1);
  assert.equal(h.session.noteCredentialsReady('wk-user-b', 'wss://example.test/ws/worker'), 'reconnected');
  assert.equal(h.session.noteCredentialsReady('wk-user-b', 'wss://example.test/ws/worker'), 'already-running');
  assert.equal(h.calls.filter((c) => c === 'start').length, 2);
  assert.deepEqual(h.config().contribute_circle_ids, [7]);
  assert.equal(h.config().model_groups[0].models.length, 2);
});

test('凭证补丁不会放宽圈子或改写模型名单', () => {
  const src = savedContribution();
  const patched = withContributionCredentials(src, 'wk-next', 'wss://example.test/ws/worker');
  assert.equal(patched.worker_key, 'wk-next');
  assert.deepEqual(patched.contribute_circle_ids, [7]);
  assert.deepEqual(patched.model_groups, src.model_groups);
  const stripped = withoutContributionCredentials(patched);
  assert.equal(stripped.worker_key, undefined);
  assert.equal(stripped.auto_start, true);
  assert.equal(stripped.contribute_circle_id, 7);
  assert.equal(Object.prototype.hasOwnProperty.call(stripped, 'contribute_circle_ids'), true);
});
