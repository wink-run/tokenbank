// client/electron/tokenbank-tools.js
// Token Bank 的 MCP 工具：只有这一份定义和实现，都在网关进程里执行。
//   本机应用：网关 /mcp/<应用>（直接连，或经写进应用配置的 tokenbank-mcp-stdio.js 转过来）
//   外部智能体：网关 /mcp，凭注册时拿到的 tbx_ token（tokenbank-mcp.js）
// 能看到哪些工具按调用方的权限：off / read / operate / full；智能管家另有改资产的工具。
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const LEVELS = ['off', 'read', 'operate', 'full'];
const GUARDIAN_CLIENT_ID = 'guardian-chat';

/** 连上时给模型看一次的用法说明（以前每次 tb_list_agents 都附一段规则，现在只说这一次） */
const INSTRUCTIONS = [
  'Token Bank 是用户的模型网关和智能体管家。',
  '- 用户问到 Token Bank（有哪些工具、MCP、模型、技能、智能体、设备，能做什么）：用这里的工具查，先 tb_capabilities。不要去读 ~/.tokenbank 下的文件自己拼，那是内部数据，拼出来常是错的。',
  '- 不用等用户提 Token Bank：任务要用到专门的做法（翻译、写周报、做 PPT 这类）、别的模型（画图、向量等）、交给别的智能体或第三方服务时，先看 Token Bank 有没有现成的——工具说明里列了现在有哪些智能体、提示词、模型和能接活的智能体，合适就用。简单的事直接做，不用每次都查。',
  '- 不确定能做什么：先 tb_capabilities。',
  '- 用户说「用某某智能体 / 技能 / 提示词」：tb_list_resources 找到，tb_get_resource 取正文，在当前对话里照着做。',
  '- 要用模型：tb_list_models；技能里写死的模型可能不存在，用 preferred 检查并换成能用的。',
  '- 交给别的智能体做：tb_list_agents → tb_dispatch_agent。本机智能体优先，其次雇来的社区智能体，最后命令行工具；只从名单里选，选描述最贴合这件事的。互不依赖的子任务用 background=true 一起派出去，再 tb_task_status(wait="any") 逐个收。',
  '- 要用第三方服务（搜索、GitHub、Slack 等）、HTTP API 或本地命令，但你的工具列表里没有：tb_list_resources(type=mcp) 看接入了哪些、参数叫什么，再 tb_call_mcp。这类事不要派给智能体。',
  '- 不要臆造资产内容。安装、投射、改设置请用户在 Token Bank 里操作。',
  '能用哪些工具由用户在 Token Bank 给你的权限决定。',
].join('\n');

const TOOLS = [
  {
    name: 'tb_capabilities',
    level: 'read',
    description: '用户问 Token Bank 能做什么、接了哪些工具 / MCP / API / 命令时先调这个，一次就能答全：可用工具、已接入的第三方 MCP、HTTP API 和本地命令、网关接口地址。不确定该用哪个工具时也先调它。别去读 ~/.tokenbank 下的文件。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'tb_list_resources',
    level: 'read',
    description: '用户问「我有哪些技能 / 智能体 / 提示词 / MCP」时用这个查（不要去翻 ~/.tokenbank 或技能目录）：列出 Token Bank 资产库里的智能体、技能、提示词，以及接入这个应用的第三方 MCP、HTTP API、本地命令。source=catalog 列社区目录里的（没安装的要用户在 Token Bank 里安装）。',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['assistant', 'skill', 'prompt', 'mcp', 'api', 'cli', 'all'],
          description: 'assistant=智能体，skill=技能，prompt=提示词，mcp=第三方 MCP，api=HTTP API，cli=本地命令；默认 all',
        },
        query: { type: 'string', description: '可选：按名称、描述筛选' },
        source: { type: 'string', enum: ['mine', 'catalog'], description: 'mine（默认）=已有的；catalog=社区目录' },
      },
    },
  },
  {
    name: 'tb_get_resource',
    level: 'read',
    description: '取一项资产的内容。智能体：人设和技能全文，在当前对话里照着做；技能：SKILL.md；提示词：正文（args 填 $ARGUMENTS）；MCP、API、命令：怎么调用。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '名称、显示名，或 #<id>' },
        type: { type: 'string', enum: ['assistant', 'skill', 'prompt', 'mcp', 'api', 'cli'], description: '可选：类型，重名时用' },
        args: { type: 'string', description: '提示词用：填进模板里的 $ARGUMENTS' },
        mode: { type: 'string', enum: ['activate', 'summary'], description: '智能体用：activate（默认）给全文，summary 只给简介' },
        page: { type: 'integer', description: 'MCP 用：工具很多时翻页（按它自己的顺序，每页 20 个）' },
      },
      required: ['name'],
    },
  },
  {
    name: 'tb_list_agents',
    level: 'read',
    description: '用户问有哪些智能体能用、能把活交给谁时用这个：列出能接任务的智能体，本机的、我其他设备上的、雇来的社区智能体，和本机命令行工具（Claude Code、Codex 等）。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'tb_dispatch_agent',
    level: 'operate',
    description: '把一个子任务交给 tb_list_agents 里的智能体。默认等它做完；background=true 马上返回任务号，之后用 tb_task_status 收结果。',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: 'tb_list_agents 里的 id。我其他设备上的写 mine:<智能体>@<设备>（不写 @设备 自动挑）' },
        prompt: { type: 'string', description: '要做的事：目标、背景、约束、交付什么（路径或格式），别丢用户给的关键细节' },
        background: { type: 'boolean', description: 'true：不等结果，马上返回任务号' },
        previous_task_id: { type: 'string', description: '接着之前某个子任务的对话继续，比如按反馈再改一版' },
        plan_step: { type: 'string', description: '可选：对应 tb_plan 里的哪一步（步骤 id），派出后计划里会跟上它的进度' },
      },
      required: ['agent_id', 'prompt'],
    },
  },
  {
    name: 'tb_plan',
    level: 'operate',
    description: '记下或查看这批任务的派发计划（智能体路由派活时用）。带 steps 是写计划；不带就看计划：每步做到哪了、哪些依赖已完成可以派了。',
    inputSchema: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          description: '计划的步骤：[{ id, title, agent, depends_on: [步骤 id] }]。再写一次会更新，已派出的步骤保留进度',
          items: { type: 'object' },
        },
      },
    },
  },
  {
    name: 'tb_notes',
    level: 'operate',
    description: '一批任务的协作区：成员之间对接口、说阻塞、交代产出。不带 post 是看最近的留言；带 post 是留言，to 写给谁（智能体 id 或「全部」）。',
    inputSchema: {
      type: 'object',
      properties: {
        team: { type: 'string', description: '团队号（派活时提示里给的）；在派活方那边可以不写' },
        post: { type: 'string', description: '要留的话' },
        to: { type: 'string', description: '写给谁，可不写' },
      },
    },
  },
  {
    name: 'tb_task_status',
    level: 'read',
    description: '查子任务的进度和结果。wait="any" 等到任意一个做完，"all" 等全部做完，不写立刻返回。',
    inputSchema: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string' }, description: 'tb_dispatch_agent 返回的任务号' },
        wait: { type: 'string', enum: ['none', 'any', 'all'] },
        timeout_seconds: { type: 'number', description: '最多等多久，默认 60，最多 600' },
        detail: { type: 'boolean', description: 'true 给完整结果；默认只给摘要和产出清单' },
      },
      required: ['ids'],
    },
  },
  {
    name: 'tb_hire_community_agent',
    level: 'full',
    description: '雇一个社区智能体（花积分），任务在对方设备上执行。雇好后用 tb_dispatch_agent 派活；带 prompt 就雇完马上做一次。',
    inputSchema: {
      type: 'object',
      properties: {
        assistant_id: { type: 'string', description: '社区智能体 id（Token Bank「交易」页能看到）' },
        owner: { type: 'string', description: '出租方用户名' },
        prompt: { type: 'string', description: '可选：雇完马上做的事' },
      },
      required: ['assistant_id'],
    },
  },
  {
    name: 'tb_list_models',
    level: 'read',
    description: '用户问 Token Bank 里有哪些模型能用时用这个（不要去读配置文件）：列出网关里能用的模型（聊天、图像、向量）。给了 preferred 就检查它在不在，不在时换成同类能用的。',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['chat', 'image', 'embedding', 'all'], description: '默认 all' },
        preferred: { type: 'string', description: '可选：想用的模型 id，比如技能里写的那个' },
      },
    },
  },
  {
    name: 'tb_chat',
    level: 'operate',
    description: '让网关里的某个模型直接回答一个问题，不经过智能体。',
    inputSchema: {
      type: 'object',
      properties: {
        model: { type: 'string', description: 'tb_list_models 里的 id' },
        prompt: { type: 'string' },
        system: { type: 'string', description: '可选：系统提示' },
        max_tokens: { type: 'number' },
      },
      required: ['model', 'prompt'],
    },
  },
  {
    name: 'tb_list_devices',
    level: 'read',
    description: '列出我名下的设备：在不在线、怎么连、上面有哪些应用、模型和工作区。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'tb_call_mcp',
    level: 'full',
    description: '调用已接入的第三方 MCP 工具，或用户登记的 HTTP API、本地命令。server 填名称；tool 填工具名，API 和命令填 call。工具很多的 MCP 不会逐个出现在你的工具列表里：先 tb_get_resource(type=mcp, name) 看它自己的使用说明和工具再调。',
    inputSchema: {
      type: 'object',
      properties: {
        server: { type: 'string', description: '名称，比如 pipeworx' },
        tool: { type: 'string', description: '工具名，比如 ask_pipeworx；API 和命令填 call' },
        arguments: { type: 'object', description: '传给工具的参数' },
      },
      required: ['server', 'tool'],
    },
  },
];

/** 只给智能管家：和资产页同一批接口，别的调用方看不到也调不了 */
const GUARDIAN_TOOLS = [
  {
    name: 'tb_save_resource',
    description:
      '新建或修改资产，和资产页点保存同一条接口。禁止直接改数据库。'
      + '智能体只换技能清单时传 id + skills，人设和其它字段保留；也可传 soul、prompts、runtime_agent、content、display_name、description、metadata。'
      + '不传 id、给出 name 和 type 就是新建。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '已有资源 id。不传就是新建' },
        name: { type: 'string', description: '资源 name。新建必填；没有 id 时也可用来定位' },
        type: { type: 'string', enum: ['assistant', 'skill', 'prompt'] },
        display_name: { type: 'string' },
        description: { type: 'string' },
        content: { type: 'string', description: '完整正文。智能体改技能时不必传' },
        skills: { type: 'array', items: { type: 'string' }, description: '智能体技能清单，给出就替换，其它字段保留' },
        prompts: { type: 'array', items: { type: 'string' }, description: '智能体提示词清单' },
        soul: { type: 'string', description: '智能体人设' },
        runtime_agent: { type: 'string', description: '智能体运行时，如 claude-code、codex' },
        metadata: { type: 'object', description: '完整 metadata，和资产页保存一样整份写入' },
      },
    },
  },
  {
    name: 'tb_delete_resource',
    description: '删除一条资产，和资产页删除同一条接口。技能还有投射时先撤下，或 force=true 连投射一起卸。内置智能体删不掉。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        type: { type: 'string', enum: ['assistant', 'skill', 'prompt'] },
        force: { type: 'boolean' },
      },
    },
  },
  {
    name: 'tb_project_resource',
    description: '投射到应用，和资产页启用同一条接口。高风险技能返回 security-risk，向用户说明、他确认后再 allowRisky=true；目标已有同名目录时看 conflicts，用户确认后再 force=true。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        type: { type: 'string', enum: ['assistant', 'skill', 'prompt'] },
        agentIds: { type: 'array', items: { type: 'string' }, description: '应用 id，如 codex、claude-code、cursor' },
        force: { type: 'boolean' },
        allowRisky: { type: 'boolean' },
      },
    },
  },
  {
    name: 'tb_unproject_resource',
    description: '撤下投射，资产还在。和资产页取消投射同一条接口。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        type: { type: 'string', enum: ['assistant', 'skill', 'prompt'] },
        agentId: { type: 'string' },
        agentIds: { type: 'array', items: { type: 'string' } },
        projectionId: { type: 'string' },
      },
    },
  },
  {
    name: 'tb_verify_projections',
    description: '检查一条资产的投射是否还在。repair=true 时修好能修的软链。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        type: { type: 'string', enum: ['assistant', 'skill', 'prompt'] },
        repair: { type: 'boolean' },
      },
    },
  },
  {
    name: 'tb_sync_skills',
    description: '重新扫描本机技能目录并纳管。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'tb_import_resource',
    description: '从本机路径导入技能或文本，和资产页导入同一条接口。',
    inputSchema: {
      type: 'object',
      properties: {
        sourcePath: { type: 'string', description: '文件或技能目录的本机路径' },
        type: { type: 'string', enum: ['skill', 'prompt', 'assistant'] },
      },
      required: ['sourcePath'],
    },
  },
  {
    name: 'tb_install_resource',
    description: '安装技能，和资产页安装同一条接口。source 可以是 owner/repo、GitHub 地址或免费目录名。付费社区条目不要在这里装。',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string' },
        catalogId: { type: 'string' },
        force: { type: 'boolean' },
      },
    },
  },
];

const GUARDIAN_OPS = {
  tb_save_resource: 'save',
  tb_delete_resource: 'delete',
  tb_project_resource: 'project',
  tb_unproject_resource: 'unproject',
  tb_verify_projections: 'verify',
  tb_sync_skills: 'sync',
  tb_import_resource: 'import',
  tb_install_resource: 'install',
};

// ── 权限 ────────────────────────────────────────────────────────────────────

function normalizeLevel(level, fallback = 'off') {
  return LEVELS.includes(level) ? level : fallback;
}

/** 这个权限下能用的工具名 */
function allowedNames(level) {
  const n = LEVELS.indexOf(normalizeLevel(level));
  return new Set(TOOLS.filter((t) => n > 0 && LEVELS.indexOf(t.level) <= n).map((t) => t.name));
}

function isGuardian(ctx) {
  return !!ctx?.guardian;
}

// ── 工具说明里附上「现在有什么」──────────────────────────────────────────────
// 模型每次开始都看工具列表：在几个工具的说明里写上现有的智能体、提示词、模型、能接活的智能体（名字 + 一句话），
// 不用用户提 Token Bank、也不用先调一次，碰到合适的任务它自己就会想到用。技能和第三方 MCP 已经直接在应用里，不重复。
// 取数据有缓存（一分钟），过期了先给旧的、后台再取；第一次最多等一小会，工具列表不能慢（Cursor 等不了）。

const HINT_TTL = 60 * 1000;
const HINT_WAIT = 800;
const HINT_MAX = 12;
const hintCache = new Map(); // cid → { at, hints, pending }

function clip(text, n = 40) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/** 「名字（一句话）、名字…（共 N 个）」 */
function nameList(items, label) {
  if (!items.length) return '';
  const shown = items.slice(0, HINT_MAX).map((x) => (x.desc ? `${x.name}（${clip(x.desc, 24)}）` : x.name));
  return `${label}：${shown.join('、')}${items.length > HINT_MAX ? ` 等，共 ${items.length} 个` : ''}`;
}

async function computeHints(ctx) {
  const out = {};
  const cid = ctx.clientId || '';
  const settle = (p) => Promise.race([p, new Promise((r) => setTimeout(() => r(null), 3000))]).catch(() => null);
  const [res, models, agents] = await Promise.all([
    settle((async () => {
      const store = rm();
      const pick = (fn) => (store[fn]('') || []).map((r) => ({ name: r.display_name || r.name, desc: r.description }));
      return { assistants: pick('listAssistantsForClient'), prompts: pick('listPromptsForClient') };
    })()),
    settle(fetchModels(ctx)),
    settle(dispatchTargets((ctx.dispatch || {}).agentRouteId || '')),
  ]);
  if (res) {
    const parts = [nameList(res.assistants, '智能体'), nameList(res.prompts, '提示词')].filter(Boolean);
    if (parts.length) out.tb_get_resource = `现在资产库里有——${parts.join('；')}。任务和其中哪个对得上，就 tb_get_resource 取来照着做。`;
  }
  if (Array.isArray(models) && models.length) {
    const by = (type) => models.filter((m) => (m.model_type || 'chat') === type).map((m) => ({ name: m.id }));
    const parts = [nameList(by('chat'), '聊天'), nameList(by('image'), '图像'), nameList(by('embedding'), '向量')].filter(Boolean);
    if (parts.length) out.tb_list_models = `现在能用的模型——${parts.join('；')}。`;
  }
  if (Array.isArray(agents)) {
    const list = agents.filter((a) => a && a.id && !a.guardian).map((a) => ({ name: a.name || a.id, desc: a.description }));
    const text = nameList(list, '能接活的智能体');
    if (text) out.tb_dispatch_agent = `${text}。任务适合交给其中某个时派给它（tb_list_agents 看完整名单和 id）。`;
  }
  return out;
}

/** 现在有什么（按应用缓存）：有缓存先给，过期后台刷新；没有就最多等 HINT_WAIT */
async function catalogHints(ctx = {}) {
  const key = `${ctx.clientId || ''}|${(ctx.dispatch || {}).agentRouteId || ''}`;
  const hit = hintCache.get(key);
  const refresh = () => {
    if (hit?.pending) return hit.pending;
    const pending = computeHints(ctx).then((hints) => {
      hintCache.set(key, { at: Date.now(), hints });
      return hints;
    }).catch(() => (hintCache.get(key)?.hints || {}));
    hintCache.set(key, { ...(hintCache.get(key) || {}), pending });
    return pending;
  };
  if (hit?.hints) {
    if (Date.now() - hit.at > HINT_TTL) refresh();
    return hit.hints;
  }
  const pending = refresh();
  return Promise.race([pending, new Promise((r) => setTimeout(() => r({}), HINT_WAIT))]);
}

/** 带「现在有什么」的工具列表（给应用 tools/list 用） */
async function listToolsWithHints(ctx = {}) {
  const base = listTools(ctx);
  let hints = {};
  try { hints = await catalogHints(ctx); } catch { hints = {}; }
  return base.map((t) => (hints[t.name] ? { ...t, description: `${t.description}\n${hints[t.name]}` } : t));
}

/** 给 tools/list 的列表（不带内部的 level 字段） */
function listTools(ctx = {}) {
  const allow = allowedNames(ctx.level);
  const out = TOOLS.filter((t) => allow.has(t.name)).map(({ level, ...rest }) => rest);
  return isGuardian(ctx) ? out.concat(GUARDIAN_TOOLS) : out;
}

function isToolName(name) {
  return TOOLS.some((t) => t.name === name) || !!GUARDIAN_OPS[name];
}

function textResult(text, isError = false) {
  return { content: [{ type: 'text', text: String(text) }], isError: !!isError };
}

// ── 派活上下文 ──────────────────────────────────────────────────────────────

/**
 * 子任务挂在哪个父任务下、在哪个目录做。调用方（stdio 转发的环境变量）给的优先，
 * 其次是 Token Bank 编排时为这个应用写下的当前任务（bridge-context.json）。
 */
function dispatchContext(clientId, given = {}) {
  let row = {};
  try {
    const file = path.join(os.homedir(), '.tokenbank', 'mcp', 'bridge-context.json');
    const byClient = JSON.parse(fs.readFileSync(file, 'utf8'))?.byClient;
    if (byClient && typeof byClient === 'object') row = byClient[clientId] || byClient.default || {};
  } catch { /* 没有编排上下文 */ }
  const pick = (k) => String(given[k] || row[k] || '');
  return {
    parentTaskId: pick('parentTaskId'),
    parentSessionKey: pick('parentSessionKey'),
    parentSessionInstance: pick('parentSessionInstance'),
    agentRouteId: pick('agentRouteId'),
    workingDir: String(given.workingDir || row.workingDir || given.cwd || process.cwd()),
  };
}

// ── 智能体 ──────────────────────────────────────────────────────────────────

const STATUS_TEXT = {
  pending: '排队中', running: '进行中', completed: '完成', failed: '失败',
  cancelled: '已取消', unreachable: '那台设备暂时连不上', not_found: '找不到',
};

function summarize(raw, agentId) {
  try {
    return require('./agent-output-parser').summarizeAgentStdout(raw, agentId === 'codex' ? 'codex' : 'claude-code');
  } catch {
    return raw;
  }
}

/** 先列状态，再贴已做完的结果 */
function formatTaskStatus(tasks = [], { detail = false } = {}) {
  const done = ['completed', 'failed', 'cancelled'];
  const lines = tasks.map((t) => {
    const device = t.result?.device || t.context?.meshDevice;
    return `- ${t.id} [${t.agent_id || '?'}${device ? ` @${device}` : ''}] ${STATUS_TEXT[t.status] || t.status}`;
  });
  const bodies = tasks.filter((t) => done.includes(t.status)).map((t) => {
    const raw = t.result?.output || t.result?.summary || '';
    const out = t.status === 'completed'
      ? (t.result?.summary || summarize(raw, t.agent_id) || '(无输出)')
      : (t.error || raw || t.status);
    const text = String(out);
    const body = detail ? text.slice(0, 20000) : (text.length > 1500 ? `${text.slice(0, 1500)}…（摘要，全文用 detail=true）` : text);
    return `### ${t.id}（${STATUS_TEXT[t.status] || t.status}）\n${body}`;
  });
  const left = tasks.length - tasks.filter((t) => done.includes(t.status) || t.status === 'not_found').length;
  const tail = left > 0 ? `\n还有 ${left} 个没做完，可以再用 tb_task_status 等。` : '';
  return [lines.join('\n'), ...bodies].join('\n\n') + tail;
}

function executor() {
  return require('./agent-executor');
}

/** 能派的目标：本机智能体 + 我其他设备上的；走智能体路由时只留这条路由允许的 */
async function dispatchTargets(routeId = '') {
  const ex = executor();
  const all = await (typeof ex.listDispatchTargets === 'function' ? ex.listDispatchTargets() : ex.listAvailableAgents());
  if (!routeId) return all;
  const routes = require('./agent-routes');
  const route = routes.get(routeId);
  return route ? routes.filterAgents(route, all) : all;
}

/** 路由名单之外的不派（尤其是没打开开关的雇来的社区智能体，会扣积分） */
async function checkRoute(agentId, routeId) {
  if (!routeId) return;
  const routes = require('./agent-routes');
  const route = routes.get(routeId);
  if (route && !routes.canDispatchTo(route, agentId, await dispatchTargets())) {
    throw new Error(`「${route.name}」的名单里没有 ${agentId}，只能派给 tb_list_agents 列出的智能体`);
  }
}

function dispatchOpts(ctx, extra = {}) {
  const d = ctx.dispatch || dispatchContext(ctx.clientId || '');
  return {
    workingDir: d.workingDir,
    parentTaskId: d.parentTaskId || undefined,
    parentSessionKey: d.parentSessionKey || undefined,
    parentSessionInstanceId: d.parentSessionInstance || undefined,
    clientId: ctx.clientId || '',
    mode: 'worker',
    ...extra,
  };
}

const KIND_TEXT = { assistant: '本机智能体', community: '社区智能体（对方设备上做）', mine: '我的设备' };

async function listAgents(ctx) {
  const routeId = (ctx.dispatch || {}).agentRouteId || '';
  const agents = await dispatchTargets(routeId);
  const rank = (t) => (t === 'assistant' ? 0 : t === 'community' ? 1 : t === 'mine' ? 2 : 3);
  // 智能管家只在游乐场回答 Token Bank 自己的问题，不接派发的子任务
  const sorted = [...(agents || [])].filter((a) => a && a.id && !a.guardian).sort((a, b) =>
    rank(a.type) - rank(b.type) || String(a.name || '').localeCompare(String(b.name || '')),
  );
  const lines = sorted.map((a) => {
    const caps = (a.capabilities || []).join(', ');
    const desc = a.description ? ` — ${String(a.description).slice(0, 160)}` : '';
    const ver = a.version ? ` (v${a.version})` : '';
    const runtime = a.runtimeName ? ` @${a.runtimeName}` : '';
    return `- ${a.id}: ${a.name}${ver}${runtime} [${KIND_TEXT[a.type] || '命令行工具'}]${caps ? ` (${caps})` : ''}${desc}`;
  });
  // 走智能体路由时，带上这条路由的派发规则
  let routeRules = '';
  if (routeId) {
    try {
      const routes = require('./agent-routes');
      const route = routes.get(routeId);
      if (route) routeRules = routes.rulesText(route);
    } catch { /* 读不到就不带 */ }
  }
  const body = lines.length ? lines.join('\n') : '（没有能接任务的智能体：请自己完成，并告诉用户）';
  return textResult(routeRules ? `${routeRules}\n\n${body}` : body);
}

async function dispatchAgent(args, ctx) {
  const agentId = String(args.agent_id || '').trim();
  const prompt = String(args.prompt || '').trim();
  if (!agentId || !prompt) return textResult('缺少 agent_id 或 prompt', true);
  if (ctx.selfAgentId && agentId === ctx.selfAgentId) return textResult('不能把任务派给你自己', true);
  try {
    await checkRoute(agentId, (ctx.dispatch || {}).agentRouteId);
    // 走智能体路由的一批任务：查预算、给子任务补一句协作区、派出后记进计划
    const team = require('./agent-team');
    const teamId = team.teamOf((ctx.dispatch || {}).parentTaskId);
    if (teamId) team.checkBudget(teamId, agentId);
    const step = String(args.plan_step || '').trim() || undefined;
    const fullPrompt = teamId ? `${prompt}${team.childPromptSuffix(teamId)}` : prompt;
    const opts = dispatchOpts(ctx, { previousTaskId: String(args.previous_task_id || '').trim() || undefined });
    if (args.background === true || args.background === 'true') {
      const t = await executor().dispatch(agentId, fullPrompt, opts);
      if (teamId) team.noteDispatch(teamId, { taskId: t.taskId, agentId: t.agentId || agentId, step });
      const where = t.device ? `，在「${t.device}」上执行` : '';
      return textResult(`[${t.agentId || agentId}] 已派出${where}。任务号：${t.taskId}\n用 tb_task_status(ids=["${t.taskId}"], wait="any") 收结果。`);
    }
    if (teamId) team.noteDispatch(teamId, { taskId: null, agentId, step: undefined });
    const status = await executor().dispatchAndWait(agentId, fullPrompt, opts);
    const doneId = status.id || status.task_id;
    if (teamId && step && doneId) team.linkStep(teamId, step, doneId, agentId);
    const id = status.agent_id || agentId;
    if (status.status === 'completed') {
      const raw = status.result?.output || status.result?.summary || '';
      return textResult(`[${id}] 完成:\n${status.result?.summary || summarize(raw, id) || '(无输出)'}`);
    }
    return textResult(`[${id}] 没做成（${status.status}）:\n${status.error || status.result?.output || '未知错误'}`, true);
  } catch (e) {
    return textResult(`派发失败：${e.message}`, true);
  }
}

async function taskStatus(args) {
  const ids = (Array.isArray(args.ids) ? args.ids : String(args.ids || '').split(','))
    .map((x) => String(x || '').trim()).filter(Boolean);
  if (!ids.length) return textResult('缺少 ids', true);
  const wait = ['any', 'all'].includes(args.wait) ? args.wait : 'none';
  const secs = Math.min(Math.max(Number(args.timeout_seconds) || 60, 1), 600);
  try {
    const tasks = await executor().waitTasks(ids, { wait, timeoutMs: secs * 1000 });
    return textResult(formatTaskStatus(tasks, { detail: args.detail === true || args.detail === 'true' }));
  } catch (e) {
    return textResult(`查询失败：${e.message}`, true);
  }
}

function teamFor(args, ctx) {
  const team = require('./agent-team');
  const given = String(args.team || '').trim();
  if (given && team.read(given)) return given;
  return team.teamOf((ctx.dispatch || {}).parentTaskId);
}

function planTool(args, ctx) {
  const team = require('./agent-team');
  const teamId = teamFor(args, ctx);
  if (!teamId) return textResult('现在不在一批路由任务里（只有走智能体路由派活时才有计划）', true);
  if (Array.isArray(args.steps)) {
    if (!args.steps.length) return textResult('steps 是空的', true);
    team.setPlan(teamId, args.steps);
  }
  return textResult(`计划（团队 ${teamId}）：\n${team.planText(team.planView(teamId))}`);
}

function notesTool(args, ctx) {
  const team = require('./agent-team');
  const teamId = teamFor(args, ctx);
  if (!teamId) return textResult('现在不在一批路由任务里，没有协作区', true);
  const post = String(args.post || '').trim();
  if (post) {
    team.addNote(teamId, { from: ctx.selfAgentId || ctx.clientId || '', to: args.to, text: post });
  }
  const list = team.notes(teamId);
  const fmt = (n) => `- [${new Date(n.at).toLocaleTimeString()}] ${n.from}${n.to ? ` → ${n.to}` : ''}：${n.text}`;
  return textResult(`${post ? '已留言。\n' : ''}协作区（团队 ${teamId}）：\n${list.length ? list.map(fmt).join('\n') : '（还没有留言）'}`);
}

async function hireCommunityAgent(args, ctx) {
  const assistantId = String(args.assistant_id || '').trim();
  if (!assistantId) return textResult('缺少 assistant_id', true);
  try {
    const entry = require('./hired-community-agents').hire({
      assistant_id: assistantId,
      owner: args.owner,
      display_name: args.display_name,
      runtime: args.runtime,
      description: args.description,
    });
    const prompt = String(args.prompt || '').trim();
    if (!prompt) return textResult(`已雇佣：${entry.id}（${entry.display_name}）。用 tb_dispatch_agent 派活。`);
    await checkRoute(entry.id, (ctx.dispatch || {}).agentRouteId);
    const team = require('./agent-team');
    const teamId = team.teamOf((ctx.dispatch || {}).parentTaskId);
    if (teamId) { team.checkBudget(teamId, entry.id); team.noteDispatch(teamId, { taskId: null, agentId: entry.id }); }
    const status = await executor().dispatchAndWait(entry.id, prompt, dispatchOpts(ctx));
    if (status.status === 'completed') {
      return textResult(`已雇佣并完成 [${entry.id}]:\n${status.result?.summary || status.result?.output || '(无输出)'}`);
    }
    return textResult(`已雇佣，但任务没做成 [${entry.id}]：${status.error || status.status}`, true);
  } catch (e) {
    return textResult(`雇佣失败：${e.message}`, true);
  }
}

// ── 模型 ────────────────────────────────────────────────────────────────────

/** 模型名启发式推断模态（与前端 gatewayModels.inferModelTypeFromName 对齐） */
function inferModelTypeFromName(id) {
  const n = String(id || '').toLowerCase();
  if (/(?:^|[\-_/])image(?:[\-_/]|$|\d)|gpt-image|dall-e|stable-diffusion|flux-|midjourney/.test(n)) return 'image';
  if (/embed|text-embedding|bge-|e5-/.test(n)) return 'embedding';
  return 'chat';
}

function normalizeModel(raw) {
  const id = typeof raw === 'string' ? raw : (raw?.id || raw?.name || '');
  if (!id) return null;
  const owned_by = (typeof raw === 'object' && raw?.owned_by) || 'tokenbank';
  const explicit = typeof raw === 'object' ? (raw.model_type || raw.type || raw.modality || null) : null;
  return { id: String(id), owned_by: String(owned_by), model_type: explicit || inferModelTypeFromName(id) };
}

function filterByType(models, type) {
  const t = String(type || 'all').toLowerCase();
  return !t || t === 'all' ? models : models.filter((m) => m.model_type === t);
}

/** 同类里挑一个：精确 → 名字相近 → 按 id 排第一个 */
function pickAlternative(models, preferred, type) {
  const pool = filterByType(models, type);
  if (!pool.length) return null;
  const want = String(preferred || '').trim().toLowerCase();
  const exact = pool.find((m) => m.id.toLowerCase() === want);
  if (exact) return exact;
  if (want) {
    const fuzzy = pool.find((m) => m.id.toLowerCase().includes(want) || want.includes(m.id.toLowerCase()));
    if (fuzzy) return fuzzy;
  }
  return [...pool].sort((a, b) => a.id.localeCompare(b.id))[0];
}

let _listModelsImpl = null;
/** 单测注入 */
function setListModelsImpl(fn) {
  _listModelsImpl = typeof fn === 'function' ? fn : null;
}

function gatewayUrl(ctx) {
  if (ctx?.gatewayUrl) return String(ctx.gatewayUrl).replace(/\/$/, '');
  return require('./tb-capabilities').gatewayBaseUrl();
}

async function fetchModels(ctx) {
  if (_listModelsImpl) return _listModelsImpl();
  const r = await fetch(`${gatewayUrl(ctx)}/v1/models`, { signal: AbortSignal.timeout(4000) });
  if (!r.ok) throw new Error(`网关 /v1/models HTTP ${r.status}`);
  const j = await r.json();
  return (Array.isArray(j?.data) ? j.data : []).map(normalizeModel).filter(Boolean);
}

async function listModels(args, ctx) {
  let models;
  try {
    models = await fetchModels(ctx);
  } catch (e) {
    return textResult(`读不到模型列表：${e.message}。请确认 Token Bank 在运行。`, true);
  }
  const preferred = String(args.preferred || '').trim();
  if (preferred) {
    const type = String(args.type && args.type !== 'all' ? args.type : inferModelTypeFromName(preferred)).toLowerCase();
    const hit = models.find((m) => m.id.toLowerCase() === preferred.toLowerCase());
    if (hit) return textResult(JSON.stringify({ available: true, model: hit.id, model_type: hit.model_type, message: `能用：${hit.id}` }, null, 2));
    const alt = pickAlternative(models, preferred, type);
    if (!alt) {
      return textResult(JSON.stringify({ available: false, preferred, model: null, model_type: type, message: `${preferred} 不能用，网关里也没有别的 ${type} 模型` }, null, 2), true);
    }
    return textResult(JSON.stringify({
      available: false,
      preferred,
      model: alt.id,
      model_type: type,
      alternatives: filterByType(models, type).map((m) => m.id).slice(0, 12),
      message: `${preferred} 不能用，换成 ${alt.id}`,
    }, null, 2));
  }
  const list = filterByType(models, args.type);
  if (!list.length) {
    return textResult(args.type && args.type !== 'all'
      ? `（没有 ${args.type} 类的模型）`
      : '（网关里还没有模型：请用户在 Token Bank「模型」页添加）');
  }
  const count = { chat: 0, image: 0, embedding: 0 };
  for (const m of list) if (count[m.model_type] != null) count[m.model_type] += 1;
  const lines = [...list]
    .sort((a, b) => a.model_type.localeCompare(b.model_type) || a.id.localeCompare(b.id))
    .map((m) => `- ${m.id} [${m.model_type}]`);
  return textResult(`共 ${list.length} 个：聊天 ${count.chat}，图像 ${count.image}，向量 ${count.embedding}\n${lines.join('\n')}`);
}

async function chat(args, ctx) {
  const model = String(args.model || '').trim();
  const prompt = String(args.prompt || '').trim();
  if (!model || !prompt) return textResult('需要 model 和 prompt', true);
  const messages = [...(args.system ? [{ role: 'system', content: String(args.system) }] : []), { role: 'user', content: prompt }];
  try {
    const r = await fetch(`${gatewayUrl(ctx)}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(ctx.gatewayKey ? { Authorization: `Bearer ${ctx.gatewayKey}` } : {}) },
      body: JSON.stringify({ model, messages, stream: false, ...(args.max_tokens ? { max_tokens: Number(args.max_tokens) } : {}) }),
      signal: AbortSignal.timeout(180000),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return textResult(`模型调用失败（HTTP ${r.status}）：${j?.error?.message || ''}`, true);
    return textResult(j?.choices?.[0]?.message?.content || '');
  } catch (e) {
    return textResult(`模型调用失败：${e.message}`, true);
  }
}

// ── 设备 ────────────────────────────────────────────────────────────────────

function listDevices() {
  let view;
  try { view = require('./mesh/glue').devicesView(); } catch { view = { enabled: false, devices: [] }; }
  if (!view.enabled) return textResult('设备网络没开：只有这一台设备。');
  const lines = view.devices.map((d) => {
    const conn = d.self ? '本机' : !d.online ? '离线' : d.connection === 'relay' ? `在线（经${d.via?.label || '中继'}）` : '在线';
    const apps = (d.apps || []).map((a) => a.id).join(', ') || '—';
    const models = (d.models || []).slice(0, 12).join(', ') || '—';
    const ws = (d.workspaces || []).map((w) => w.name).join(', ') || '—';
    return `- ${d.label}（${conn}）\n  应用：${apps}\n  模型：${models}\n  工作区：${ws}`;
  });
  return textResult(`${lines.join('\n')}\n\n派活到某台设备：tb_dispatch_agent(agent_id="mine:<应用>@<设备>")`);
}

// ── 资产 ────────────────────────────────────────────────────────────────────

let _resourceManager = null;
let _relayedLister = null;
let _plainLister = null;
/** 单测注入 */
function setResourceManager(rm) { _resourceManager = rm || null; }
function setRelayedMcpLister(fn) { _relayedLister = typeof fn === 'function' ? fn : null; }
function setPlainToolLister(fn) { _plainLister = typeof fn === 'function' ? fn : null; }
let _toolDefsLister = null;
/** 单测注入：(cid) => { 前缀: [{ name, description, inputSchema }] } */
function setRelayedToolDefs(fn) { _toolDefsLister = typeof fn === 'function' ? fn : null; }

/** 第三方 MCP 每个工具的定义，按前缀分组；拿不到时是 {}（只能给工具名） */
async function relayedToolDefs(cid) {
  try {
    return (await (_toolDefsLister ? _toolDefsLister(cid) : require('./mcp-gateway-server').relayedToolDefs(cid))) || {};
  } catch {
    return {};
  }
}

/** 工具签名：slack_post_message(channel, text, thread_ts?)，可选参数带 ? */
function signature(def) {
  const props = def?.inputSchema?.properties && typeof def.inputSchema.properties === 'object' ? Object.keys(def.inputSchema.properties) : [];
  const required = new Set(Array.isArray(def?.inputSchema?.required) ? def.inputSchema.required : []);
  const params = [...props.filter((k) => required.has(k)), ...props.filter((k) => !required.has(k)).map((k) => `${k}?`)];
  return `${def.name}(${params.join(', ')})`;
}

/**
 * 工具多的 MCP（超过 BIG_MCP 个）不逐个列给模型。Token Bank 不替它挑工具：只给它自己写的使用说明，
 * 和它自己工具列表里的一页（按它给的顺序），里面用哪个由它的说明和工具决定（比如 Pipeworx 让先调 discover_tools）
 */
const BIG_MCP = 40;
const PAGE = 20;

function pageOf(defs, page) {
  const n = Math.max(1, parseInt(page, 10) || 1);
  return { n, pages: Math.max(1, Math.ceil((defs || []).length / PAGE)), items: (defs || []).slice((n - 1) * PAGE, n * PAGE) };
}

function bigMcpHint(name, n) {
  return `${name} 有 ${n} 个工具，太多不全列。用 tb_get_resource(type="mcp", name="${name}") 看它自己的使用说明和工具（page 翻页），再 tb_call_mcp 调`;
}

/** 各 MCP 自己的使用说明 { 前缀: 文本 } */
function relayedInstructions(cid) {
  try { return require('./mcp-gateway-server').relayedInstructions(cid) || {}; } catch { return {}; }
}

/** 按工具定义检查参数：缺了必填的、填了不认识的。返回问题描述，没问题返回 '' */
function checkArgs(def, args) {
  const schema = def?.inputSchema || {};
  const props = schema.properties && typeof schema.properties === 'object' ? schema.properties : null;
  const a = args && typeof args === 'object' ? args : {};
  const missing = (Array.isArray(schema.required) ? schema.required : []).filter((k) => a[k] == null || a[k] === '');
  const unknown = props && schema.additionalProperties !== true ? Object.keys(a).filter((k) => !(k in props)) : [];
  const parts = [];
  if (missing.length) parts.push(`缺少 ${missing.join('、')}`);
  if (unknown.length) parts.push(`没有这些参数：${unknown.join('、')}`);
  return parts.join('；');
}

function rm() {
  return _resourceManager || require('./resource-manager');
}

function relayedMcps(cid) {
  try {
    return (_relayedLister ? _relayedLister(cid) : require('./mcp-manager').listRelayedMcpsForClient(cid)) || [];
  } catch {
    return [];
  }
}

function plainTools(cid, type) {
  let list = [];
  try {
    list = (_plainLister ? _plainLister(cid) : require('./mcp-manager').listConfiguredPlainTools(cid)) || [];
  } catch { /* 没有 */ }
  return list.filter((s) => !type || s.type === type);
}

function matchRef(list, ref, extra = () => false) {
  const raw = String(ref || '').trim().toLowerCase();
  if (!raw) return null;
  return list.find((s) => s.id?.toLowerCase() === raw
    || s.name?.toLowerCase() === raw
    || String(s.display_name || '').toLowerCase() === raw
    || extra(s, raw)) || null;
}

function findRelayedMcp(cid, ref) {
  return matchRef(relayedMcps(cid), ref, (s, raw) => s.prefix?.toLowerCase() === raw);
}

function findPlainTool(cid, ref, type) {
  return matchRef(plainTools(cid, type), ref);
}

function mcpRows(cid, defs = {}) {
  return relayedMcps(cid).map((s) => ({
    type: 'mcp', id: s.id, name: s.name, display_name: s.display_name, description: s.description, tools: s.tools, prefix: s.prefix,
    toolDefs: defs[s.prefix] || null,
  }));
}

function readSkillBody(resource) {
  try {
    const dir = require('./resource-canonical').resolveAuthorityDir(resource);
    if (dir) {
      const skillMd = path.join(dir, 'SKILL.md');
      if (fs.existsSync(skillMd)) return fs.readFileSync(skillMd, 'utf8');
    }
  } catch { /* 用库里的正文 */ }
  return String(resource.content || '');
}

function findManagedResource(store, type, ref, cid = '') {
  const raw = String(ref || '').trim();
  if (!raw) return null;
  if (raw.startsWith('#')) {
    const byId = store.getResource(raw.slice(1).trim());
    return byId && (!type || byId.type === type) ? byId : null;
  }
  const matchName = (r) => r.name === raw || r.id === raw || (r.display_name && r.display_name === raw);
  if (type && ['skill', 'assistant', 'prompt'].includes(type)) {
    const hit = store.listResources({ type }).find(matchName);
    if (hit) return hit;
  }
  if (!type) {
    const byId = store.getResource(raw);
    if (byId) return byId;
    for (const t of ['skill', 'assistant', 'prompt']) {
      const hit = store.listResources({ type: t }).find(matchName);
      if (hit) return hit;
    }
  }
  if (!type || type === 'mcp') {
    const mcp = findRelayedMcp(cid, raw);
    if (mcp) return { ...mcp, type: 'mcp' };
  }
  if (!type || type === 'api' || type === 'cli') {
    const tool = findPlainTool(cid, raw, type || '');
    if (tool) return tool;
  }
  return null;
}

const TYPE_TEXT = { assistant: '智能体', skill: '技能', prompt: '提示词', mcp: 'MCP', api: 'HTTP API', cli: '本地命令' };

function formatResourceLine(r) {
  const disp = r.display_name && r.display_name !== r.name ? ` (${r.display_name})` : '';
  const desc = r.description ? `: ${String(r.description).slice(0, 120)}` : '';
  // MCP：拿得到定义就一行一个工具、带参数名（模型列出来就直接调，参数名不能让它猜）
  if (r.type === 'mcp' && Array.isArray(r.toolDefs) && r.toolDefs.length > BIG_MCP) {
    return [`- [MCP] ${r.name}${disp}${desc}`, `    ${bigMcpHint(r.name, r.toolDefs.length)}`].join('\n');
  }
  if (r.type === 'mcp' && Array.isArray(r.toolDefs) && r.toolDefs.length) {
    const lines = r.toolDefs.map((d) => `    ${signature(d)}${d.description ? `：${String(d.description).slice(0, 80)}` : ''}`);
    return [`- [MCP] ${r.name}${disp}${desc}`, ...lines].join('\n');
  }
  const names = r.type === 'mcp' && Array.isArray(r.tools) ? r.tools.filter(Boolean) : [];
  const tools = names.length > BIG_MCP ? `（${bigMcpHint(r.name, names.length)}）`
    : names.length ? ` [工具: ${names.join(', ')}]` : '';
  return `- [${TYPE_TEXT[r.type] || r.type}] ${r.name}${disp}${desc}${tools}`;
}

function formatResourceDetail(r) {
  if (r.type === 'skill') {
    return [`# 技能：${r.name}`, r.description ? `说明：${r.description}` : '', '', readSkillBody(r) || '(无正文)'].filter((x) => x !== '').join('\n');
  }
  if (r.type === 'assistant') {
    const cfg = require('./resource-assistant').parseAssistantConfig(r.content);
    return JSON.stringify({
      type: 'assistant',
      id: r.id,
      name: r.name,
      display_name: r.display_name,
      description: r.description,
      dispatch_id: `assistant:${r.id}`,
      soul_preview: String(cfg.soul || '').slice(0, 400),
      skills: cfg.skills,
      prompts: cfg.prompts,
      mcp: cfg.mcp,
      model: cfg.model || null,
      runtime_agent: cfg.runtime_agent,
    }, null, 2);
  }
  if (r.type === 'mcp') {
    const all = Array.isArray(r.toolDefs) ? r.toolDefs : [];
    const big = all.length > BIG_MCP;
    // 工具多的：按它自己的顺序给一页，加上它自己写的使用说明；Token Bank 不挑
    const pg = pageOf(all, r.page);
    const shown = big ? pg.items : all;
    const tools = all.length
      ? shown.map((d) => ({ name: d.name, description: d.description || '', parameters: d.inputSchema || {} }))
      : (r.tools || []).filter(Boolean).slice(0, SHOW_MAX);
    const first = typeof tools[0] === 'string' ? tools[0] : tools[0]?.name;
    return JSON.stringify({
      type: 'mcp', id: r.id, name: r.name, display_name: r.display_name, description: r.description,
      ...(r.instructions ? { instructions: r.instructions } : {}),
      ...(big ? {
        tool_count: all.length,
        page: `${pg.n}/${pg.pages}`,
        note: `工具太多，按它自己的顺序分页给（每页 ${PAGE} 个）。先看 instructions 里它让怎么找工具；翻页：tb_get_resource(type="mcp", name="${r.name}", page=${pg.n + 1})`,
      } : {}),
      tools,
      usage: `tb_call_mcp(server="${r.name}", tool="${first || '<工具名>'}", arguments={按 parameters 填})`,
    }, null, 2);
  }
  if (r.type === 'api') {
    return JSON.stringify({
      type: 'api', id: r.id, name: r.name, display_name: r.display_name, description: r.description,
      method: r.method || 'POST', url: r.url || '', headers: r.headers || {}, body: r.body || '', timeout_ms: r.timeout_ms || null,
      usage: `tb_call_mcp(server="${r.name}", tool="call", arguments={字段:实际值})。arguments 会覆盖请求体模板里的同名字段，别沿用模板里的示例值。`,
    }, null, 2);
  }
  if (r.type === 'cli') {
    return JSON.stringify({
      type: 'cli', id: r.id, name: r.name, display_name: r.display_name, description: r.description,
      command: r.command || '', args: r.args || [], cwd: r.cwd || '',
      usage: `tb_call_mcp(server="${r.name}", tool="call", arguments={...})。命令以保存的配置为准。`,
    }, null, 2);
  }
  return JSON.stringify({ type: r.type, id: r.id, name: r.name, display_name: r.display_name, description: r.description }, null, 2);
}

/** 智能管家看到的资产原文，和资产页编辑器同一份 */
function formatLibraryRecord(r) {
  const record = {
    type: r.type,
    id: r.id,
    name: r.name,
    display_name: r.display_name,
    description: r.description || '',
    content: r.content || '',
    metadata: r.metadata || {},
    projections: (r.projections || []).map((p) => p.agentId || p.agent_id).filter(Boolean),
    hash: r.hash || null,
    updated_at: r.updated_at || null,
  };
  if (r.type === 'assistant') {
    try {
      const cfg = JSON.parse(r.content || '{}');
      record.soul = cfg.soul || '';
      record.skills = cfg.skills || [];
      record.prompts = cfg.prompts || [];
      record.runtime_agent = cfg.runtime_agent || '';
    } catch { /* 正文不是 JSON 时原样留在 content */ }
  }
  return JSON.stringify(record, null, 2);
}

function listCatalog(args) {
  const type = String(args.type || 'all').toLowerCase();
  const filters = {};
  if (['skill', 'assistant', 'prompt'].includes(type)) filters.type = type;
  if (args.query) filters.query = String(args.query).trim();
  const { items } = rm().listCatalog(filters);
  if (!items.length) return textResult('（社区目录里没有）');
  const lines = items.map((it) => {
    const disp = it.display_name && it.display_name !== it.name ? ` (${it.display_name})` : '';
    const desc = it.description ? `: ${String(it.description).slice(0, 100)}` : '';
    return `- [${TYPE_TEXT[it.type] || it.type}|${it.installed ? '已有' : '未安装'}] ${it.name}${disp}${desc}`;
  });
  return textResult(`社区目录 ${items.length} 项（未安装的请用户在 Token Bank 里安装）\n${lines.join('\n')}`);
}

async function listResources(args, ctx) {
  if (args.source === 'catalog') return listCatalog(args);
  const store = rm();
  const cid = ctx.clientId || '';
  const type = String(args.type || 'all').toLowerCase();
  const query = String(args.query || '').trim().toLowerCase();
  const library = isGuardian(ctx);
  // 智能体、技能、提示词：资产库里有就能用，不按应用投射限制（按名字用时才取正文，不占上下文）
  const managed = (t) => {
    if (library) return (store.listResources({ type: t }) || []).map((r) => ({ ...r, type: t }));
    const fn = { assistant: 'listAssistantsForClient', skill: 'listSkillsForClient', prompt: 'listPromptsForClient' }[t];
    return (store[fn]('') || []).map((r) => ({ ...r, type: t }));
  };
  const wantMcp = type === 'mcp' || type === 'all';
  const mcp = wantMcp && relayedMcps(cid).length ? mcpRows(cid, await relayedToolDefs(cid)) : [];
  let rows;
  if (['assistant', 'skill', 'prompt'].includes(type)) rows = managed(type);
  else if (type === 'mcp') rows = mcp;
  else if (type === 'api' || type === 'cli') rows = plainTools(cid, type);
  else rows = [...managed('assistant'), ...managed('skill'), ...managed('prompt'), ...mcp, ...plainTools(cid)];
  if (query) {
    rows = rows.filter((r) => `${r.name || ''} ${r.display_name || ''} ${r.description || ''} ${(r.tools || []).join(' ')}`.toLowerCase().includes(query));
  }
  if (!rows.length) {
    const label = TYPE_TEXT[type] || '资产';
    // 带了关键词没找到：别说成「资产库是空的」，模型会照着告诉用户
    if (query) {
      return textResult(`没有找到和「${args.query}」相关的${label}。不带关键词再列一次可以看到全部；社区里的可以用 source=catalog 搜。`);
    }
    return textResult(library
      ? `（资产库里没有${label}）`
      : type === 'mcp' || type === 'api' || type === 'cli'
        ? `（还没有接入的${label}：请用户在 Token Bank「资产 → 工具」添加到这个应用）`
        : `（资产库里还没有${label}：请用户在 Token Bank「资产」页添加；社区里的可以用 source=catalog 看）`);
  }
  const count = {};
  for (const r of rows) count[r.type] = (count[r.type] || 0) + 1;
  const summary = Object.entries(count).map(([t, n]) => `${TYPE_TEXT[t] || t} ${n}`).join('，');
  return textResult(`${summary}\n${rows.map(formatResourceLine).join('\n')}`);
}

function activateAssistant(store, ref, cid, mode) {
  const resolved = store.resolveAssistantForClient(ref, '');
  if (!resolved.found) return textResult(`资产库里没有这个智能体：${ref}。先 tb_list_resources(type=assistant) 看看。`, true);
  if (mode === 'summary' && resolved.resource) return textResult(formatResourceDetail({ ...resolved.resource, type: 'assistant' }));
  try { store.recordResourceHit?.(resolved.id, cid); } catch { /* 只是统计 */ }
  return textResult([
    `# 智能体：${resolved.resource?.display_name || resolved.name}`,
    `（在当前对话里按下面的人设和技能做；要交给它单独去做，用 tb_dispatch_agent(agent_id="assistant:${resolved.id}")）`,
    '',
    resolved.text || '(无正文)',
  ].join('\n'));
}

function promptText(store, ref, args, cid) {
  const resolved = store.resolvePromptForClient(ref, String(args || ''), '');
  if (!resolved.found) return textResult(`资产库里没有这个提示词：${ref}。先 tb_list_resources(type=prompt) 看看。`, true);
  try { store.recordResourceHit?.(resolved.id, cid); } catch { /* 只是统计 */ }
  return textResult(resolved.text || '');
}

async function getResource(args, ctx) {
  const ref = String(args.name || '').trim();
  if (!ref) return textResult('缺少 name', true);
  const store = rm();
  const cid = ctx.clientId || '';
  const type = args.type ? String(args.type).toLowerCase() : '';
  const mode = String(args.mode || 'activate').toLowerCase();
  try {
    if (type === 'mcp') {
      const hit = findRelayedMcp(cid, ref);
      if (!hit) return textResult(`没有接入这个 MCP：${ref}。先 tb_list_resources(type=mcp) 看看。`, true);
      const defs = await relayedToolDefs(cid);
      return textResult(formatResourceDetail({ ...hit, type: 'mcp', toolDefs: defs[hit.prefix] || null, instructions: relayedInstructions(cid)[hit.prefix] || '', page: args.page }));
    }
    if (type === 'api' || type === 'cli') {
      const hit = findPlainTool(cid, ref, type);
      return hit ? textResult(formatResourceDetail(hit))
        : textResult(`没有给你用的${TYPE_TEXT[type]}：${ref}。先 tb_list_resources(type=${type}) 看看。`, true);
    }
    if (isGuardian(ctx)) {
      const record = findManagedResource(store, type || null, ref, cid);
      if (!record || !['skill', 'assistant', 'prompt'].includes(record.type)) return textResult(`资产库里没有：${ref}`, true);
      return textResult(formatLibraryRecord(record));
    }
    if (type === 'assistant') return activateAssistant(store, ref, cid, mode);
    if (type === 'prompt') return promptText(store, ref, args.args, cid);
    const r = findManagedResource(store, type || null, ref, cid);
    if (!r) return textResult(`找不到：${ref}${type ? `（${TYPE_TEXT[type] || type}）` : ''}。先 tb_list_resources 看看。`, true);
    if (r.type === 'assistant') return activateAssistant(store, r.name || ref, cid, mode);
    if (r.type === 'prompt') return promptText(store, r.name || ref, args.args, cid);
    if (r.type === 'mcp') return textResult(formatResourceDetail({ ...r, toolDefs: (await relayedToolDefs(cid))[r.prefix] || null, instructions: relayedInstructions(cid)[r.prefix] || '', page: args.page }));
    if (r.type === 'skill') {
      try { store.recordResourceHit?.(r.id, cid); } catch { /* 只是统计 */ }
    }
    return textResult(formatResourceDetail(r));
  } catch (e) {
    return textResult(`读取失败：${e.message}`, true);
  }
}

async function capabilities(ctx) {
  const caps = require('./tb-capabilities');
  const allow = allowedNames(ctx.level);
  const cid = ctx.clientId || '';
  const servers = relayedMcps(cid);
  const defs = servers.length ? await relayedToolDefs(cid) : {};
  return textResult([
    caps.formatCapabilitiesOverview({ tools: TOOLS.filter((t) => allow.has(t.name)), gatewayUrl: gatewayUrl(ctx) }),
    // 有定义时工具写成签名（带参数名）
    caps.formatRelayedMcpSection(servers.map((s) => {
      const d = defs[s.prefix];
      if (!d) return s;
      if (d.length > BIG_MCP) return { ...s, tools: [], note: bigMcpHint(s.name, d.length) };
      return { ...s, tools: d.map(signature) };
    })),
    caps.formatConfiguredToolsSection(plainTools(cid)),
  ].join('\n\n'));
}

// ── 第三方 MCP / API / 命令 ─────────────────────────────────────────────────

function toolArgs(args) {
  const raw = args?.arguments !== undefined ? args.arguments : args?.args;
  if (raw == null) return {};
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch { return { input: raw }; }
  }
  return typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}

function asToolResult(raw) {
  if (raw && Array.isArray(raw.content)) return { ...raw, isError: !!raw.isError };
  if (raw == null) return textResult('(无返回)');
  return textResult(typeof raw === 'object' ? JSON.stringify(raw, null, 2) : String(raw));
}

async function callMcp(args, ctx) {
  const serverRef = String(args.server || '').trim();
  const tool = String(args.tool || '').trim();
  if (!serverRef || !tool) return textResult('需要 server（名称，如 pipeworx）和 tool（如 ask_pipeworx）', true);
  const cid = ctx.clientId || '';
  const plain = findPlainTool(cid, serverRef);
  if (plain) {
    try {
      return textResult(String(await require('./plain-tool-call').callPlainTool(plain, toolArgs(args))));
    } catch (e) {
      return textResult(`调用 ${plain.display_name || plain.name} 失败：${e.message}`, true);
    }
  }
  const hit = findRelayedMcp(cid, serverRef);
  if (!hit) {
    const names = relayedMcps(cid).map((s) => s.display_name || s.name).join('、') || '无';
    return textResult(`没有接入这个 MCP：${serverRef}（已接入：${names}）。请用户在 Token Bank「资产 → 工具」把它投射到这个应用。`, true);
  }
  if (typeof ctx.callRelayed !== 'function') return textResult('这里调不了第三方 MCP', true);
  const rawTool = tool.startsWith(`${hit.prefix}__`) ? tool.slice(hit.prefix.length + 2) : tool;
  const callArgs = toolArgs(args);
  // 先按工具定义检查：工具名不对、参数名不对，直接告诉它正确的写法，不把错的参数发给第三方
  const defs = (await relayedToolDefs(cid))[hit.prefix];
  if (Array.isArray(defs) && defs.length) {
    const def = defs.find((d) => d.name === rawTool);
    if (!def) {
      return textResult(defs.length > BIG_MCP
        ? `${hit.name} 没有工具 ${rawTool}。${bigMcpHint(hit.name, defs.length)}`
        : `${hit.name} 没有工具 ${rawTool}。它有：\n${defs.map((d) => `  ${signature(d)}`).join('\n')}`, true);
    }
    const problem = checkArgs(def, callArgs);
    if (problem) {
      return textResult(`参数不对（${problem}），没有调用。正确的写法：${signature(def)}\n参数定义：${JSON.stringify(def.inputSchema)}`, true);
    }
  }
  try {
    return asToolResult(await ctx.callRelayed(`${hit.prefix}__${rawTool}`, callArgs));
  } catch (e) {
    return textResult(`调用 ${hit.display_name || hit.name}.${tool} 失败：${e.message}`, true);
  }
}

// ── 入口 ────────────────────────────────────────────────────────────────────

/**
 * @param {string} name
 * @param {object} args
 * @param {{ clientId?: string, level: string, guardian?: boolean, dispatch?: object,
 *   gatewayUrl?: string, gatewayKey?: string, selfAgentId?: string,
 *   callRelayed?: (name: string, args: object) => Promise<object> }} ctx
 */
async function callTool(name, args, ctx = {}) {
  const a = args && typeof args === 'object' ? args : {};
  if (GUARDIAN_OPS[name]) {
    if (!isGuardian(ctx)) return textResult('改资产的接口只给智能管家。请用户在 Token Bank 里改。', true);
    try {
      const r = await require('./guardian/agent-api').handle(GUARDIAN_OPS[name], a);
      return textResult(JSON.stringify(r), !r.ok);
    } catch (e) {
      return textResult(`接口调用失败：${e.message}`, true);
    }
  }
  if (!TOOLS.some((t) => t.name === name)) return textResult(`没有这个工具：${name}`, true);
  if (!allowedNames(ctx.level).has(name)) {
    return textResult(`没有权限用 ${name}：请用户在 Token Bank「资产 → 工具 → TokenBank 内置」里给你更高的权限`, true);
  }
  switch (name) {
    case 'tb_capabilities': return capabilities(ctx);
    case 'tb_list_resources': return listResources(a, ctx);
    case 'tb_get_resource': return getResource(a, ctx);
    case 'tb_list_agents': return listAgents(ctx);
    case 'tb_dispatch_agent': return dispatchAgent(a, ctx);
    case 'tb_task_status': return taskStatus(a);
    case 'tb_plan': return planTool(a, ctx);
    case 'tb_notes': return notesTool(a, ctx);
    case 'tb_hire_community_agent':
      if (ctx.selfAgentId && String(a.assistant_id || '') === ctx.selfAgentId) return textResult('不能雇你自己', true);
      return hireCommunityAgent(a, ctx);
    case 'tb_list_models': return listModels(a, ctx);
    case 'tb_chat': return chat(a, ctx);
    case 'tb_list_devices': return listDevices();
    case 'tb_call_mcp': return callMcp(a, ctx);
    default: return textResult(`没有这个工具：${name}`, true);
  }
}

module.exports = {
  LEVELS,
  GUARDIAN_CLIENT_ID,
  INSTRUCTIONS,
  TOOLS,
  GUARDIAN_TOOLS,
  normalizeLevel,
  allowedNames,
  listTools,
  listToolsWithHints,
  catalogHints,
  isToolName,
  callTool,
  dispatchContext,
  textResult,
  // 模型
  inferModelTypeFromName,
  normalizeModel,
  pickAlternative,
  setListModelsImpl,
  // 资产（单测注入）
  setResourceManager,
  setRelayedMcpLister,
  setPlainToolLister,
  setRelayedToolDefs,
  signature,
  checkArgs,
  findManagedResource,
  formatResourceDetail,
  formatTaskStatus,
};
