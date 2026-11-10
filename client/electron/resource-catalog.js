// client/electron/resource-catalog.js
// 常见 Prompt / Skill / Assistant 资源目录（参考 aweskill / 社区常见模板）
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const yaml = require('js-yaml');

const USER_CACHE = path.join(os.homedir(), '.tokenbank', 'community-catalog.yaml');
let _cached = null;

const RESOURCE_TYPE_LABELS = {
  prompt: '提示词',
  skill: '技能',
  assistant: '智能体',
};

/** @type {Array<object>} */
const BUILTIN_CATALOG = [
  {
    catalogId: 'code-review-prompt',
    type: 'prompt',
    name: 'code-review',
    display_name: '代码审查',
    description: '结构化代码审查：安全、性能、可维护性',
    metadata: { tags: ['code', 'review', 'quality'], version: '1.0.0', promptKind: 'text' },
    content: `你是一个资深代码审查专家。请审查以下代码，输出：
1. 严重问题（必须修复）
2. 改进建议（可选）
3. 简要总结

{{#if focus_security}}重点关注安全漏洞与权限问题。{{/if}}
{{#if focus_performance}}重点关注性能与资源占用。{{/if}}

代码：
\`\`\`
{{code}}
\`\`\`
`,
  },
  {
    catalogId: 'api-design-prompt',
    type: 'prompt',
    name: 'api-design',
    display_name: 'API 设计',
    description: 'REST/OpenAPI 接口设计与评审',
    metadata: { tags: ['api', 'design', 'backend'], version: '1.0.0', promptKind: 'text' },
    content: `你是 API 架构师。根据需求设计 REST API：
- 资源命名与 HTTP 动词
- 请求/响应 JSON Schema 要点
- 错误码与分页约定
- 鉴权方式建议

需求描述：
{{requirements}}
`,
  },
  {
    catalogId: 'git-commit-skill',
    type: 'skill',
    name: 'git-commit',
    display_name: 'Git 提交规范',
    description: '生成符合 Conventional Commits 的提交信息',
    metadata: {
      tags: ['git', 'commit', 'workflow'],
      version: '1.0.0',
      compatible_agents: ['claude-code', 'codex', 'cursor', 'workbuddy'],
    },
    content: `---
name: git-commit
description: 分析 diff 并生成规范的 Git 提交信息（Conventional Commits）
---

# Git Commit Skill

## 何时使用
用户要求写 commit message、总结变更、或准备 git commit 时。

## 规则
1. 使用 Conventional Commits：feat/fix/docs/refactor/test/chore 等
2. 标题 ≤ 72 字符，英文或中文均可
3. 正文说明 WHY，必要时列出 BREAKING CHANGE

## 输出格式
\`\`\`
<type>(<scope>): <subject>

<body>
\`\`\`
`,
  },
  {
    catalogId: 'systematic-debugging-skill',
    type: 'skill',
    name: 'systematic-debugging',
    display_name: '系统化调试',
    description: '遇 bug 时按步骤收集证据再修复',
    metadata: {
      tags: ['debug', 'quality'],
      version: '1.0.0',
      compatible_agents: ['claude-code', 'codex', 'cursor', 'workbuddy'],
    },
    content: `---
name: systematic-debugging
description: 系统化调试流程，先复现与定位根因再改代码
---

# Systematic Debugging

## 流程
1. 复现：最小步骤、期望 vs 实际
2. 证据：日志、堆栈、最近变更
3. 假设：列出 2–3 个可能根因并验证
4. 修复：最小 diff，附带验证方式
5. 回归：确认未引入新问题

## 禁止
- 未理解根因就大面积重写
- 同时改多处 unrelated 代码
`,
  },
  {
    catalogId: 'python-expert-assistant',
    type: 'assistant',
    name: 'python-expert',
    display_name: 'Python 专家',
    description: 'Python / 数据科学 / Web 开发预设',
    metadata: {
      tags: ['python', 'assistant', 'development'],
      version: '1.0.0',
      category: 'development',
    },
    content: JSON.stringify({
      soul: '你是 Python 专家，精通标准库、类型注解、pytest 与 FastAPI。回答简洁，代码可运行。',
      skills: ['systematic-debugging'],
      prompts: ['code-review'],
      parameters: { temperature: 0.3 },
    }, null, 2),
  },
  // 画像分析 / 资产发现 / 资产安装不再是目录里的系统智能体，角色说明在 guardian/engine.js（看护执行引擎）
];

/** 内置智能体目录 ID（默认自动纳管 + 投射，不可删除） */
const BUILTIN_ASSISTANT_CATALOG_IDS = [];

function isBuiltinAssistantCatalogId(catalogId) {
  return BUILTIN_ASSISTANT_CATALOG_IDS.includes(String(catalogId || ''));
}

function listBuiltinAssistantCatalogItems() {
  return BUILTIN_ASSISTANT_CATALOG_IDS
    .map((id) => BUILTIN_CATALOG.find((c) => c.catalogId === id))
    .filter(Boolean);
}

/** 社区缓存里强制合并/覆盖内置智能体，避免旧缓存缺项或文案过期 */
function mergeBuiltinAssistants(items) {
  const list = Array.isArray(items) ? items.slice() : [];
  for (const builtin of listBuiltinAssistantCatalogItems()) {
    const idx = list.findIndex((i) => i.catalogId === builtin.catalogId);
    if (idx >= 0) {
      list[idx] = {
        ...list[idx],
        ...builtin,
        metadata: { ...(list[idx].metadata || {}), ...(builtin.metadata || {}), builtin: true },
      };
    } else {
      list.push({ ...builtin, metadata: { ...(builtin.metadata || {}), builtin: true } });
    }
  }
  return list;
}

/** 缓存优先:读 ~/.tokenbank/community-catalog.yaml 的三段;无缓存回退 BUILTIN */
function activeCatalog() {
  if (_cached) return _cached;
  try {
    if (fs.existsSync(USER_CACHE)) {
      const doc = yaml.load(fs.readFileSync(USER_CACHE, 'utf8'));
      const merged = []
        .concat(Array.isArray(doc?.prompts) ? doc.prompts : [])
        .concat(Array.isArray(doc?.skills) ? doc.skills : [])
        .concat(Array.isArray(doc?.assistants) ? doc.assistants : [])
        .map(normalizeCacheItem)
        .filter(Boolean);
      if (merged.length) {
        _cached = mergeBuiltinAssistants(merged);
        return _cached;
      }
    }
  } catch (e) {
    console.warn('[resource-catalog] read community cache failed:', e.message);
  }
  _cached = mergeBuiltinAssistants(BUILTIN_CATALOG.slice());
  return _cached;
}

/** yaml snake_case → 运行时字段(与 BUILTIN 条目结构对齐) */
function normalizeCacheItem(raw) {
  if (!raw || !(raw.catalog_id || raw.catalogId)) return null;
  if (!raw.name && !raw.catalog_id) return null;
  const name = raw.name || raw.catalog_id;
  // 未完成的 assistant→agent 改名残留：统一回 assistant
  let type = raw.type;
  if (type === 'agent') type = 'assistant';
  return {
    catalogId: raw.catalog_id || raw.catalogId,
    type,
    name,
    display_name: raw.display_name || raw.displayName || name,
    description: raw.description || '',
    metadata: raw.metadata && typeof raw.metadata === 'object' ? raw.metadata : {},
    content: raw.content || '',
  };
}

function resetCatalogCache() {
  _cached = null;
}

function getCatalogItem(catalogId) {
  // 社区缓存优先；内置兜底（如系统智能体 resource-installer，避免旧缓存缺项）
  return activeCatalog().find(c => c.catalogId === catalogId)
    || BUILTIN_CATALOG.find(c => c.catalogId === catalogId)
    || null;
}

function listCatalogItems(filters = {}) {
  let items = activeCatalog().filter(i => i.type !== 'template');
  if (filters.type) items = items.filter(i => i.type === filters.type);
  if (filters.query) {
    const q = String(filters.query).toLowerCase();
    items = items.filter(i =>
      i.name.includes(q)
      || (i.display_name || '').toLowerCase().includes(q)
      || (i.description || '').toLowerCase().includes(q)
      || (i.metadata?.tags || []).some(t => t.includes(q)),
    );
  }
  return items;
}

function listCatalogGrouped() {
  const groups = {};
  for (const item of activeCatalog()) {
    if (!groups[item.type]) groups[item.type] = [];
    groups[item.type].push(item);
  }
  return groups;
}

module.exports = {
  RESOURCE_TYPE_LABELS,
  BUILTIN_CATALOG,
  BUILTIN_ASSISTANT_CATALOG_IDS,
  isBuiltinAssistantCatalogId,
  listBuiltinAssistantCatalogItems,
  getCatalogItem,
  listCatalogItems,
  listCatalogGrouped,
  resetCatalogCache,
};
