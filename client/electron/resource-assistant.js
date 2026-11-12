// client/electron/resource-assistant.js
// 智能体资源解析：作为 Debug 自定义 Agent 运行
'use strict';

const ASSISTANT_ID_PREFIX = 'assistant:';

const DEFAULT_RUNTIME_AGENT = 'claude-code';

/**
 * 投射到这些 Agent 后，智能体进入游乐场（Debug）可选。
 * 与 resource_project（runtime 能力）配合；WorkBuddy 仅标记启用。
 */
const ASSISTANT_ENABLE_AGENT_IDS = new Set([
  'claude-code', 'codex', 'cursor', 'kimi-code', 'workbuddy', 'pi',
]);

/** Debug 实际可 spawn 的运行时 CLI（须同时具备 resource_project 才可作为贡献/游乐场 runtime） */
const ASSISTANT_RUNTIME_IDS = new Set([
  'claude-code', 'codex', 'cursor', 'kimi-code', 'pi',
]);

/** 当前可作为游乐场/贡献 runtime 的已安装应用 */
function listAvailableAssistantRuntimeIds() {
  try {
    const { listAssistantRuntimeAgentIds } = require('./resource-agent-targets');
    return new Set(
      listAssistantRuntimeAgentIds().filter((id) => ASSISTANT_RUNTIME_IDS.has(id)),
    );
  } catch {
    return new Set(ASSISTANT_RUNTIME_IDS);
  }
}

/** 游乐场副标题用的可读名 */
const ASSISTANT_ENABLE_LABELS = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  'kimi-code': 'Kimi Code',
  workbuddy: 'WorkBuddy',
  pi: 'Pi',
};

/** 是否已投射到可启用 Debug 的目标（含 resource_project runtime） */
function hasAssistantEnableProjection(projections = []) {
  const runtimeOk = listAvailableAssistantRuntimeIds();
  return (projections || []).some((p) => {
    const id = p?.agentId || p?.agent_id;
    if (ASSISTANT_ENABLE_AGENT_IDS.has(id)) return true;
    return runtimeOk.has(id);
  });
}

/**
 * 游乐场「→ xxx」展示名：跟实际运行时一致（Cursor 投射即 Cursor 执行）。
 */
function resolveAssistantDisplayRuntime(projections = [], runtimeAgentId = '') {
  if (runtimeAgentId && ASSISTANT_ENABLE_LABELS[runtimeAgentId]) {
    return ASSISTANT_ENABLE_LABELS[runtimeAgentId];
  }
  const enableIds = [];
  const seen = new Set();
  for (const p of projections || []) {
    const id = p?.agentId || p?.agent_id;
    if (!ASSISTANT_ENABLE_AGENT_IDS.has(id) || seen.has(id)) continue;
    seen.add(id);
    enableIds.push(id);
  }
  if (enableIds.length) {
    return enableIds.map((id) => ASSISTANT_ENABLE_LABELS[id] || id).join(' · ');
  }
  return runtimeAgentId || '';
}

function isAssistantAgentId(agentId) {
  return String(agentId || '').startsWith(ASSISTANT_ID_PREFIX);
}

function assistantResourceId(agentId) {
  if (!isAssistantAgentId(agentId)) return null;
  return String(agentId).slice(ASSISTANT_ID_PREFIX.length);
}

/** 解析智能体配置（JSON 或纯文本 soul） */
function parseAssistantConfig(content) {
  const text = String(content || '').trim();
  if (!text) {
    return {
      soul: '',
      skills: [],
      prompts: [],
      mcp: [],
      model: '',
      parameters: {},
      runtime_agent: DEFAULT_RUNTIME_AGENT,
    };
  }

  if (text.startsWith('{')) {
    try {
      const raw = JSON.parse(text);
      return {
        // soul 为主字段；兼容旧版 system_prompt / systemPrompt
        soul: String(raw.soul || raw.system_prompt || raw.systemPrompt || '').trim(),
        skills: Array.isArray(raw.skills) ? raw.skills.map(String) : [],
        prompts: Array.isArray(raw.prompts) ? raw.prompts.map(String) : [],
        mcp: Array.isArray(raw.mcp) ? raw.mcp.map(String) : [],
        // 智能体绑定的模型(可选);运行时启动时注入,不再随运行时环境默认走
        model: String(raw.model || (raw.parameters && raw.parameters.model) || '').trim(),
        parameters: raw.parameters && typeof raw.parameters === 'object' ? raw.parameters : {},
        runtime_agent: String(raw.runtime_agent || raw.runtimeAgent || DEFAULT_RUNTIME_AGENT).trim()
          || DEFAULT_RUNTIME_AGENT,
      };
    } catch {
      // 回退为纯文本 soul
    }
  }

  return {
    soul: text,
    skills: [],
    prompts: [],
    mcp: [],
    model: '',
    parameters: {},
    runtime_agent: DEFAULT_RUNTIME_AGENT,
  };
}

/** 拼接关联 Prompt / Skill 说明到 system 上下文 */
function resolveAssistantContext(config, resourceManager) {
  const parts = [];
  if (config.soul) parts.push(config.soul);

  for (const promptName of config.prompts || []) {
    const row = resourceManager._findByTypeName('prompt', promptName);
    if (row?.content) {
      parts.push(`## ${row.display_name || promptName}\n${row.content}`);
    }
  }

  if (config.skills?.length) {
    parts.push(
      `## 可用 Skill\n请在任务中按需遵循以下 Skill：${config.skills.join('、')}`,
    );
  }

  return parts.filter(Boolean).join('\n\n');
}

/**
 * 生成底层 CLI Agent 的启动参数
 * @param {object} [opts]
 * @param {boolean} [opts.includeDelivery=false] 是否附带产物落盘规则。本地默认关；仅显式打开时加
 * @returns {{ runtimeAgentId: string, claudeExtraArgs?: string[], promptPrefix?: string }}
 */
function buildAssistantLaunch(runtimeAgentId, systemText, model, opts = {}) {
  const { DELIVERY_POLICY, withClaudeDeliverySystemArgs } = require('./agent-delivery-policy');
  const includeDelivery = opts.includeDelivery === true;
  const soul = String(systemText || '').trim();
  // soul +（可选）产物落盘规则
  let system = soul;
  if (includeDelivery) {
    system = soul
      ? (soul.includes('【Token Bank 产物交付】') ? soul : `${soul}\n\n${DELIVERY_POLICY}`)
      : DELIVERY_POLICY;
  }
  const mdl = String(model || '').trim();

  if (runtimeAgentId === 'claude-code') {
    let extra = [
      '-p', '--dangerously-skip-permissions',
      '--output-format', 'stream-json',
      '--verbose',
    ];
    if (mdl) extra.push('--model', mdl); // 用纳管智能体绑定的模型,而非运行时环境默认
    if (system) extra.push('--append-system-prompt', system);
    else if (includeDelivery) extra = withClaudeDeliverySystemArgs(extra);
    return { runtimeAgentId, claudeExtraArgs: extra };
  }

  if (runtimeAgentId === 'codex') {
    // codex 模型经其自身 config.toml,暂不从此处注入 -m(参数位置因版本而异,避免拼错)
    return {
      runtimeAgentId,
      promptPrefix: system ? `${system}\n\n` : '',
    };
  }

  if (runtimeAgentId === 'cursor') {
    // Cursor CLI 无 --append-system-prompt：soul 作 prompt 前缀；模型经 buildArgs --model
    return {
      runtimeAgentId,
      promptPrefix: system ? `${system}\n\n` : '',
      model: mdl || undefined,
    };
  }

  if (runtimeAgentId === 'kimi-code') {
    // Kimi 无 append-system-prompt：soul 作前缀；模型经 -m
    return {
      runtimeAgentId,
      promptPrefix: system ? `${system}\n\n` : '',
      model: mdl || undefined,
    };
  }

  if (runtimeAgentId === 'pi') {
    // Pi 无系统提示参数：soul 作前缀；模型经 --model
    return {
      runtimeAgentId,
      promptPrefix: system ? `${system}\n\n` : '',
      model: mdl || undefined,
    };
  }

  throw new Error(`智能体暂不支持运行时 Agent: ${runtimeAgentId}`);
}

/** 将智能体 JSON 规范为 soul 字段（去掉 system_prompt / systemPrompt） */
function formatAssistantContent(content) {
  const text = String(content || '').trim();
  if (!text) return text;
  if (!text.startsWith('{')) return text;

  try {
    const raw = JSON.parse(text);
    const config = parseAssistantConfig(text);
    const out = {};
    if (config.soul) out.soul = config.soul;
    if (config.skills?.length) out.skills = config.skills;
    if (config.prompts?.length) out.prompts = config.prompts;
    if (config.runtime_agent && config.runtime_agent !== DEFAULT_RUNTIME_AGENT) {
      out.runtime_agent = config.runtime_agent;
    }
    if (config.parameters && Object.keys(config.parameters).length) {
      out.parameters = config.parameters;
    }
    // 保留其它扩展字段，但丢弃旧版 system_prompt 键
    for (const [key, val] of Object.entries(raw)) {
      if (key === 'system_prompt' || key === 'systemPrompt' || key === 'soul'
        || key === 'skills' || key === 'prompts' || key === 'runtime_agent'
        || key === 'runtimeAgent' || key === 'parameters') continue;
      out[key] = val;
    }
    return `${JSON.stringify(out, null, 2)}\n`;
  } catch {
    return text;
  }
}

/**
 * 解析智能体实际运行时：
 * - 已投射到 claude-code / codex / cursor / kimi-code 时，以投射为准
 * - 仅投射到 workbuddy 等非运行时目标时，回退 content.runtime_agent
 * - 无可用投射时回退 content.runtime_agent
 */
function resolveAssistantRuntimeAgent(config, projections = [], availableIds = null) {
  const configured = String(config?.runtime_agent || DEFAULT_RUNTIME_AGENT).trim() || DEFAULT_RUNTIME_AGENT;
  const fromProj = [];
  const seen = new Set();
  let projectedRuntime = false;
  for (const p of projections || []) {
    const id = p?.agentId || p?.agent_id;
    if (!ASSISTANT_RUNTIME_IDS.has(id) || seen.has(id)) continue;
    projectedRuntime = true;
    if (availableIds && !availableIds.has(id)) continue;
    seen.add(id);
    fromProj.push(id);
  }
  // 投射到了能跑它的应用、但这些应用现在都用不了：算跑不起来，不换到没投射过的应用上
  if (projectedRuntime && !fromProj.length && availableIds) return null;
  if (!fromProj.length) {
    // 仅 WorkBuddy 等启用投射：优先配置的运行时；未安装则任选可用 CLI
    if (!availableIds) return configured;
    if (availableIds.has(configured)) return configured;
    for (const id of ASSISTANT_RUNTIME_IDS) {
      if (availableIds.has(id)) return id;
    }
    return null;
  }
  if (fromProj.includes(configured)) return configured;
  return fromProj[0];
}

/** 投射过、能跑它的应用（按投射顺序；availableIds 给了就只留本机能用的） */
function projectedRuntimeIds(projections = [], availableIds = null) {
  const out = [];
  for (const p of projections || []) {
    const id = p?.agentId || p?.agent_id;
    if (!ASSISTANT_RUNTIME_IDS.has(id) || out.includes(id)) continue;
    if (availableIds && !availableIds.has(id)) continue;
    out.push(id);
  }
  return out;
}

/** 写入 runtime_agent 到智能体 content（保持 soul/skills/prompts） */
function withAssistantRuntimeAgent(content, runtimeAgentId) {
  const config = parseAssistantConfig(content);
  const runtime = String(runtimeAgentId || DEFAULT_RUNTIME_AGENT).trim() || DEFAULT_RUNTIME_AGENT;
  const payload = {};
  if (config.soul) payload.soul = config.soul;
  if (config.skills?.length) payload.skills = config.skills;
  if (config.prompts?.length) payload.prompts = config.prompts;
  if (config.parameters && Object.keys(config.parameters).length) payload.parameters = config.parameters;
  payload.runtime_agent = runtime;
  // 保留其它扩展字段
  const text = String(content || '').trim();
  if (text.startsWith('{')) {
    try {
      const raw = JSON.parse(text);
      for (const [key, val] of Object.entries(raw)) {
        if (key === 'system_prompt' || key === 'systemPrompt' || key === 'soul'
          || key === 'skills' || key === 'prompts' || key === 'runtime_agent'
          || key === 'runtimeAgent' || key === 'parameters') continue;
        payload[key] = val;
      }
    } catch { /* ignore */ }
  }
  return formatAssistantContent(JSON.stringify(payload));
}

function assistantContentNeedsMigration(content) {
  const text = String(content || '').trim();
  if (!text.startsWith('{')) return false;
  try {
    const raw = JSON.parse(text);
    return Object.prototype.hasOwnProperty.call(raw, 'system_prompt')
      || Object.prototype.hasOwnProperty.call(raw, 'systemPrompt');
  } catch {
    return false;
  }
}

module.exports = {
  projectedRuntimeIds,
  ASSISTANT_ID_PREFIX,
  DEFAULT_RUNTIME_AGENT,
  ASSISTANT_ENABLE_AGENT_IDS,
  ASSISTANT_RUNTIME_IDS,
  listAvailableAssistantRuntimeIds,
  hasAssistantEnableProjection,
  resolveAssistantDisplayRuntime,
  isAssistantAgentId,
  assistantResourceId,
  parseAssistantConfig,
  resolveAssistantContext,
  resolveAssistantRuntimeAgent,
  withAssistantRuntimeAgent,
  buildAssistantLaunch,
  formatAssistantContent,
  assistantContentNeedsMigration,
};
