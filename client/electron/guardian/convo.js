// client/electron/guardian/convo.js
// 看护和用户的对话：看护像管家一样说话，不是待办列表。
//  - 推送（push）：只有「需要用户」或「替用户做了个值得知道的决定」才主动说；固定模板，不调模型
//  - 简报（brief）：静默处理好的事不逐条打扰，用户打开对话时合成一段话
//  - 快捷回复（replies）：最后一条消息下面的几个选择；点了由程序直接执行，不经过模型
//  - 打字（say）：先看是不是在回答上一条的问题（由程序识别）；否则交给内置看护智能体（才用模型）
// 存 ~/.tokenbank/guardian/messages.json，最多 300 条。
'use strict';

const store = require('./store');

const MAX = 300;
const DAILY_PUSH_CAP = 8;
const OPEN = ['info', 'suggested', 'failed'];

function guardian() {
  return require('./index');
}

function all() {
  const m = store.readJson('messages.json', []);
  return Array.isArray(m) ? m : [];
}

function save(list) {
  store.writeJson('messages.json', list.slice(-MAX));
}

function state() {
  return store.readJson('convo-state.json', {});
}

function setState(patch) {
  store.writeJson('convo-state.json', { ...state(), ...patch });
}

function newId() {
  return `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function add(msg) {
  const m = { id: newId(), at: Date.now(), ...msg };
  save([...all(), m]);
  return m;
}

function patch(id, p) {
  const list = all();
  const i = list.findIndex(x => x.id === id);
  if (i < 0) return null;
  list[i] = { ...list[i], ...p };
  save(list);
  return list[i];
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * 看护主动说一句。{ text, replies?, mergeKey?, topic? }
 * 同一件事（mergeKey）还没读过：更新那一条，不重复说。用户说过「这类不用告诉我」的 topic：不说。
 */
function push({ text, replies = [], mergeKey = null, topic = null } = {}) {
  if (!text || !guardian().getSettings().enabled) return null;
  const st = state();
  if (topic && (st.muted || []).includes(topic)) return null;
  const list = all();
  if (mergeKey) {
    const hit = [...list].reverse().find(m => m.from === 'guardian' && m.mergeKey === mergeKey && !m.read && !m.answered);
    if (hit) return patch(hit.id, { text, replies, at: Date.now(), count: (hit.count || 1) + 1 });
  }
  // 一天说太多就不再单独开口，留到下次简报
  const day = today();
  const used = st.pushDay === day ? (st.pushUsed || 0) : 0;
  if (used >= DAILY_PUSH_CAP) {
    // 今天说得够多了：不再一条条开口，并进同一条「还有几件事」（仍然算未读，不会被吞掉）
    const more = [...list].reverse().find(m => m.from === 'guardian' && m.mergeKey === '__more__' && !m.read);
    const items = [...((more && more.items) || []), text].slice(-10);
    const body = `今天还有 ${items.length} 件事：\n${items.join('\n')}`;
    return more ? patch(more.id, { text: body, items, at: Date.now() }) : add({ from: 'guardian', text: body, items, mergeKey: '__more__', read: false });
  }
  setState({ pushDay: day, pushUsed: used + 1 });
  return add({ from: 'guardian', text, replies, mergeKey, topic, read: false });
}

function unread() {
  return all().filter(m => m.from === 'guardian' && !m.read).length;
}

/** 用户打开对话时：把上次之后静默处理好的事合成一段话（没有就不说） */
function brief() {
  const st = state();
  const since = st.briefAt || 0;
  const g = guardian();
  const done = g.listRecords({ limit: 300 })
    .filter(r => r.status === 'done' && (r.appliedAt || r.at) > since)
    .reverse();
  setState({ briefAt: Date.now() });
  if (!done.length) return null;
  const parts = [];
  if (done.length) {
    const shown = done.slice(0, 6).map(r => r.title);
    parts.push(done.length === 1
      ? `有一件事我处理好了，你不用管：${shown[0]}。`
      : `有 ${done.length} 件事我处理好了，你不用管：\n${shown.map(x => `- ${x}`).join('\n')}${done.length > 6 ? `\n- 还有 ${done.length - 6} 件小事` : ''}`);
    if (done.some(r => r.undo)) parts.push('哪件不合适，告诉我撤掉哪件就行。');
  }
  return add({ from: 'guardian', text: parts.join('\n'), read: true, brief: true });
}

/** 第一次打开：自我介绍 */
function greet() {
  if (state().greeted) return null;
  setState({ greeted: true });
  // 自我介绍排在最前面（在它之前可能已经有推送）
  const list = all();
  const first = {
    id: newId(), at: list.length ? list[0].at - 1 : Date.now(),
    from: 'guardian', read: true,
    text: '我是 Token Bank 的看护。平时在后台处理安装、投射和路由的故障，不打扰你；有只有你能决定的事，我会在这里跟你说。搞不清的事随时问我。',
    replies: [{ label: '你最近做了什么', say: '你最近做了什么' }, { label: '你能做什么', say: '你能做什么' }],
  };
  save([first, ...list]);
  return first;
}

/** 打开对话页：问候 / 简报，全部标成已读 */
function open() {
  greet();
  brief();
  const list = all().map(m => (m.read ? m : { ...m, read: true }));
  save(list);
  return { messages: list.slice(-80), runtime: require('./engine').status() };
}

function norm(s) {
  return String(s || '').trim().toLowerCase().replace(/[\s。.!！，,、]+/g, '');
}

/** 最后一条还在等回答的看护消息 */
function awaiting() {
  const list = all();
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (m.from === 'user') return null;
    if (m.from === 'guardian' && (m.replies || []).length && !m.answered) return m;
  }
  return null;
}

/** 执行一个快捷回复。返回 { ok, nav?, message } */
async function runReply(msg, reply) {
  patch(msg.id, { answered: reply.label });
  add({ from: 'user', text: reply.label });
  if (reply.say) {
    const known = answerFromData(norm(reply.say));
    if (known) { add({ from: 'guardian', read: true, text: known }); return { ok: true }; }
    return askModel(reply.say);
  }
  if (reply.mute) {
    const st = state();
    setState({ muted: [...new Set([...(st.muted || []), reply.mute])] });
    add({ from: 'guardian', read: true, text: '好，这类事以后不单独告诉你了。想恢复的话说一声。' });
    return { ok: true };
  }
  if (reply.nav) {
    add({ from: 'guardian', read: true, text: reply.navNote || '带你过去了。' });
    return { ok: true, nav: reply.nav };
  }
  if (reply.op) {
    const r = await guardian().runAction(reply.op);
    if (r.ok) {
      if (reply.log) guardian().record({ ...reply.log, status: 'done', ...(r.undo || reply.undo ? { undo: r.undo || reply.undo } : {}) });
      add({ from: 'guardian', read: true, text: reply.done || r.message || '好，办好了。' });
    } else {
      add({ from: 'guardian', read: true, text: `这件事没办成：${r.error || '原因不明'}。` });
    }
    return { ok: !!r.ok };
  }
  add({ from: 'guardian', read: true, text: reply.done || '好。' });
  return { ok: true };
}

async function quick(id, index) {
  const msg = all().find(m => m.id === id);
  const reply = msg && (msg.replies || [])[Number(index) || 0];
  if (!reply || msg.answered) return { ok: false, error: 'not-applicable' };
  return runReply(msg, reply);
}

// 「撤掉 / 撤销」：不带具体对象时撤最近一次可撤销的处理（由程序直接做）
const UNDO_RE = /^(撤掉|撤销|撤回|undo)(刚才那次|上一次|最近那次|它)?$/i;

async function undoLatest() {
  const g = guardian();
  const rec = g.listRecords({ limit: 100 }).find(r => r.status === 'done' && r.undo);
  if (!rec) { add({ from: 'guardian', read: true, text: '最近没有能撤销的处理。' }); return { ok: true }; }
  const r = await g.undo(rec.id);
  add({ from: 'guardian', read: true, text: r.ok ? `撤掉了：${rec.title}。以后同样的情况我不会再自动这样做。` : `没撤成：${r.error || '原因不明'}。` });
  return { ok: !!r.ok };
}

/** 交给内置看护智能体（用模型）。后台跑，结果回来后补进对话 */
function askModel(text) {
  const st = require('./engine').status();
  if (!st.ready) {
    add({
      from: 'guardian', read: true,
      text: '这个问题需要一个能执行命令的应用来帮我想，但你还没有纳管这样的应用。到「网关」页接入 Claude Code、Codex 这类应用后，我就能回答了。',
      replies: [{ label: '去网关页', nav: { to: '/gateway' } }],
    });
    return { ok: true };
  }
  const pending = add({ from: 'guardian', read: true, text: '', pending: true });
  const executor = require('../agent-executor');
  const os = require('os');
  Promise.resolve()
    .then(() => executor.dispatchAndWait(require('./chat').AGENT_ID, text, {
      workingDir: os.homedir(), sessionKey: 'guardian-chat', continueSession: !!state().chatStarted, clientId: 'guardian-chat',
    }))
    .then((status) => {
      setState({ chatStarted: true });
      const out = String(status?.result?.summary || status?.result?.output || '').trim();
      const failed = status?.status !== 'completed' || !out;
      patch(pending.id, {
        pending: false,
        text: failed
          ? `我这次没能回答：${String(status?.error || '执行应用没有返回内容').slice(0, 200).replace(/[。.\s]+$/, '')}。登录好之后再问我，或者换一个应用来运行我。`
          : out,
        ...(failed ? { replies: runtimeReplies() } : {}),
      });
    })
    .catch((e) => patch(pending.id, { pending: false, text: `我这次没能回答：${String(e.message || e).slice(0, 200).replace(/[。.\s]+$/, '')}。`, replies: runtimeReplies() }));
  return { ok: true, pending: pending.id };
}

/** 换执行应用的选择（点了就生效，不需要模型） */
function runtimeReplies() {
  const st = require('./engine').status();
  return (st.runtimes || []).filter(r => r.id !== st.runtime).slice(0, 4)
    .map(r => ({ label: `换成 ${r.label}`, op: { type: 'commandSetRuntime', data: { agent: r.id } }, done: `换好了，下一句开始我就在 ${r.label} 上。` }));
}

function chooseRuntime() {
  const st = require('./engine').status();
  if (!(st.runtimes || []).length) {
    return add({ from: 'guardian', read: true, text: '你还没有纳管能执行命令的应用。到「网关」页接入一个，我就能用它来回答问题。', replies: [{ label: '去网关页', nav: { to: '/gateway' } }] });
  }
  const cur = st.runtimes.find(r => r.id === st.runtime);
  return add({
    from: 'guardian', read: true,
    text: `现在是 ${cur ? cur.label : '未设置'} 在运行我。想换的话选一个，点了就生效。`,
    replies: runtimeReplies(),
  });
}

/** 用户打了一句话 */
async function say(text) {
  const t = String(text || '').trim();
  if (!t) return { ok: false, error: 'empty' };
  // 在回答上一条的问题：由程序识别，不经过模型（「确认放宽」这类也在这里核对）
  const waiting = awaiting();
  if (waiting) {
    const hit = waiting.replies.find(r => norm(r.label) === norm(t) || (r.match || []).some(x => norm(x) === norm(t)));
    if (hit) return runReply(waiting, hit);
    if (waiting.replies.some(r => r.confirmOnly)) patch(waiting.id, { answered: '（没有确认）' });
  }
  add({ from: 'user', text: t });
  if (UNDO_RE.test(norm(t))) return undoLatest();
  if (/^(换|更换)(一个)?(执行)?应用$|^换个应用$/.test(norm(t))) { chooseRuntime(); return { ok: true }; }
  if (/^(暂停|停用|关闭)看护$/.test(norm(t))) { guardian().setSettings({ enabled: false }); add({ from: 'guardian', read: true, text: '好，我先停下。想让我继续时说「恢复看护」。' }); return { ok: true }; }
  if (/^(恢复|开启|打开)看护$/.test(norm(t))) { guardian().setSettings({ enabled: true }); add({ from: 'guardian', read: true, text: '好，我回来了。' }); return { ok: true }; }
  const known = answerFromData(norm(t));
  if (known) { add({ from: 'guardian', read: true, text: known }); return { ok: true }; }
  return askModel(t);
}

function fmtWhen(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 手头数据就能回答的问题：直接用表格 / 列表 / 图表回答，不用模型（没登录执行应用时也能答） */
function answerFromData(q) {
  const g = guardian();
  if (/(最近|这周|这几天|今天).{0,4}(做|干|处理)了?(什么|啥|哪些)/.test(q) || /^(处理)?(日志|记录)$/.test(q)) {
    const recs = g.listRecords({ limit: 300 }).filter(r => ['done', 'undone', 'failed'].includes(r.status)).slice(0, 12);
    if (!recs.length) return '最近没有需要我动手的事，一切正常。';
    const state = (r) => (r.status === 'undone' ? '已撤销' : r.status === 'failed' ? '没办成' : (r.undo ? '可撤销' : '已完成'));
    const rows = recs.map(r => `| ${fmtWhen(r.appliedAt || r.at)} | ${String(r.title).replace(/\|/g, '/')} | ${state(r)} |`);
    return `最近处理过 ${recs.length} 件事：\n\n| 时间 | 做了什么 | 状态 |\n| --- | --- | --- |\n${rows.join('\n')}\n\n想撤掉哪件，直接告诉我。`;
  }
  if (/(有|定过|记了|学了)?(哪些|什么|啥)(规则|规矩)/.test(q) || /^(规则|规矩)$/.test(q)) {
    let rules = [];
    try { rules = require('./judgment').list(); } catch { /* ignore */ }
    if (!rules.length) return '你还没有给我定过规矩。遇到我处理得不对的，直接告诉我以后该怎么做。';
    return `现在记着 ${rules.length} 条：\n${rules.map(r => `- ${r.text}（${r.reason}；用过 ${r.hits || 0} 次）`).join('\n')}\n\n哪条不合适了，告诉我改成什么。`;
  }
  if (/(请求|来源|路由|模型).{0,6}(情况|统计|怎么样|稳不稳|失败)/.test(q)) {
    let rows = [];
    try { rows = require('./review-usage')._internal.routeStats(Math.floor(Date.now() / 1000) - 7 * 86400); } catch { /* ignore */ }
    if (!rows.length) return '最近 7 天网关没有请求记录。';
    const by = new Map();
    for (const r of rows) {
      const k = r.provider;
      let label = k;
      try { label = require('./review-usage')._internal.providerName(k) || k; } catch { /* 用 id */ }
      const cur = by.get(k) || { name: label, ok: 0, fail: 0 };
      cur.ok += r.calls - r.fails;
      cur.fail += r.fails;
      by.set(k, cur);
    }
    const data = [...by.values()].sort((a, b) => (b.ok + b.fail) - (a.ok + a.fail)).slice(0, 8);
    const total = data.reduce((n, d) => n + d.ok + d.fail, 0);
    const fails = data.reduce((n, d) => n + d.fail, 0);
    const worst = [...data].filter(d => d.ok + d.fail >= 5).sort((a, b) => b.fail / (b.ok + b.fail) - a.fail / (a.ok + a.fail))[0];
    const lead = `最近 7 天网关处理了 ${total} 次请求，失败 ${fails} 次。${worst && worst.fail ? `失败最多的是「${worst.name}」（${worst.fail}/${worst.ok + worst.fail}）。` : '各来源都比较稳。'}`;
    const spec = { type: 'bar', title: '最近 7 天各来源的请求', series: ['ok', 'fail'], labels: { ok: '成功', fail: '失败' }, data };
    return `${lead}\n\n\`\`\`chart\n${JSON.stringify(spec)}\n\`\`\``;
  }
  return null;
}

function list({ limit = 80 } = {}) {
  return all().slice(-limit);
}

module.exports = { push, open, list, say, quick, unread, brief, chooseRuntime, add, _internal: { all, state, setState, awaiting, OPEN } };
