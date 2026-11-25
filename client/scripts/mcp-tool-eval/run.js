#!/usr/bin/env node
// MCP 工具选择评测：同一批任务，比较四种接入方式下模型选对工具、填对参数的比例。
//
//   direct          MCP 直接写进应用配置：工具名 mcp__<MCP>__<工具>，带完整定义
//   gateway         经网关、原样列给应用：工具名 <MCP>__<工具>，带完整定义
//   indirect        经网关、藏在 tb_call_mcp 后面：tb_list_resources 列出工具签名（带参数名），tb_call_mcp 按定义检查参数
// 每种都带 Token Bank 自己的 11 个工具（应用里本来就有）。工具少（small，约 16 个第三方工具）和工具多（large，约 60 个）各跑一遍。
//
// 用法：
//   node scripts/mcp-tool-eval/run.js --base http://127.0.0.1:11430/v1 --key <网关 Key> --model <模型>
//   node scripts/mcp-tool-eval/run.js --api anthropic --base https://api.anthropic.com/v1 --key $ANTHROPIC_API_KEY --model claude-sonnet-4-5
// 选项：--runs 2（每个任务重复几次）--modes direct,gateway --sizes small,large --only gh-create,web-news --concurrency 4 --out 结果.json
'use strict';

const fs = require('fs');
const path = require('path');
const { serversFor, countTools } = require('./catalog');
const { TASKS } = require('./tasks');
const tb = require('../../electron/tokenbank-tools');

const MAX_STEPS = 6;
const MODES = ['direct', 'gateway', 'indirect'];

function parseArgs(argv) {
  const o = { api: 'openai', runs: 1, concurrency: 4, modes: MODES, sizes: ['small', 'large'], only: null, maxTokens: 1024 };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i].replace(/^--/, '');
    const v = argv[i + 1];
    if (['base', 'key', 'model', 'api', 'out'].includes(k)) { o[k] = v; i++; }
    else if (k === 'runs' || k === 'concurrency' || k === 'max-tokens') { o[k === 'max-tokens' ? 'maxTokens' : k] = Number(v); i++; }
    else if (k === 'modes' || k === 'sizes' || k === 'only') { o[k] = String(v).split(',').map((x) => x.trim()).filter(Boolean); i++; }
  }
  if (!o.base || !o.model) throw new Error('需要 --base 和 --model（--key 视服务而定）');
  o.base = o.base.replace(/\/$/, '');
  return o;
}

// ── 工具列表 ────────────────────────────────────────────────────────────────

const TB_TOOLS = tb.listTools({ level: 'full' });

function toolName(mode, server, tool) {
  const s = server.replace(/[^a-zA-Z0-9_-]+/g, '_');
  return mode === 'direct' ? `mcp__${s}__${tool}` : `${s}__${tool}`;
}

/** 这种接入方式下模型看到的工具，以及「工具名 → [MCP, 工具]」 */
function toolsFor(mode, size) {
  const tools = [...TB_TOOLS];
  const map = new Map();
  if (mode === 'direct' || mode === 'gateway') {
    for (const s of serversFor(size)) {
      for (const t of s.tools) {
        const name = toolName(mode, s.name, t.name);
        map.set(name, [s.name, t.name]);
        tools.push({ name, description: `${t.description}（${s.name}）`, inputSchema: t.inputSchema });
      }
    }
  }
  return { tools, map };
}

// ── 模拟 Token Bank 那边：发现类工具走真实实现，调用第三方只记录不执行 ─────────

/** 网关能拿到的第三方工具定义（tb_list_resources 列签名、tb_call_mcp 检查参数用） */
function relayedDefs(size) {
  return Object.fromEntries(serversFor(size).map((s) => [s.name.replace(/[^a-zA-Z0-9_-]+/g, '_'), s.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }))]));
}

function relayedSummaries(size) {
  return serversFor(size).map((s) => ({ id: `mcp-${s.name}`, name: s.name, display_name: s.name, description: s.description, tools: s.tools.map((t) => t.name), prefix: s.name.replace(/[^a-zA-Z0-9_-]+/g, '_') }));
}

const emptyRm = {
  listResources: () => [], listAssistantsForClient: () => [], listSkillsForClient: () => [], listPromptsForClient: () => [],
  isResourceProjectedToClient: () => false, resolveAssistantForClient: () => ({ found: false }), resolvePromptForClient: () => ({ found: false }),
  getResource: () => null, listCatalog: () => ({ items: [] }),
};

/** 模型调了 Token Bank 自己的某个工具：返回 { text } 或 { thirdParty: [MCP, 工具, 参数] } 或 { other } */
async function runTbTool(name, args, mode, size) {
  if (name === 'tb_call_mcp') {
    let captured = null;
    await tb.callTool(name, args, { level: 'full', clientId: 'eval', callRelayed: async (prefixed, a) => { captured = [prefixed, a]; return { content: [{ type: 'text', text: 'ok' }] }; } });
    if (!captured) {
      // 名字对不上：真实实现会返回错误，让模型再试
      const r = await tb.callTool(name, args, { level: 'full', clientId: 'eval', callRelayed: async () => ({}) });
      return { text: r.content.map((c) => c.text).join('\n'), miss: true };
    }
    const [prefixed, a] = captured;
    const idx = prefixed.indexOf('__');
    const prefix = prefixed.slice(0, idx);
    const server = serversFor(size).find((s) => s.name.replace(/[^a-zA-Z0-9_-]+/g, '_') === prefix);
    return { thirdParty: [server ? server.name : prefix, prefixed.slice(idx + 2), a] };
  }
  if (['tb_capabilities', 'tb_list_resources', 'tb_get_resource', 'tb_list_models', 'tb_list_devices'].includes(name)) {
    const r = await tb.callTool(name, args, { level: 'full', clientId: 'eval', gatewayUrl: 'http://127.0.0.1:9' });
    return { text: r.content.map((c) => c.text).join('\n') };
  }
  return { other: name };
}

// ── 调模型 ─────────────────────────────────────────────────────────────────

async function callModel(opts, system, messages, tools) {
  const anthropic = opts.api === 'anthropic';
  const url = anthropic ? `${opts.base}/messages` : `${opts.base}/chat/completions`;
  const headers = { 'Content-Type': 'application/json' };
  if (opts.key) {
    if (anthropic) { headers['x-api-key'] = opts.key; headers['anthropic-version'] = '2023-06-01'; }
    else headers.Authorization = `Bearer ${opts.key}`;
  }
  const body = anthropic
    ? { model: opts.model, max_tokens: opts.maxTokens, system, messages, tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })) }
    : { model: opts.model, max_tokens: opts.maxTokens, messages: [{ role: 'system', content: system }, ...messages], tools: tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } })) };
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(180000) });
    const text = await r.text();
    if (r.ok) return JSON.parse(text);
    if (attempt < 3 && (r.status === 429 || r.status >= 500)) { await new Promise((res) => setTimeout(res, 2000 * (attempt + 1))); continue; }
    throw new Error(`HTTP ${r.status}: ${text.slice(0, 300)}`);
  }
}

/** 统一成 { calls: [{ id, name, args }], usage: { in, out }, assistantMessage } */
function normalize(opts, resp) {
  if (opts.api === 'anthropic') {
    const calls = (resp.content || []).filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, args: b.input || {} }));
    return { calls, usage: { in: resp.usage?.input_tokens || 0, out: resp.usage?.output_tokens || 0 }, assistantMessage: { role: 'assistant', content: resp.content } };
  }
  const msg = resp.choices?.[0]?.message || {};
  const calls = (msg.tool_calls || []).map((c) => {
    let args = {};
    try { args = JSON.parse(c.function?.arguments || '{}'); } catch { args = { _unparsable: c.function?.arguments }; }
    return { id: c.id, name: c.function?.name, args };
  });
  return { calls, usage: { in: resp.usage?.prompt_tokens || 0, out: resp.usage?.completion_tokens || 0 }, assistantMessage: { role: 'assistant', content: msg.content || null, tool_calls: msg.tool_calls } };
}

function toolResultMessages(opts, results) {
  if (opts.api === 'anthropic') return [{ role: 'user', content: results.map((r) => ({ type: 'tool_result', tool_use_id: r.id, content: r.text })) }];
  return results.map((r) => ({ role: 'tool', tool_call_id: r.id, content: r.text }));
}

// ── 先查一步：只读工具给模拟数据 ─────────────────────────────────────────────

const WRITE = /(create|send|post|add|update|write|move|delete|reply|draft|fill|click|evaluate|append)/;
const READ = /(^|_)(list|get|search|read|describe|find|query|history|users|profile|channels|forecast|alerts|extract|navigate|screenshot|fetch)(_|$)/;
function isReadOnly(tool) {
  return !WRITE.test(tool) && READ.test(tool);
}

function mockResult(server, tool) {
  if (tool === 'slack_list_channels') {
    return JSON.stringify({ channels: ['general', 'release', 'support', 'design'].map((n) => ({ id: `C_${n}`, name: n })) });
  }
  if (tool === 'slack_get_channel_history') {
    return JSON.stringify({ messages: [{ ts: '1732500000.000100', user: 'U02ABCDEF', text: '登录页偶尔白屏' }, { ts: '1732500100.000200', user: 'U03XYZ', text: '0.8.1 已发布' }] });
  }
  if (tool === 'slack_get_users') return JSON.stringify({ members: [{ id: 'U02ABCDEF', name: 'li' }, { id: 'U03XYZ', name: 'wang' }] });
  if (/issues/.test(tool)) {
    return JSON.stringify({ items: [{ number: 17, title: '启动慢', state: 'open' }, { number: 88, title: 'macOS 上崩溃', state: 'open', labels: ['bug'] }] });
  }
  if (tool === 'get_pull_request') return JSON.stringify({ number: 42, state: 'open', title: 'MCP 合成一个 tokenbank', changed_files: 12 });
  return JSON.stringify({ ok: true, server, tool, result: '（示例数据）' });
}

// ── 评分 ───────────────────────────────────────────────────────────────────

function argsOk(expected, got) {
  const a = got && typeof got === 'object' ? got : {};
  return Object.entries(expected).every(([k, want]) => {
    const v = a[k];
    if (v == null || v === '') return false;
    if (want === true) return true;
    const have = (Array.isArray(v) ? v.join(' ') : String(v)).toLowerCase();
    // 数组：几种说法任一个都算对（MCP / Model Context Protocol）
    return (Array.isArray(want) ? want : [want]).some((w) => have.includes(String(w).toLowerCase()));
  });
}

const SYSTEM = [
  'You are a helpful assistant working inside the user\'s coding app. Use the available tools to carry out the user\'s request; do not ask the user for confirmation.',
  '',
  'Instructions from the tokenbank MCP server:',
  tb.INSTRUCTIONS,
].join('\n');

async function runOne(opts, task, mode, size) {
  const { tools, map } = toolsFor(mode, size);
  const messages = [{ role: 'user', content: task.prompt }];
  const rec = { id: task.id, named: task.named, mode, size, lookups: [], steps: 0, tokensIn: 0, tokensOut: 0, tool: null, toolOk: false, argsOk: false, outcome: '' };
  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      const resp = normalize(opts, await callModel(opts, SYSTEM, messages, tools));
      rec.steps += 1;
      rec.tokensIn += resp.usage.in;
      rec.tokensOut += resp.usage.out;
      if (!resp.calls.length) { rec.outcome = 'no_tool_call'; return rec; }
      messages.push(resp.assistantMessage);
      const results = [];
      for (const c of resp.calls) {
        let picked = null;
        if (map.has(c.name)) {
          const [server, tool] = map.get(c.name);
          picked = [server, tool, c.args];
        } else if (c.name && c.name.startsWith('tb_')) {
          const r = await runTbTool(c.name, c.args, mode, size);
          if (r.thirdParty) picked = r.thirdParty;
          else if (r.other) { rec.tool = r.other; rec.outcome = 'wrong_tokenbank_tool'; return rec; }
          else { results.push({ id: c.id, text: r.text }); continue; }
        } else {
          rec.tool = c.name; rec.outcome = 'unknown_tool'; return rec;
        }
        const [server, tool, args] = picked;
        const isExpected = task.expect.some(([s, t]) => s === server && t === tool);
        // 先查一步再动手（发消息前先找频道、评论前先看 issue）是合理的：只读的就给它模拟数据，让它接着做
        if (!isExpected && isReadOnly(tool)) {
          rec.lookups.push(`${server}.${tool}`);
          results.push({ id: c.id, text: mockResult(server, tool) });
          continue;
        }
        rec.tool = `${server}.${tool}`;
        rec.toolOk = isExpected;
        rec.argsOk = rec.toolOk && argsOk(task.args, args);
        rec.args = args;
        rec.outcome = rec.toolOk ? (rec.argsOk ? 'ok' : 'bad_args') : 'wrong_tool';
        return rec;
      }
      messages.push(...toolResultMessages(opts, results));
    }
    rec.outcome = 'too_many_steps';
  } catch (e) {
    rec.outcome = 'error';
    rec.error = e.message;
  }
  return rec;
}

// ── 汇总 ───────────────────────────────────────────────────────────────────

function pct(n, d) { return d ? `${Math.round((n / d) * 100)}%` : '—'; }

function summarize(records) {
  const rows = [];
  const groups = new Map();
  for (const r of records) {
    const k = `${r.size}|${r.mode}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  for (const [k, list] of groups) {
    const [size, mode] = k.split('|');
    const valid = list.filter((r) => r.outcome !== 'error');
    const named = valid.filter((r) => r.named);
    const unnamed = valid.filter((r) => !r.named);
    const avg = (f) => (valid.length ? Math.round(valid.reduce((s, r) => s + f(r), 0) / valid.length) : 0);
    rows.push({
      size, mode, n: valid.length, errors: list.length - valid.length,
      tool: pct(valid.filter((r) => r.toolOk).length, valid.length),
      both: pct(valid.filter((r) => r.argsOk).length, valid.length),
      named: pct(named.filter((r) => r.argsOk).length, named.length),
      unnamed: pct(unnamed.filter((r) => r.argsOk).length, unnamed.length),
      steps: (valid.reduce((s, r) => s + r.steps, 0) / (valid.length || 1)).toFixed(1),
      lookups: (valid.reduce((s, r) => s + r.lookups.length, 0) / (valid.length || 1)).toFixed(1),
      tokens: avg((r) => r.tokensIn + r.tokensOut),
    });
  }
  const order = (r) => ['small', 'large'].indexOf(r.size) * 10 + MODES.indexOf(r.mode);
  return rows.sort((a, b) => order(a) - order(b));
}

function printTable(opts, rows) {
  const lines = [
    `模型：${opts.model}　第三方工具：small ${countTools('small')} 个，large ${countTools('large')} 个（另有 Token Bank 自己的 ${TB_TOOLS.length} 个）`,
    '',
    '| 工具数 | 接入方式 | 任务数 | 选对工具 | 工具和参数都对 | 点名的 | 没点名的 | 先查了几次 | 平均调用模型次数 | 平均 token |',
    '|---|---|---|---|---|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.size} | ${r.mode} | ${r.n}${r.errors ? `（${r.errors} 个出错）` : ''} | ${r.tool} | ${r.both} | ${r.named} | ${r.unnamed} | ${r.lookups} | ${r.steps} | ${r.tokens} |`),
  ];
  console.log(lines.join('\n'));
}

async function main() {
  const opts = parseArgs(process.argv);
  tb.setResourceManager(emptyRm);
  tb.setPlainToolLister(() => []);
  const tasks = opts.only ? TASKS.filter((t) => opts.only.includes(t.id)) : TASKS;
  const jobs = [];
  for (const size of opts.sizes) for (const mode of opts.modes) for (const task of tasks) for (let i = 0; i < opts.runs; i++) jobs.push({ task, mode, size });
  const records = [];
  let next = 0;
  let done = 0;
  async function worker() {
    while (next < jobs.length) {
      const j = jobs[next++];
      // 每个任务看到的第三方 MCP 跟着工具数走
      tb.setRelayedMcpLister(() => relayedSummaries(j.size));
      tb.setRelayedToolDefs(() => relayedDefs(j.size));
      const r = await runOne(opts, j.task, j.mode, j.size);
      records.push(r);
      done += 1;
      if (done % 10 === 0 || done === jobs.length) process.stderr.write(`  ${done}/${jobs.length}\n`);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency) }, worker));
  records.sort((a, b) => `${a.size}${a.mode}${a.id}`.localeCompare(`${b.size}${b.mode}${b.id}`));
  const rows = summarize(records);
  printTable(opts, rows);
  const misses = records.filter((r) => r.outcome !== 'ok');
  if (misses.length) {
    console.log('\n没做对的：');
    for (const r of misses) console.log(`- [${r.size}/${r.mode}] ${r.id}：${r.outcome}${r.lookups.length ? `（先查了 ${r.lookups.join('、')}）` : ''}${r.tool ? `（选了 ${r.tool}）` : ''}${r.error ? ` ${r.error}` : ''}${r.outcome === 'bad_args' ? ` 参数 ${JSON.stringify(r.args).slice(0, 160)}` : ''}`);
  }
  if (opts.out) fs.writeFileSync(path.resolve(opts.out), JSON.stringify({ model: opts.model, at: new Date().toISOString(), rows, records }, null, 2));
}

if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });

module.exports = { toolsFor, argsOk, runTbTool, summarize };
