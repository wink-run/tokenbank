// client/electron/guardian/gateway-watch.js
// 供给源失败：网关本身已经做了冷却与切换，这里只在「必须用户自己动手」时提醒（Key 失效、额度用完）。
// 只读网关推来的失败事件，不改路由、不重试请求、不调模型。
'use strict';

const guardian = require('./index');
const explain = require('./explain');

let attached = false;

async function handleFailure(type, info = {}) {
  if (guardian.modeOf('gateway') === 'off') return;
  const base = explain.classify(info);
  if (base.kind !== 'auth' && base.kind !== 'quota') return;   // 其它的网关已经自动换源，不打扰
  const who = info.providerLabel || info.providerId || '供给源';
  guardian.record({
    category: 'gateway',
    kind: base.kind === 'quota' ? 'quota-alert' : 'provider-failure',
    status: 'info',
    needsUser: true,
    title: `${who}：${base.title}`,
    detail: [info.model && `模型 ${info.model}`, info.status && `HTTP ${info.status}`, info.message && String(info.message).slice(0, 300)]
      .filter(Boolean).join(' · '),
    advice: base.advice,
    signature: explain.signatureOf(info, base.kind),
    link: { to: '/providers', label: '去看模型来源' },
    meta: { providerId: info.providerId, model: info.model, kind: base.kind, event: type, until: info.until || null },
  });
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

module.exports = { attach, handleFailure };
