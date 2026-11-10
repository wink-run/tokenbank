// client/electron/guardian/health.js
// 看护的运行状态（设置页顶部的标志）：总开关、模型、执行应用、后台检查、执行应用最近一次任务。
// 只读，不发业务请求；模型状态读本机网关的模型列表。
'use strict';

const guardian = require('./index');

const RECENT_MS = 24 * 60 * 60 * 1000;
const CHECK_LABEL = {
  projection: '投射自愈', assets: '资产体检', setup: '配置提醒', 'share-suggest': '分享推荐', 'device-sync': '多设备对比',
  'capability-gaps': '能力缺口', introspect: '定期自省',
};

async function health() {
  const s = guardian.getSettings();
  const engine = require('./engine');
  const st = engine.status();
  const last = engine.lastTask();
  let model = null;
  try { model = await require('./model-call').modelStatus(); } catch { /* ignore */ }
  // 模型已经可用了，「还没有可用的模型来源」的提醒就地收起，不等下一次配置检查
  if (model && model.ok) guardian.resolveSignature('setup-no-model', '模型已可用');
  const checks = guardian.checkHealth();
  const issues = [];
  if (!s.enabled) return { level: 'off', enabled: false, issues, model, engine: { ...st, last }, checks };
  if (model && !model.ok) issues.push({ code: 'no-model', text: '还没有可用的模型：报错解读、补全描述、提示词增强、新模型试跑暂时只能用规则', link: { to: '/providers', label: '去添加模型' } });
  if (model == null) issues.push({ code: 'gateway-down', text: '本机网关没有响应，用到模型的看护功能暂停' });
  if (!st.ready) issues.push({ code: 'no-runtime', text: '还没有纳管能执行命令的应用：兴趣画像、资产发现、技能安装暂时用不了', link: { to: '/gateway', label: '去纳管应用' } });
  if (last && last.status === 'failed' && Date.now() - last.at < RECENT_MS) {
    issues.push({ code: 'runtime-failed', text: `执行应用最近一次任务失败：${last.error || '未知原因'}` });
  }
  for (const f of checks.failing) issues.push({ code: `check-${f.name}`, text: `后台检查「${CHECK_LABEL[f.name] || f.name}」出错：${f.error}` });
  return { level: issues.length ? 'warn' : 'ok', enabled: true, issues, model, engine: { ...st, last }, checks };
}

module.exports = { health };
