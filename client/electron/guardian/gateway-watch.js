// client/electron/guardian/gateway-watch.js
// 供给源失败 → 原因与处理办法（日志解读）、额度预警。只读网关推来的失败事件，不改路由、不重试请求：
// 网关本身已经做了冷却与切换，这里负责让用户「不用自己排查」。
'use strict';

const http = require('http');
const guardian = require('./index');
const explain = require('./explain');
const store = require('./store');

let attached = false;
let modelBusy = false;

function today() {
  return new Date().toISOString().slice(0, 10);
}

function takeModelBudget() {
  const limit = guardian.getSettings().modelExplainPerDay || 0;
  if (limit <= 0) return false;
  const b = store.readJson('budget.json', {});
  const used = b.day === today() ? (b.used || 0) : 0;
  if (used >= limit) return false;
  store.writeJson('budget.json', { day: today(), used: used + 1 });
  return true;
}

/** 请本机网关的模型解释一条未知报错（看护自己的请求，带标记；失败就算了） */
function askModel(info) {
  let reverse = '127.0.0.1:11430';
  try { reverse = require('../config-loader').gatewayCtx().reverse || reverse; } catch { /* 默认端口 */ }
  const [host, port] = String(reverse).split(':');
  const prompt = [
    '你是 Token Bank 网关的排障助手。下面是一个模型供给源返回的报错，用中文给出：',
    '1) 一句话原因（≤30字）；2) 用户该怎么处理（≤60字）。只输出 JSON：{"title":"…","advice":"…"}',
    `供给源：${info.providerLabel || info.providerId || '未知'}；模型：${info.model || '未知'}；HTTP 状态：${info.status || '无'}`,
    `报错：${String(info.message || '').slice(0, 600)}`,
  ].join('\n');
  const body = JSON.stringify({ model: 'auto', temperature: 0, max_tokens: 200, messages: [{ role: 'user', content: prompt }] });
  return new Promise((resolve) => {
    const req = http.request({
      host: host || '127.0.0.1', port: Number(port) || 11430, path: '/v1/chat/completions', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'X-TokenBank-Guardian': '1', Authorization: 'Bearer tb-guardian' },
      timeout: 30000,
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        try {
          const text = JSON.parse(buf)?.choices?.[0]?.message?.content || '';
          const m = text.match(/\{[\s\S]*\}/);
          const j = m ? JSON.parse(m[0]) : null;
          resolve(j && j.title ? { title: String(j.title).slice(0, 80), advice: String(j.advice || '').slice(0, 200) } : null);
        } catch { resolve(null); }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
    req.end(body);
  });
}

async function handleFailure(type, info = {}) {
  if (guardian.modeOf('gateway') === 'off') return;
  const base = explain.classify(info);
  const signature = explain.signatureOf(info, base.kind);
  let expl = base;

  // 规则库里学过（含模型解释过）的直接复用
  const learned = guardian.getRule(signature);
  if (learned && learned.title) expl = { ...base, title: learned.title, advice: learned.advice, source: learned.source || 'rule' };

  const who = info.providerLabel || info.providerId || '供给源';
  const rec = guardian.record({
    category: 'gateway',
    kind: base.kind === 'quota' ? 'quota-alert' : 'provider-failure',
    status: 'info',
    title: `${who}：${expl.title}`,
    detail: [info.model && `模型 ${info.model}`, info.status && `HTTP ${info.status}`, info.message && String(info.message).slice(0, 300)]
      .filter(Boolean).join(' · '),
    advice: expl.advice,
    signature,
    // 网关已经自动换源；只有要用户自己动手的（Key 失效、额度用完）才提
    needsUser: base.kind === 'auth' || base.kind === 'quota',
    link: { to: '/providers', label: '去看模型来源' },
    meta: { providerId: info.providerId, model: info.model, kind: base.kind, event: type, until: info.until || null, source: expl.source },
  });
  guardian.learnRule(signature, { countDelta: 1, kind: base.kind });
  if (!rec) return; // 用户忽略过这类提醒，7 天内不再提

  // 规则认不出、也没学过：有额度时请模型解释一次，结论存进规则库，下次直接用
  if (base.kind === 'unknown' && !(learned && learned.title) && !modelBusy && takeModelBudget()) {
    modelBusy = true;
    try {
      const m = await askModel(info);
      if (m) {
        guardian.learnRule(signature, { title: m.title, advice: m.advice, source: 'model' });
        guardian.updateRecord(rec.id, { title: `${who}：${m.title}`, advice: m.advice, meta: { ...rec.meta, source: 'model' } });
      }
    } finally {
      modelBusy = false;
    }
  }
}

/** 挂到网关模块上（桌面版 main.js / Docker cli/gateway.js 启动时调用） */
function attach(gatewayModule) {
  if (attached || !gatewayModule || typeof gatewayModule.setGuardianListener !== 'function') return false;
  attached = true;
  gatewayModule.setGuardianListener((type, info) => guardian.emit(`gateway:${type}`, info));
  guardian.on('gateway:cooldown', (info) => handleFailure('cooldown', info));
  guardian.on('gateway:request-failed', (info) => handleFailure('request-failed', info));
  return true;
}

module.exports = { attach, handleFailure, _internal: { askModel, takeModelBudget } };
