// client/electron/guardian/review-models.js
// 自省（离线）：新模型评估。配置里新出现的模型，用三道固定的小题单独试跑（不占用真实请求），
// 判断它适合中文问答、写代码还是结构化输出。第一次运行只记下现有模型作为基线，不试跑。
'use strict';

const guardian = require('./index');
const store = require('./store');
const modelCall = require('./model-call');

const MAX_PER_RUN = 3;
const PER_SAMPLE_TOKENS = 400; // 预留：提示 + 回答（max_tokens 200）

const SAMPLES = [
  {
    key: 'zh', label: '中文问答',
    prompt: '用一句话解释什么是「缓存击穿」。',
    pass: (t) => /[一-鿿]/.test(t) && t.trim().length >= 8 && t.trim().length <= 400,
  },
  {
    key: 'code', label: '写代码',
    prompt: 'Write a JavaScript function isPalindrome(s) that ignores case and non-alphanumeric characters. Reply with code only.',
    pass: (t) => /isPalindrome/.test(t) && /(function|=>)/.test(t) && /(toLowerCase|toUpperCase)/i.test(t),
  },
  {
    key: 'json', label: '结构化输出',
    prompt: '把下面的 JSON 里的城市改成上海、温度改成 18，只输出 JSON，不要解释：{"city":"北京","temp":25}',
    pass: (t) => {
      const m = String(t).match(/\{[\s\S]*\}/);
      try { const j = JSON.parse(m ? m[0] : ''); return j.city === '上海' && Number(j.temp) === 18; } catch { return false; }
    },
  },
];

const NON_CHAT = new Set(['embedding', 'image', 'tts', 'audio', 'rerank', 'video']);

/** 配置里已启用来源的对话模型（去重） */
function configuredModels() {
  const out = new Map();
  try {
    const { readAgentConfig } = require('../../shared/config-loader');
    for (const p of (readAgentConfig() || {}).providers || []) {
      if (!p || p.enabled === false) continue;
      for (const m of p.models || []) {
        const id = typeof m === 'string' ? m : (m && (m.name || m.id));
        const type = typeof m === 'string' ? 'chat' : (m.type || 'chat');
        if (!id || NON_CHAT.has(type) || out.has(id)) continue;
        out.set(id, { id, provider: p.id });
      }
    }
  } catch { /* 读不到配置 */ }
  return [...out.values()];
}

async function evaluate(model, budget) {
  const results = [];
  // 一个模型要么完整跑完三道题，要么留到下次，不交半份结论
  if (budget.used + SAMPLES.length * PER_SAMPLE_TOKENS > budget.cap) { budget.stopped = true; return results; }
  for (const s of SAMPLES) {
    if (budget.used + PER_SAMPLE_TOKENS > budget.cap) { budget.stopped = true; break; }
    const r = await modelCall.chat({ model, maxTokens: 200, messages: [{ role: 'user', content: s.prompt }], timeoutMs: 45000 });
    budget.used += r.tokens || (modelCall.estimateTokens(s.prompt) + modelCall.estimateTokens(r.text));
    results.push({ key: s.key, label: s.label, ok: r.ok, pass: r.ok && s.pass(r.text), latencyMs: r.latencyMs, error: r.ok ? null : r.error });
  }
  return results;
}

async function reviewModels({ budget }) {
  const seen = store.readJson('models-seen.json', null);
  const models = configuredModels();
  const now = Date.now();
  if (!seen) {
    const base = {};
    for (const m of models) base[m.id] = { firstSeenAt: now, baseline: true };
    store.writeJson('models-seen.json', base);
    return { summary: `已记下现有的 ${models.length} 个模型作为基线，之后新接入的模型会自动试跑评估。`, items: [], stats: { baseline: models.length } };
  }

  const fresh = models.filter(m => !seen[m.id] || (!seen[m.id].evaluatedAt && !seen[m.id].baseline));
  for (const m of fresh) if (!seen[m.id]) seen[m.id] = { firstSeenAt: now };
  const items = [];
  for (const m of fresh.slice(0, MAX_PER_RUN)) {
    if (budget.stopped) break;
    const res = await evaluate(m.id, budget);
    if (!res.length) break;
    const passed = res.filter(r => r.pass);
    const reachable = res.some(r => r.ok);
    const okLat = res.filter(r => r.ok && r.latencyMs > 0);
    const avg = okLat.length ? Math.round(okLat.reduce((s, r) => s + r.latencyMs, 0) / okLat.length) : null;
    const good = passed.map(r => r.label);
    const title = !reachable
      ? `新模型 ${m.id} 试跑没有成功`
      : (good.length ? `新模型 ${m.id}：适合${good.join('、')}` : `新模型 ${m.id}：三道试题都没答好`);
    const advice = !reachable
      ? `报错：${res.find(r => r.error)?.error || '无响应'}。先检查这个模型的来源配置。`
      : `试跑 ${res.length} 道题通过 ${passed.length} 道${avg ? `，平均耗时 ${avg}ms` : ''}。${good.length ? '可以把对应类型的请求路由给它。' : '暂不建议放进常用路由。'}`;
    const rec = guardian.record({
      category: 'gateway', kind: 'model-eval', status: 'info', countAsRepeat: false,
      title, advice, signature: `model-eval|${m.id}`,
      detail: res.map(r => `${r.label}：${r.pass ? '通过' : (r.ok ? '未通过' : `失败 ${r.error || ''}`)}${r.latencyMs ? ` ${r.latencyMs}ms` : ''}`).join('；'),
      link: { to: '/gateway', label: '去配置路由' },
      meta: { model: m.id, provider: m.provider, results: res },
    });
    seen[m.id] = { ...seen[m.id], evaluatedAt: Date.now(), good: passed.map(r => r.key), avgLatencyMs: avg, reachable };
    items.push({ title, advice, recordId: rec?.id || null });
  }
  // 配置里已经删掉的模型不再记
  const ids = new Set(models.map(m => m.id));
  for (const k of Object.keys(seen)) if (!ids.has(k)) delete seen[k];
  store.writeJson('models-seen.json', seen);
  const left = fresh.length - items.length;
  return {
    summary: fresh.length
      ? `发现 ${fresh.length} 个新模型，评估了 ${items.length} 个${left > 0 ? `，还有 ${left} 个下次继续` : ''}。`
      : '没有新接入的模型。',
    items,
    stats: { fresh: fresh.length, evaluated: items.length },
  };
}

module.exports = { reviewModels, configuredModels, SAMPLES };
