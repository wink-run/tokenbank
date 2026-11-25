/**
import { projectWithGuard } from './project-guard';
 * 启用包：纳管后默认投射 + 生成点将口令（反笔记「藏而不用」）
 */

/** 默认可写主公优先序 */
export const DEFAULT_LORD_IDS = ['cursor', 'claude-code', 'codex', 'workbuddy'];

/** 生成点将/取兵器口令 */
export function buildInvokeText(resource, lang = 'zh') {
  const name = resource?.display_name || resource?.name || '';
  const type = resource?.type || '';
  if (!name) return '';
  if (lang === 'en') {
    if (type === 'assistant') {
      return `Summon the "${name}" agent from Token Bank to complete this task.`;
    }
    if (type === 'prompt') {
      return `Use the "${name}" prompt from Token Bank (tb_get_resource) for this task.`;
    }
    return `Use the "${name}" skill from Token Bank for this task.`;
  }
  if (type === 'assistant') {
    return `召唤 Token Bank 中的「${name}」智能体来完成当前任务。`;
  }
  if (type === 'prompt') {
    return `使用 Token Bank 提示词「${name}」完成当前任务（tb_get_resource）。`;
  }
  return `按 Token Bank 技能「${name}」完成本任务。`;
}

/**
 * 生成 MCP 在应用对话中的试用口令（复制后粘贴到对应 Agent 即可试验）
 * 内置 Token Bank MCP 给具体工具示例；其它按名称给通用调用句。
 */
export function buildMcpInvokeText(server, lang = 'zh') {
  const id = String(server?.id || server?.name || '').toLowerCase();
  const name = server?.display_name || server?.name || server?.id || 'MCP';
  const en = lang === 'en';

  if (id === 'tokenbank') {
    return en
      ? 'Call tb_capabilities, then tb_list_resources to show what I can use in this session.'
      : '请先 tb_capabilities，再 tb_list_resources 列出本会话可用的资产。';
  }
  if (id.includes('sequential') || /sequential.?thinking/i.test(name)) {
    return en
      ? 'Use Sequential Thinking to reason step by step: how would you design a simple rate limiter?'
      : '请用 Sequential Thinking 分步推理：如何设计一个简单的请求限流器？';
  }
  if (id.includes('firecrawl') || /firecrawl/i.test(name)) {
    return en
      ? 'Use firecrawl to scrape and summarize the homepage of https://example.com'
      : '请用 firecrawl 抓取并摘要 https://example.com 的首页内容。';
  }
  if (id.includes('filesystem') || /filesystem|文件/i.test(name)) {
    return en
      ? `Use the "${name}" MCP to list files in the current project directory.`
      : `请用 MCP「${name}」列出当前项目目录下的文件。`;
  }
  if (id.includes('github') || /github/i.test(name)) {
    return en
      ? `Use the "${name}" MCP to summarize open issues in this repo.`
      : `请用 MCP「${name}」摘要本仓库的 open issues。`;
  }
  if (id.includes('memory') || /memory|记忆/i.test(name)) {
    return en
      ? `Use the "${name}" MCP to store a short note: "Token Bank MCP smoke test".`
      : `请用 MCP「${name}」记一条短笔记：「Token Bank MCP 冒烟测试」。`;
  }
  // 通用兜底：点名 MCP，让模型自行选工具
  return en
    ? `Use the "${name}" MCP tools to help with a small smoke-test task, and briefly report which tool you called.`
    : `请调用 MCP「${name}」的工具做一次小冒烟测试，并简短说明你调用了哪个工具。`;
}

/**
 * 纳管成功后：投射到应用（技能、提示词给所有已装的，智能体按场景挑），返回口令与投射结果
 * @returns {{ agentIds: string[], invokeText: string, projected: boolean }}
 */
export async function completeEnablePackage(resource, { lang = 'zh' } = {}) {
  if (!resource?.id || !window.electronAPI?.resource?.project) {
    return { agentIds: [], invokeText: buildInvokeText(resource, lang), projected: false };
  }

  let candidates = [...DEFAULT_LORD_IDS];
  let installedIds = [];
  try {
    const res = await window.electronAPI.resource.listAgentTargets();
    const targets = (res && (res.agents || res.targets || res.items)) || [];
    const ids = targets
      .map((a) => a.id || a.agentId || a.agent_id)
      .filter(Boolean);
    installedIds = ids;
    if (ids.length) {
      const preferred = DEFAULT_LORD_IDS.filter((id) => ids.includes(id));
      candidates = preferred.length ? preferred : ids.slice(0, 4);
    }
  } catch {
    /* 用默认优先序 */
  }

  if (resource.type === 'skill' || resource.type === 'prompt') {
    // 技能、提示词：投射到所有已装的应用。技能平时只占名字和一句说明，用到才读全文，多放几个应用不影响选得准不准；
    // 只给少数应用，用户换个应用就找不到了
    if (installedIds.length) candidates = installedIds;
  } else {
    // 智能体：投射到哪个应用就在哪个应用里跑，按场景挑最近真正在用的应用（没有使用记录时照旧）
    try {
      const pref = await window.electronAPI.guardian?.preferredTargets?.({ resourceType: resource.type, candidates: installedIds.length ? installedIds : candidates });
      if (pref?.agentIds?.length) candidates = pref.agentIds;
    } catch {
      /* 看护不可用时照旧 */
    }
  }

  // 已有投射则不再强行改
  const existing = (resource.projections || [])
    .map((p) => p.agentId || p.agent_id)
    .filter(Boolean);
  const need = candidates.filter((id) => !existing.includes(id));
  let projected = existing.length > 0;
  let usedIds = existing.slice();

  if (need.length) {
    try {
      const proj = await projectWithGuard(
        { resourceId: resource.id, agentIds: need },
        { name: resource.display_name || resource.name, lang },
      );
      if (proj && proj.success) {
        projected = true;
        usedIds = [...new Set([...existing, ...need])];
      }
    } catch {
      /* 投射失败仍返回口令，便于用户手动投 */
    }
  }

  return {
    agentIds: usedIds,
    invokeText: buildInvokeText(resource, lang),
    projected,
  };
}

export async function copyText(text) {
  const s = String(text || '');
  if (!s) return false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(s);
      return true;
    }
  } catch { /* ignore */ }
  return false;
}
