// client/electron/guardian/explain.js
// 把供给源报错翻译成「原因 + 怎么办」。先用规则；规则认不出的新报错，按签名缓存，
// 有模型且当天额度未用完时才请模型解释一次（智能管家自己的请求，不走用户业务）。
'use strict';

const RULES = [
  {
    kind: 'auth',
    test: (s, m) => s === 401 || s === 403 || /invalid[_ ]?(api[_ ]?)?key|unauthori[sz]ed|authentication|permission denied|incorrect api key/i.test(m),
    title: '供给源的 Key 无效或已过期',
    advice: '到「模型」页检查这个供给源的 Key；网关已自动改用其它可用的源。',
  },
  {
    kind: 'quota',
    test: (s, m) => s === 402 || /insufficient[_ ]?quota|quota|余额|balance|billing|credit|payment required|exceeded your current/i.test(m),
    title: '供给源额度已用完',
    advice: '充值或续订后会自动恢复；在此之前网关会改用其它可用的源。',
  },
  {
    kind: 'rate',
    test: (s, m) => s === 429 || /rate.?limit|too many requests|throttl/i.test(m),
    title: '请求太频繁，被供给源限流',
    advice: '网关已让这个源冷却，稍后自动恢复；经常出现可以多加一个供给源分担。',
  },
  {
    kind: 'context',
    test: (s, m) => /context.?length|maximum context|too many tokens|prompt is too long|max_tokens/i.test(m),
    title: '请求超出了模型的上下文长度',
    advice: '换用上下文更长的模型，或在「模型」页的自定义路由里为长文本单独配一个模型。',
  },
  {
    kind: 'model',
    test: (s, m) => s === 404 || /model.*(not.?found|does not exist|unknown|unsupported)|no such model/i.test(m),
    title: '这个供给源不提供请求的模型',
    advice: '在「模型」页核对模型名，或从自定义路由里去掉这个源。',
  },
  {
    kind: 'network',
    test: (s, m) => /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|EAI_AGAIN|socket hang up|network|timed? ?out|getaddrinfo/i.test(m),
    title: '连不上供给源',
    advice: '检查网络、代理设置或供给源地址；恢复后网关会自动切回。',
  },
  {
    kind: 'upstream',
    test: (s, m) => (s >= 500 && s < 600) || /bad gateway|service unavailable|overloaded|internal server error/i.test(m),
    title: '供给源服务端临时异常',
    advice: '多为对方临时故障，网关已改用其它源，恢复后自动切回。',
  },
];

function toStatus(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function learnedPatterns() {
  try {
    const p = require('./store').readJson('patterns.json', []);
    return Array.isArray(p) ? p : [];
  } catch { return []; }
}

/** 记一个识别模式。kind 必须是已有的原因类型 */
function learnPattern({ match, kind }) {
  if (!match || String(match).length < 4) return { ok: false, error: 'match 太短，至少 4 个字符' };
  try { new RegExp(String(match)); } catch { return { ok: false, error: `正则写错了：${match}` }; }
  if (!RULES.some(r => r.kind === kind)) return { ok: false, error: `kind 只能是：${[...new Set(RULES.map(r => r.kind))].join('、')}` };
  const store = require('./store');
  store.writeJson('patterns.json', [{ match: String(match).slice(0, 200), kind, at: Date.now() }, ...learnedPatterns()].slice(0, 100));
  return { ok: true, message: '记下了，下次遇到这种报错我就能认出来。' };
}

/** 规则分类；认不出返回 kind: 'unknown' */
function classify({ status, message } = {}) {
  const s = toStatus(status);
  const m = String(message || '');
  // 进化：用户问过、管家记下来的识别模式（「这种报错 = 这个原因」）优先
  for (const p of learnedPatterns()) {
    let hit = false;
    try { hit = new RegExp(p.match, 'i').test(m); } catch { hit = false; }
    const base = hit && RULES.find(r => r.kind === p.kind);
    if (base) return { kind: base.kind, title: base.title, advice: base.advice, source: 'learned' };
  }
  for (const r of RULES) {
    if (r.test(s, m)) return { kind: r.kind, title: r.title, advice: r.advice, source: 'rule' };
  }
  return { kind: 'unknown', title: '供给源返回了未识别的错误', advice: '网关已改用其它可用的源；可以展开详情查看原始报错。', source: 'rule' };
}

/** 去掉 id、数字、引号里的值，让同类报错归到同一签名 */
function normalizeMessage(message) {
  return String(message || '')
    .replace(/\b(req|msg|chatcmpl|resp)_[\w-]+/gi, '')
    .replace(/[0-9a-f]{8,}/gi, '')
    .replace(/\d+/g, '#')
    .replace(/"[^"]*"|'[^']*'/g, '""')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

function signatureOf({ providerId, status, message }, kind) {
  const base = `${providerId || '-'}|${kind}`;
  return kind === 'unknown' ? `${base}|${toStatus(status)}|${normalizeMessage(message)}` : base;
}

module.exports = { classify, normalizeMessage, signatureOf, RULES, learnPattern };
