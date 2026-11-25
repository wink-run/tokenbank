#!/usr/bin/env node
// 智能体遇到关于 Token Bank 的问题，会不会先用 tokenbank 的工具，而不是自己去翻 ~/.tokenbank 的文件。
// 模拟一个能列目录、读文件、跑命令的编码智能体（像 Claude Code / Cursor），再挂上 tokenbank 的工具，问十来个问题，
// 看第一步调了什么、最后有没有用上 tokenbank 的工具、中间翻了几次文件。
//
// 对比改动前后：
//   node scripts/tb-first-call-eval/run.js --base http://127.0.0.1:11430/v1 --key <网关 Key> --model deepseek-chat
// 选项：--before <git 版本>（默认 e4bc536，改工具说明之前）--runs 2 --instructions both|on|off --concurrency 4
//   instructions：MCP 连接时给的使用说明有的应用不给模型看，both 两种都测
'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

function parseArgs(argv) {
  const o = { runs: 1, concurrency: 4, before: 'e4bc536', instructions: 'both', maxSteps: 4 };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i].replace(/^--/, '');
    const v = argv[i + 1];
    if (['base', 'key', 'model', 'before', 'instructions', 'out'].includes(k)) { o[k] = v; i++; }
    else if (['runs', 'concurrency', 'maxSteps'].includes(k)) { o[k] = Number(v); i++; }
  }
  if (!o.base || !o.model) throw new Error('需要 --base 和 --model（--key 视服务而定）');
  return o;
}

/** 某个 git 版本的 tokenbank-tools（工具说明 + 使用说明） */
function loadVariant(rev) {
  if (!rev) return require(path.join(ROOT, 'electron', 'tokenbank-tools.js'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-eval-'));
  const src = execSync(`git show ${rev}:client/electron/tokenbank-tools.js`, { cwd: ROOT, encoding: 'utf8' });
  // 只要它导出的 TOOLS / INSTRUCTIONS；依赖的模块从当前版本取
  const file = path.join(dir, 'tokenbank-tools.js');
  fs.writeFileSync(file, src.replace(/require\('\.\//g, `require('${path.join(ROOT, 'electron')}/`));
  return require(file);
}

const QUESTIONS = [
  '列出 tokenbank 中可用的工具',
  'tokenbank 有哪些 mcp？',
  'Token Bank 里我装了哪些技能？',
  '我在 Token Bank 里有哪些智能体？',
  'tokenbank 能用哪些模型？',
  'Token Bank 能帮我做什么？',
  '我的 Token Bank 接了哪些第三方服务？',
  'tokenbank 里有没有能搜网页的工具？',
  '看看 Token Bank 里有哪些提示词',
  '有哪些智能体可以接活？',
  'Token Bank 里有我哪几台设备？',
  'tokenbank 的工具有多少个？',
];

const HOME = '/Users/me';
const FS_TOOLS = [
  { name: 'list_dir', description: 'List files in a directory.', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'read_file', description: 'Read a file.', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'run_shell', description: 'Run a shell command and return its output.', inputSchema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
];

const isTb = (name) => /(^|__)tb_/.test(name);

/** 模拟的返回：tokenbank 工具给个简短结果；翻 ~/.tokenbank 时 after 版本能看到 README */
function fakeResult(name, args, withReadme, readmeText) {
  if (isTb(name)) return '（Token Bank 返回了结果，已足够回答）';
  const p = String(args?.path || args?.command || '');
  if (name === 'list_dir' || /\bls\b|find /.test(p)) {
    if (p.includes('.tokenbank')) {
      return [withReadme ? 'README.md' : null, 'local-stats.db', 'mcp/', 'mcp-gateway.json', 'mcp-access.json', 'providers.registry.yaml', 'guardian/'].filter(Boolean).join('\n');
    }
    return '.tokenbank/\n.cursor/\n.claude/\nDocuments/\nprojects/';
  }
  if (p.endsWith('README.md') && p.includes('.tokenbank') && withReadme) return readmeText;
  return '{"servers":[{"id":"tokenbank"}],"note":"partial"}';
}

async function chat(opts, messages, tools) {
  const r = await fetch(`${opts.base.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(opts.key ? { Authorization: `Bearer ${opts.key}` } : {}) },
    body: JSON.stringify({
      model: opts.model,
      max_tokens: 800,
      messages,
      tools: tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } })),
    }),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  return (await r.json()).choices?.[0]?.message || {};
}

async function runOne(opts, variant, withInstr, q) {
  const tbTools = variant.mod.listTools({ level: 'full' }).map((t) => ({ ...t, name: `mcp__tokenbank__${t.name}` }));
  const tools = [...FS_TOOLS, ...tbTools];
  const system = [
    `You are a coding agent on the user's computer (home ${HOME}). You can list directories, read files, run shell commands, and use MCP tools.`,
    withInstr ? `\n# MCP server "tokenbank" instructions\n${variant.mod.INSTRUCTIONS}` : '',
  ].join('');
  const messages = [{ role: 'system', content: system }, { role: 'user', content: q }];
  const rec = { q, variant: variant.label, instr: withInstr, first: null, firstTb: false, anyTb: false, fileOps: 0 };
  for (let step = 0; step < opts.maxSteps; step++) {
    const msg = await chat(opts, messages, tools);
    const calls = msg.tool_calls || [];
    if (!calls.length) break;
    messages.push({ role: 'assistant', content: msg.content || '', tool_calls: calls });
    for (const c of calls) {
      const name = c.function?.name || '';
      let args = {};
      try { args = JSON.parse(c.function?.arguments || '{}'); } catch { /* 坏参数 */ }
      if (!rec.first) { rec.first = name; rec.firstTb = isTb(name); }
      if (isTb(name)) rec.anyTb = true; else rec.fileOps += 1;
      messages.push({ role: 'tool', tool_call_id: c.id, content: fakeResult(name, args, variant.readme, variant.readmeText) });
    }
    if (rec.anyTb) break;
  }
  return rec;
}

async function main() {
  const opts = parseArgs(process.argv);
  const { README_TEXT } = require(path.join(ROOT, 'electron', 'mcp-gateway-server.js'));
  const variants = [
    { label: `改之前（${opts.before}）`, mod: loadVariant(opts.before), readme: false },
    { label: '改之后（当前）', mod: loadVariant(null), readme: true, readmeText: README_TEXT },
  ];
  const instrModes = opts.instructions === 'both' ? [true, false] : [opts.instructions === 'on'];
  const jobs = [];
  for (const v of variants) for (const ins of instrModes) for (const q of QUESTIONS) for (let i = 0; i < opts.runs; i++) jobs.push([v, ins, q]);
  const out = [];
  let next = 0;
  await Promise.all(Array.from({ length: opts.concurrency }, async () => {
    while (next < jobs.length) {
      const [v, ins, q] = jobs[next++];
      try { out.push(await runOne(opts, v, ins, q)); } catch (e) { out.push({ q, variant: v.label, instr: ins, error: e.message }); }
      process.stderr.write('.');
    }
  }));
  process.stderr.write('\n');
  const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '-');
  console.log(`模型：${opts.model}　每组 ${QUESTIONS.length * opts.runs} 题\n`);
  console.log('| 版本 | 给模型看使用说明 | 第一步就用 tokenbank | 最后用上 tokenbank | 平均翻文件次数 | 出错 |');
  console.log('|---|---|---|---|---|---|');
  for (const v of variants) for (const ins of instrModes) {
    const rs = out.filter((r) => r.variant === v.label && r.instr === ins);
    const ok = rs.filter((r) => !r.error);
    console.log(`| ${v.label} | ${ins ? '给' : '不给'} | ${pct(ok.filter((r) => r.firstTb).length, ok.length)} | ${pct(ok.filter((r) => r.anyTb).length, ok.length)} | ${ok.length ? (ok.reduce((n, r) => n + r.fileOps, 0) / ok.length).toFixed(1) : '-'} | ${rs.length - ok.length} |`);
  }
  const misses = out.filter((r) => !r.error && !r.firstTb && r.variant.startsWith('改之后'));
  if (misses.length) {
    console.log('\n改之后第一步没用 tokenbank 的：');
    for (const r of misses) console.log(`- [${r.instr ? '给说明' : '不给说明'}] ${r.q} → 先调了 ${r.first || '（没调工具）'}${r.anyTb ? '，后来用上了' : ''}`);
  }
  if (opts.out) fs.writeFileSync(path.resolve(opts.out), JSON.stringify({ model: opts.model, at: new Date().toISOString(), records: out }, null, 2));
}

main().catch((e) => { console.error(e.message); process.exit(1); });
