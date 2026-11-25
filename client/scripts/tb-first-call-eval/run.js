#!/usr/bin/env node
// 智能体遇到关于 Token Bank 的问题，会不会先用 tokenbank 的工具，而不是自己去翻 ~/.tokenbank 的文件。
// 模拟一个能列目录、读文件、跑命令的编码智能体（像 Claude Code / Cursor），再挂上 tokenbank 的工具，问十来个问题，
// 看第一步调了什么、最后有没有用上 tokenbank 的工具、中间翻了几次文件。
//
// 另一组（--suite unnamed）：不提 Token Bank，但资产库里正好有合适的智能体 / 提示词 / 模型，看它会不会主动用上；
// 再混两道简单题，看它会不会没必要地去查。
//
// 对比改动前后：
//   node scripts/tb-first-call-eval/run.js --base http://127.0.0.1:11430/v1 --key <网关 Key> --model deepseek-chat
// 选项：--before <git 版本>（默认 e4bc536，改工具说明之前）--suite named|unnamed|both（默认 both）
//   --runs 2 --instructions both|on|off --concurrency 4
//   instructions：MCP 连接时给的使用说明有的应用不给模型看，both 两种都测
'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

function parseArgs(argv) {
  const o = { runs: 1, concurrency: 4, before: 'e4bc536', instructions: 'both', maxSteps: 4, suite: 'both' };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i].replace(/^--/, '');
    const v = argv[i + 1];
    if (['base', 'key', 'model', 'before', 'instructions', 'out', 'suite'].includes(k)) { o[k] = v; i++; }
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

/** 不提 Token Bank 的任务：want=true 表示资产库里有合适的，应该用上；false 是简单题，不该去查 */
const UNNAMED = [
  { q: '把这句话翻译成日文：明天下午三点开会，请准时参加。', want: true },
  { q: '根据这个大纲做一份 PPT：一、市场现状；二、我们的产品；三、明年计划。', want: true },
  { q: '帮我画一张产品宣传图：白色背景上的一副蓝色蓝牙耳机。', want: true },
  { q: '帮我润色这段论文摘要，让它更学术一些：我们做了一个实验，发现效果挺好。', want: true },
  { q: '帮我写这周的周报：完成了登录页改版，修了 3 个 bug，下周做支付。', want: true },
  { q: '把这三句话转成向量，我要存进向量库：苹果很甜。香蕉很软。橙子很酸。', want: true },
  { q: '1 + 1 等于几？', want: false },
  { q: '把 "hello world" 全部改成大写。', want: false },
];
/** 模拟的资产库：改之后的版本把它写进工具说明 */
const FAKE = {
  assistants: [{ name: 'ppt-maker', display_name: 'PPT 生成', description: '按大纲做成 PPT 文件' }, { name: 'paper-polish', display_name: '论文润色', description: '把论文段落改得更学术' }],
  prompts: [{ name: 'to-japanese', display_name: '翻译成日文', description: '把中文翻成自然的日文' }, { name: 'weekly', display_name: '周报', description: '按完成 / 问题 / 下周计划写周报' }],
  models: [{ id: 'deepseek-v4' }, { id: 'gpt-image-1', model_type: 'image' }, { id: 'text-embedding-3', model_type: 'embedding' }],
  agents: [{ id: 'assistant:ppt', name: 'PPT 生成', description: '按大纲做成 PPT 文件', type: 'assistant' }, { id: 'assistant:polish', name: '论文润色', description: '把论文段落改得更学术', type: 'assistant' }],
};

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

async function runOne(opts, variant, withInstr, q, want) {
  const listed = variant.mod.listToolsWithHints ? await variant.mod.listToolsWithHints({ clientId: 'eval', level: 'full' }) : variant.mod.listTools({ level: 'full' });
  const tbTools = listed.map((t) => ({ ...t, name: `mcp__tokenbank__${t.name}` }));
  const tools = [...FS_TOOLS, ...tbTools];
  const system = [
    `You are a coding agent on the user's computer (home ${HOME}). You can list directories, read files, run shell commands, and use MCP tools.`,
    withInstr ? `\n# MCP server "tokenbank" instructions\n${variant.mod.INSTRUCTIONS}` : '',
  ].join('');
  const messages = [{ role: 'system', content: system }, { role: 'user', content: q }];
  const rec = { q, want, variant: variant.label, instr: withInstr, first: null, firstTb: false, anyTb: false, fileOps: 0 };
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
  const after = loadVariant(null);
  // 改之后的版本会把资产库里有什么写进工具说明：用模拟的资产库
  after.setResourceManager({ listAssistantsForClient: () => FAKE.assistants, listPromptsForClient: () => FAKE.prompts, listSkillsForClient: () => [] });
  after.setListModelsImpl(async () => FAKE.models);
  try { require(path.join(ROOT, 'electron', 'agent-executor.js')).listDispatchTargets = async () => FAKE.agents; } catch { /* 没有就不带智能体 */ }
  const variants = [
    { label: `改之前（${opts.before}）`, mod: loadVariant(opts.before), readme: false },
    { label: '改之后（当前）', mod: after, readme: true, readmeText: README_TEXT },
  ];
  const questions = [
    ...(opts.suite !== 'unnamed' ? QUESTIONS.map((q) => ({ q, want: true, suite: 'named' })) : []),
    ...(opts.suite !== 'named' ? UNNAMED.map((x) => ({ ...x, suite: 'unnamed' })) : []),
  ];
  const instrModes = opts.instructions === 'both' ? [true, false] : [opts.instructions === 'on'];
  const jobs = [];
  for (const v of variants) for (const ins of instrModes) for (const x of questions) for (let i = 0; i < opts.runs; i++) jobs.push([v, ins, x]);
  const out = [];
  let next = 0;
  await Promise.all(Array.from({ length: opts.concurrency }, async () => {
    while (next < jobs.length) {
      const [v, ins, x] = jobs[next++];
      try { out.push({ ...(await runOne(opts, v, ins, x.q, x.want)), suite: x.suite }); } catch (e) { out.push({ q: x.q, want: x.want, suite: x.suite, variant: v.label, instr: ins, error: e.message }); }
      process.stderr.write('.');
    }
  }));
  process.stderr.write('\n');
  const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '-');
  console.log(`模型：${opts.model}\n`);
  if (opts.suite !== 'unnamed') {
    console.log('## 问到 Token Bank 时（12 题）\n');
    console.log('| 版本 | 给模型看使用说明 | 第一步就用 tokenbank | 最后用上 tokenbank | 平均翻文件次数 | 出错 |');
    console.log('|---|---|---|---|---|---|');
    for (const v of variants) for (const ins of instrModes) {
      const rs = out.filter((r) => r.suite === 'named' && r.variant === v.label && r.instr === ins);
      const ok = rs.filter((r) => !r.error);
      console.log(`| ${v.label} | ${ins ? '给' : '不给'} | ${pct(ok.filter((r) => r.firstTb).length, ok.length)} | ${pct(ok.filter((r) => r.anyTb).length, ok.length)} | ${ok.length ? (ok.reduce((n, r) => n + r.fileOps, 0) / ok.length).toFixed(1) : '-'} | ${rs.length - ok.length} |`);
    }
  }
  if (opts.suite !== 'named') {
    console.log('\n## 不提 Token Bank 时（6 题资产库里有合适的 + 2 道简单题）\n');
    console.log('| 版本 | 给模型看使用说明 | 有合适资源时用上了 | 简单题没必要地去查 | 出错 |');
    console.log('|---|---|---|---|---|');
    for (const v of variants) for (const ins of instrModes) {
      const rs = out.filter((r) => r.suite === 'unnamed' && r.variant === v.label && r.instr === ins);
      const ok = rs.filter((r) => !r.error);
      const want = ok.filter((r) => r.want);
      const plain = ok.filter((r) => !r.want);
      console.log(`| ${v.label} | ${ins ? '给' : '不给'} | ${pct(want.filter((r) => r.anyTb).length, want.length)} | ${pct(plain.filter((r) => r.anyTb).length, plain.length)} | ${rs.length - ok.length} |`);
    }
  }
  const misses = out.filter((r) => !r.error && r.variant.startsWith('改之后') && (r.want ? !(r.suite === 'named' ? r.firstTb : r.anyTb) : r.anyTb));
  if (misses.length) {
    console.log('\n改之后没做对的：');
    for (const r of misses) console.log(`- [${r.suite === 'named' ? '问 Token Bank' : '不提'}/${r.instr ? '给说明' : '不给说明'}] ${r.q} → ${r.want ? `先调了 ${r.first || '（没调工具）'}${r.anyTb ? '，后来用上了' : ''}` : `不该查却调了 ${r.first}`}`);
  }
  if (opts.out) fs.writeFileSync(path.resolve(opts.out), JSON.stringify({ model: opts.model, at: new Date().toISOString(), records: out }, null, 2));
}

main().catch((e) => { console.error(e.message); process.exit(1); });
