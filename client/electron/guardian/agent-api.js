// client/electron/guardian/agent-api.js
// 智能管家（游乐场里的「智能管家」）就是智能管家本身：对话里能做智能管家页上能做的一切。
// 它跑在一个应用（Claude Code / Codex …）里，靠这里的本机接口操作智能管家：
//   - 只监听 127.0.0.1、随机端口、带令牌；端点写在 ~/.tokenbank/guardian/agent-api.json（只有本机这个用户能读）
//   - 只暴露智能管家已有的能力（和智能管家页按钮一一对应），没有任意执行
//   - 附带一个小脚本 ~/.tokenbank/guardian/tb-guardian.js，智能体用 `node <脚本> <操作> '<JSON>'` 调用
// 桌面版与 Docker 共用（startGuardian 里启动）。
'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const store = require('./store');

let server = null;

function guardian() {
  return require('./index');
}

function infoPath() {
  return path.join(store.dir(), 'agent-api.json');
}

function helperPath() {
  return path.join(store.dir(), 'tb-guardian.js');
}

function brief(r) {
  return {
    id: r.id, status: r.status, kind: r.kind, category: r.category, title: r.title,
    advice: r.advice || null, detail: r.detail ? String(r.detail).slice(0, 400) : null,
    actions: (r.actions || []).map((a, i) => ({ index: i, label: a.label })),
    canUndo: r.status === 'done' && !!r.undo, link: r.link?.label || null,
    // 规则能用的事实（和学到的规则匹配时用的是同一份）
    facts: Array.isArray(r.factsList) && r.factsList.length ? r.factsList.slice(0, 5) : require('./judgment').factsOf(r),
    count: r.count || 1, at: r.lastAt || r.at,
  };
}

const ok = (o = {}) => ({ ok: true, ...o });
const fail = (r) => ({ ok: false, error: r?.error || 'failed' });

// 操作表：名字 → { 说明, 处理 }；智能体的说明直接由这张表生成
const OPS = {
  status: {
    desc: '运行状态（是否正常、执行应用、正在跑什么、问题）',
    run: () => ok({ health: require('./health').health() }),
  },
  records: {
    desc: '我做过的事（处理日志，每条说明能不能撤销）。{"limit":30}',
    run: ({ open = false, limit = 30 } = {}) => {
      void open;
      const list = guardian().listRecords({ limit: 300 }).slice(0, limit);
      return ok({ records: list.map(brief) });
    },
  },
  undo: {
    desc: '撤销一条已处理的记录。{"id":"g-…"}',
    run: async ({ id }) => { const r = await guardian().undo(id); return r.ok ? ok() : fail(r); },
  },
  check: {
    desc: '现在检查一遍投射和资产（用户要求时才跑；只用规则，不花 token）',
    run: async () => ok({ results: await guardian().runChecks() }),
  },
  settings: {
    desc: '看设置；改设置传 {"set":{...}}，例：{"set":{"modes":{"assets":"suggest"}}}、{"set":{"enabled":false}}。modes 取值 auto / suggest / off',
    run: ({ set } = {}) => ok({ settings: set ? guardian().setSettings(set) : guardian().getSettings(), categories: Object.keys(guardian().CATEGORIES) }),
  },
  runtime: {
    desc: '执行应用：看当前和可选；改传 {"set":"codex"}',
    run: ({ set } = {}) => {
      const engine = require('./engine');
      if (set) { const r = engine.setRuntime(set); if (!r.ok) return fail(r); }
      return ok({ engine: engine.status() });
    },
  },
  diagnose: {
    desc: '诊断一个资产为什么在应用里看不到/用不了。{"resourceId":"res-skill-…"}',
    run: ({ resourceId }) => ok({ diagnosis: require('./diagnose').diagnoseResource(resourceId) }),
  },
  command: {
    desc: '说一句话就办（安装技能、启用/撤下到某应用、清理闲置、整理、换执行应用…）。{"text":"把 git-commit 投射到 Codex"}；先看 plan 再加 "run":true 执行',
    run: async ({ text, run = false }) => {
      const command = require('./command');
      const plan = await command.parse(String(text || ''), { allowModel: false });
      if (!run || !plan || plan.action === 'unknown') return ok({ plan });
      const r = await command.run(plan);
      return r.ok ? ok({ plan, message: r.message || null }) : fail(r);
    },
  },
  hire: {
    desc: '雇佣任务：最近拦截的任务、被拒接的雇佣者、规则文件位置。拒接 {"refuse":"<雇佣者>"}；恢复 {"allow":"<雇佣者>"}。放宽审查规则只能由用户自己改规则文件，你不能替他改',
    run: ({ refuse, allow } = {}) => {
      const h = require('./hire-guard');
      if (refuse) return ok(h.refuseHirer({ consumer: refuse }));
      if (allow) return ok(h.allowHirer({ consumer: allow }));
      return ok({ blocks: store.readJson('hire-blocks.json', []).slice(0, 20), refused: h._internal.refused(), rulesFile: h.skillFile(), sandbox: h.hasSandbox() });
    },
  },
  rule: {
    desc: '用户教的规矩（事件 + 条件 + 处理）。看全部：{}；加一条：{"add":{...}}（格式见下）；删：{"remove":"er-…"}',
    run: ({ add, remove } = {}) => {
      const r = require('./rules');
      if (add) return r.add(add);
      if (remove) return ok(r.remove({ id: remove }));
      return ok({ rules: r.list() });
    },
  },
  threshold: {
    desc: '连续失败几次才把来源排到后面（默认 5）。{"provider":"来源 id","model":"模型","value":10}；不带 provider 就是改默认值。范围 2~50',
    run: ({ provider, model, value } = {}) => {
      const v = Number(value);
      if (!Number.isFinite(v) || v < 2 || v > 50) return { ok: false, error: 'value 要在 2 到 50 之间' };
      const t = store.readJson('thresholds.json', {});
      t[provider && model ? `${provider}::${model}` : 'default'] = Math.round(v);
      store.writeJson('thresholds.json', t);
      return ok({ thresholds: t });
    },
  },
  pattern: {
    desc: '记一个报错识别模式，下次能直接认出原因。{"match":"报错里的一段文字或正则","kind":"auth|quota|rate|context|model|network|upstream"}',
    run: (args = {}) => require('./explain').learnPattern(args),
  },
  skill: {
    desc: '装给你的技能。看全部：{}；提出装一个：{"propose":"技能名","auto":true}（会在对话里请用户确认）；移除：{"detach":"资产 id"}',
    run: ({ propose, auto, perDay, detach } = {}) => {
      const s = require('./skills');
      if (propose) return s.propose({ name: propose, auto: !!auto, perDay });
      if (detach) return ok(s.detach({ resourceId: detach }));
      return ok({ skills: s.list() });
    },
  },
  remind: {
    desc: '你说了「到时候再提醒你」就必须记下来。{"text":"提醒什么","minutes":240}；取消全部：{"cancel":true}',
    run: ({ text, minutes, cancel } = {}) => {
      const c = require('./convo');
      return cancel ? ok(c.cancelReminders()) : c.remind({ text, minutes });
    },
  },
  rules: {
    desc: '「这种情况不算问题」的规则列表（老的那一套；新规矩用 rule）',
    run: () => ok({ rules: require('./judgment').list() }),
  },
  learn: {
    desc: '学一条规则（格式见下）。{"rule":{...}}。用户在对话里明确要求的，rule 里写 "source":"user"，会直接生效',
    run: async ({ rule }) => {
      const j = require('./judgment');
      const r = rule && rule.source === 'user' ? await j.adoptConfirmed(rule) : await j.propose(rule || {});
      return r.ok ? ok({ rule: r.rule, text: r.rule ? j.describe(r.rule) : null, adopted: r.adopted !== false, message: r.message || null }) : fail(r);
    },
  },
  forget: {
    desc: '删掉一条学到的规则。{"id":"jr-…"}',
    run: ({ id }) => ok(require('./judgment').removeRule({ id })),
  },
};

async function handle(op, args) {
  const spec = OPS[op];
  if (!spec) return { ok: false, error: `没有这个操作：${op}（可用：${Object.keys(OPS).join('、')}）` };
  try {
    return await spec.run(args && typeof args === 'object' ? args : {});
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

const HELPER = `#!/usr/bin/env node
// Token Bank 智能管家的本机接口（智能管家用）。用法：node tb-guardian.js <操作> '<JSON 参数>'
const fs = require('fs'); const http = require('http'); const path = require('path');
const info = JSON.parse(fs.readFileSync(path.join(__dirname, 'agent-api.json'), 'utf8'));
const [op = 'help', raw = '{}'] = process.argv.slice(2);
const body = JSON.stringify({ op, args: JSON.parse(raw) });
const u = new URL(info.url + '/op');
const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Authorization: 'Bearer ' + info.token } },
  (res) => { let b = ''; res.on('data', c => { b += c; }); res.on('end', () => { process.stdout.write(b + '\\n'); process.exitCode = res.statusCode < 400 ? 0 : 1; }); });
req.on('error', (e) => { console.error('智能管家接口连不上（Token Bank 没在运行？）', e.message); process.exitCode = 1; });
req.end(body);
`;

function start() {
  if (server) return;
  const token = crypto.randomBytes(24).toString('hex');
  server = http.createServer((req, res) => {
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (String(req.headers.authorization || '') !== `Bearer ${token}`) return send(401, { ok: false, error: 'unauthorized' });
    if (req.method !== 'POST' || !String(req.url || '').startsWith('/op')) return send(404, { ok: false, error: 'not found' });
    let buf = '';
    req.on('data', (c) => { buf += c; if (buf.length > 256 * 1024) req.destroy(); });
    req.on('end', async () => {
      let body = {};
      try { body = JSON.parse(buf || '{}'); } catch { return send(400, { ok: false, error: 'bad json' }); }
      send(200, await handle(String(body.op || ''), body.args));
    });
  });
  server.on('error', (e) => console.warn('[guardian] agent api:', e.message));
  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    try {
      fs.mkdirSync(store.dir(), { recursive: true });
      fs.writeFileSync(infoPath(), JSON.stringify({ url: `http://127.0.0.1:${port}`, token }), { mode: 0o600 });
      fs.writeFileSync(helperPath(), HELPER, { mode: 0o700 });
    } catch (e) { console.warn('[guardian] agent api info:', e.message); }
  });
  if (server.unref) server.unref();
}

function stop() {
  if (server) { server.close(); server = null; }
}

/** 给智能管家的说明：怎么在对话里操作智能管家 */
function agentGuide() {
  return [
    '你在对话里能做智能管家页上能做的一切，用这个命令（Token Bank 在运行时可用）：',
    `  node "${helperPath()}" <操作> '<JSON 参数>'`,
    '操作：',
    ...Object.entries(OPS).map(([k, v]) => `- ${k}：${v.desc}`),
    '先用 records / status 看清楚再动手。用户明确要求的直接做，做完用一两句话告诉他结果和怎么撤销；你自己想做的改动先说清楚再做。',
  ].join('\n');
}

module.exports = { start, stop, handle, agentGuide, OPS, infoPath, helperPath };
