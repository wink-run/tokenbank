// client/electron/guardian/health.js
// 看护的运行状态（设置页顶部的标志）：总开关、模型、执行应用、后台检查、执行应用最近一次任务。
// 只读，不发业务请求；模型状态读本机网关的模型列表。
'use strict';

const guardian = require('./index');

const RECENT_MS = 24 * 60 * 60 * 1000;

function label(id) {
  try { return require('../config-loader').appEntityById(id)?.name || id; } catch { return id; }
}
const CHECK_LABEL = {
  projection: '投射自愈', assets: '资产体检', setup: '配置提醒', routes: '路由检查',
  'capability-gaps': '能力缺口',
};

async function health() {
  const s = guardian.getSettings();
  const engine = require('./engine');
  const st = engine.status();
  const runningKinds = await engine.runningTasks();   // 先和执行器对一遍账，再读最近一次结果
  const last = engine.lastTask();
  let model = null;
  try { model = await require('./model-call').modelStatus(); } catch { /* ignore */ }
  // 模型已经可用了，「还没有可用的模型来源」的提醒就地收起，不等下一次配置检查
  if (model && model.ok) guardian.resolveSignature('setup-no-model', '模型已可用');
  const checks = guardian.checkHealth();
  // 正在执行的事：后台检查、定期自省、执行应用里的画像 / 发现 / 安装
  const KIND_LABEL = { install: '技能安装' };
  const busy = [
    ...guardian.runningCheckNames().map(n => `检查「${CHECK_LABEL[n] || n}」`),
    ...runningKinds.map(k => `${KIND_LABEL[k] || k}（${label(st.runtime)}）`),
  ];
  const issues = [];
  if (!s.enabled) return { level: 'off', enabled: false, issues, model, engine: { ...st, last }, checks, busy: [] };
  if (model && !model.ok) issues.push({ code: 'no-model', text: '还没有可用的模型：报错解读、补全描述、提示词增强、新模型试跑暂时只能用规则', link: { to: '/providers', label: '去添加模型' } });
  if (model == null) issues.push({ code: 'gateway-down', text: '本机网关没有响应，用到模型的看护功能暂停' });
  if (!st.ready) issues.push({ code: 'no-runtime', text: '还没有纳管能执行命令的应用：兴趣画像、资产发现、技能安装暂时用不了', link: { to: '/gateway', label: '去纳管应用' } });
  if (last && last.status === 'failed' && Date.now() - last.at < RECENT_MS) {
    issues.push({ code: 'runtime-failed', text: `执行应用最近一次任务失败：${last.error || '未知原因'}` });
  }
  for (const f of checks.failing) issues.push({ code: `check-${f.name}`, text: `后台检查「${CHECK_LABEL[f.name] || f.name}」出错：${f.error}` });
  return { level: issues.length ? 'warn' : 'ok', enabled: true, issues, model, engine: { ...st, last }, checks, busy };
}

module.exports = { health };
