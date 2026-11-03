'use strict';
// 网关失败候选冷却：硬失败(429/401/403/402)记冷却；429 带 reset 时间精确到重置点；
// sink 把冷却候选下沉末尾（不删除）；成功 clear 恢复。
const { test } = require('node:test');
const assert = require('node:assert');
const cd = require('../gateway-cooldown');

const NOW = Date.parse('2026-07-12T00:00:00+08:00');   // 固定基准（reset 前 3 天，贴近真实场景）

test('parseResetMs：解析 "reset at 2026-07-15 23:59:59 +0800 CST"', () => {
  const msg = 'HTTP_429: You have exceeded the monthly usage quota. It will reset at 2026-07-15 23:59:59 +0800 CST. Request id: x';
  const ms = cd.parseResetMs(msg, NOW);
  assert.equal(ms, Date.parse('2026-07-15T23:59:59+08:00'));
});

test('parseResetMs：无 reset 文本 → null；过去时间 → null', () => {
  assert.equal(cd.parseResetMs('HTTP_429: rate limited', NOW), null);
  assert.equal(cd.parseResetMs('reset at 2000-01-01 00:00:00 +0000', NOW), null);
});

test('classify：429 带 reset → persist=quota-reset + until≈reset(+缓冲)', () => {
  const withReset = cd.classify({ status: 429, message: 'quota. It will reset at 2026-07-15 23:59:59 +0800' }, NOW);
  assert.equal(withReset.persist, true);
  assert.equal(withReset.reason, 'quota-reset');
  assert.ok(withReset.until > Date.parse('2026-07-15T23:59:59+08:00'));   // +缓冲
});

test('classify：429 分级——配额关键词 vs 纯瞬时限流', () => {
  // 有配额关键词、无 reset → quota 10min，不持久
  const quota = cd.classify({ status: 429, message: 'HTTP_429: you exceeded the monthly usage quota' }, NOW);
  assert.equal(quota.reason, 'quota');
  assert.equal(quota.persist, false);
  assert.equal(quota.until, NOW + 10 * 60_000);
  // 纯突发限流(无配额词、无 reset) → 瞬时 45s，不误当配额长冷却
  const burst = cd.classify({ status: 429, message: 'HTTP_429: rate limit, too many requests' }, NOW);
  assert.equal(burst.reason, 'rate-limit');
  assert.equal(burst.until, NOW + 45_000);
});

test('classify：优先读响应头 Retry-After / *-ratelimit-*-reset', () => {
  // Retry-After 整数秒(远期) → 落盘配额级
  const ra = cd.classify({ status: 429, message: 'HTTP_429', headers: { 'retry-after': '600' } }, NOW);
  assert.equal(ra.until, NOW + 600_000 + 30_000);   // +缓冲
  assert.equal(ra.persist, true);
  // anthropic RFC3339 reset 头
  const iso = '2026-07-12T02:00:00+08:00';
  const an = cd.classify({ status: 429, message: 'HTTP_429', headers: { 'anthropic-ratelimit-unified-reset': iso } }, NOW);
  assert.equal(an.until, Date.parse(iso) + 30_000);
  // 短 Retry-After(几秒) → 视为瞬时，不落盘
  const shortRa = cd.classify({ status: 429, message: 'HTTP_429', headers: { 'retry-after': '3' } }, NOW);
  assert.equal(shortRa.persist, false);
  assert.equal(shortRa.reason, 'rate-limit');
});

test('worker reset 直通契约：头解析→规范 ISO→parseResetMs 解回同一时刻', () => {
  // agent-worker 把上游 reset 头规范成 " (reset at <ISO+00:00>)" 追加进错误文本，
  // 经 p2p 多跳原样透传后，消费端必须能用 parseResetMs 解回（否则钉选 worker 退化成退避档）。
  const fmt = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, '+00:00');   // 与 worker 同一格式
  for (const headers of [
    { 'retry-after': '600' },
    { 'anthropic-ratelimit-unified-reset': '2026-07-15T23:59:59+08:00' },
    { 'x-ratelimit-reset-requests': '6m0s' },
  ]) {
    const ms = cd.parseResetFromHeaders(headers, NOW);
    assert.ok(ms, 'header 应解析出 reset');
    const errText = `HTTP 429: limited (reset at ${fmt(ms)})`;
    assert.equal(cd.parseResetMs(errText, NOW), ms, `round-trip 失败: ${JSON.stringify(headers)}`);
  }
});

test('parseResetFromHeaders：openai 时长串 / unix 秒', () => {
  assert.equal(cd.parseResetFromHeaders({ 'x-ratelimit-reset-requests': '6m0s' }, NOW), NOW + 6 * 60_000);
  const unix = Math.floor(Date.parse('2026-07-13T00:00:00+08:00') / 1000);
  assert.equal(cd.parseResetFromHeaders({ 'x-ratelimit-reset': String(unix) }, NOW), unix * 1000);
});

test('classify：401/403 → auth；402 → credit；5xx/超时 → null(不冷却)', () => {
  assert.equal(cd.classify({ status: 401, message: 'HTTP_401: unauthorized' }, NOW).reason, 'auth');
  assert.equal(cd.classify({ status: 403, message: 'HTTP_403' }, NOW).reason, 'auth');
  assert.equal(cd.classify({ status: 402, message: 'insufficient credits' }, NOW).reason, 'credit');
  assert.equal(cd.classify({ status: 500, message: 'HTTP_500: boom' }, NOW), null);
  assert.equal(cd.classify({ status: 504, message: 'timeout' }, NOW), null);
});

test('noteFailure + isCooling：冷却期内命中，过期后自动清', () => {
  const k = 'prov-a';
  const e = cd.noteFailure(k, { status: 401, message: 'HTTP_401' }, NOW);
  assert.equal(e._new, true);
  assert.ok(cd.isCooling(k, NOW + 60_000));            // 30min 内仍冷却
  assert.ok(!cd.isCooling(k, NOW + 60 * 60_000));      // 1h 后已过期
});

test('noteFailure：非硬失败(500)不纳入冷却', () => {
  assert.equal(cd.noteFailure('prov-500', { status: 500, message: 'boom' }, NOW), null);
  assert.ok(!cd.isCooling('prov-500', NOW));
});

test('list：返回 reason 与 note(最近错误)，供 UI 展示', () => {
  const k = 'list-fields';
  cd.noteFailure(k, { status: 401, message: 'HTTP_401: invalid api key xyz' }, NOW);
  const row = cd.list(NOW + 1000).find(e => e.key === k);
  assert.ok(row, '应在冷却列表里');
  assert.equal(row.reason, 'auth');
  assert.match(row.note, /invalid api key/);                   // 最近错误文本
  cd.clear(k);
});

test('noteTransient(社区源)：即便带 reset 也只短瞬时、不落盘、忽略 reset', () => {
  const k = 'tokenbank-p2p::sonnet-5';
  const e = cd.noteTransient(k, { status: 429, message: 'quota. It will reset at 2026-07-20 00:00:00 +0800' }, NOW);
  assert.equal(e.reason, 'transient');
  assert.equal(e.persist, false);
  assert.equal(e.until, NOW + 45_000);             // 固定瞬时，不用 reset 的远期时刻
  assert.ok(cd.isCooling(k, NOW + 10_000));
  assert.ok(!cd.isCooling(k, NOW + 60_000));        // 45s 后自愈
  cd.clear(k);
});

test('钉选 worker 与个人源同走 noteFailure：远期 reset → reset 感知 + 落盘（key 稳定不再特判）', () => {
  const k = 'tokenbank-p2p::sonnet-5::sharerX';
  const e = cd.noteFailure(k, { status: 429, message: 'quota. It will reset at 2026-07-15 23:59:59 +0800' }, NOW);
  assert.equal(e.reason, 'quota-reset');           // reset 感知（冷到重置点）
  assert.equal(e.persist, true);                   // 远期 reset → 落盘（和个人源一样，不按源类型分）
  assert.ok(e.until > Date.parse('2026-07-15T23:59:59+08:00'));
  cd.clear(k);
});

test('noteTransient：5xx/网络等非硬失败不冷却（交给单次 failover 自愈）', () => {
  assert.equal(cd.noteTransient('p2p-500', { status: 500, message: 'boom' }, NOW), null);
  assert.equal(cd.noteTransient('p2p-net', { message: 'socket hang up' }, NOW), null);
  assert.ok(!cd.isCooling('p2p-500', NOW));
});

test('无 reset → 固定兜底，连续失败不翻倍（已去掉滑动窗口）', () => {
  const k = 'fixed-fallback';
  const err = { status: 429, message: 'HTTP_429: rate limit' };   // 无 reset
  assert.equal(cd.noteFailure(k, err, NOW).until,          NOW + 45_000);            // 限流固定 45s
  assert.equal(cd.noteFailure(k, err, NOW + 50_000).until, NOW + 50_000 + 45_000);   // 再失败还是 45s，不翻倍
  cd.clear(k);
  assert.equal(cd.noteFailure('q', { status: 429, message: 'monthly quota' }, NOW).until, NOW + 10 * 60_000);   // 配额无reset 10min
  assert.equal(cd.noteFailure('a', { status: 401, message: 'HTTP_401' }, NOW).until,       NOW + 30 * 60_000);   // 鉴权 30min
  cd.clear('q'); cd.clear('a');
});

test('有 reset → 冷到确切点，连续失败也是同一点（不翻倍）', () => {
  const k = 'reset-fixed';
  const err = { status: 429, message: 'quota. It will reset at 2026-07-15 23:59:59 +0800' };
  const e1 = cd.noteFailure(k, err, NOW);
  const e2 = cd.noteFailure(k, err, NOW + 1000);
  assert.equal(e1.until, e2.until);
  cd.clear(k);
});

test('sink：冷却候选下沉末尾、保序，不删除任何项', () => {
  const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  cd.noteFailure('b', { status: 429, message: 'HTTP_429' }, NOW);
  const out = cd.sink(items, (it) => it.id, NOW + 1000);
  assert.deepEqual(out.map(x => x.id), ['a', 'c', 'b']);   // b 下沉，a/c 保序
  assert.equal(out.length, 3);                              // 不删除
  cd.clear('b');
});

test('clear：成功后清除，候选回到原序', () => {
  const items = [{ id: 'x' }, { id: 'y' }];
  cd.noteFailure('y', { status: 429, message: 'HTTP_429' }, NOW);
  assert.deepEqual(cd.sink(items, (it) => it.id, NOW + 1000).map(x => x.id), ['x', 'y']);   // 已在末尾
  cd.clear('y');
  assert.ok(!cd.isCooling('y', NOW + 1000));
});

test('降级粘滞：30 分钟内把成功的模型挪到链头，过期后恢复原序', () => {
  const steps = [{ model: 'deepseek-v4-flash' }, { model: 'deepseek-flash' }];
  const key = 'sticky-scene';
  assert.equal(cd.STICKY_MS, 30 * 60_000);
  cd.noteSticky(key, 'deepseek-flash', 'deepseek', NOW);
  const hit = cd.stickyOf(key, NOW + 1000);
  assert.equal(hit.model, 'deepseek-flash');
  assert.equal(hit.providerId, 'deepseek');
  assert.deepEqual(cd.preferSticky(steps, hit).map(s => s.model), ['deepseek-flash', 'deepseek-v4-flash']);
  assert.equal(cd.stickyOf(key, NOW + cd.STICKY_MS), null);
  assert.deepEqual(cd.preferSticky(steps, null).map(s => s.model), ['deepseek-v4-flash', 'deepseek-flash']);
});

test('sink：全部冷却也不返回空（保证永远有可试的兜底）', () => {
  const items = [{ id: 'p' }, { id: 'q' }];
  cd.noteFailure('p', { status: 429, message: 'HTTP_429' }, NOW);
  cd.noteFailure('q', { status: 429, message: 'HTTP_429' }, NOW);
  const out = cd.sink(items, (it) => it.id, NOW + 1000);
  assert.equal(out.length, 2);
  cd.clear('p'); cd.clear('q');
});
