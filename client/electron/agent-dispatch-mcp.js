#!/usr/bin/env node
// Token Bank Agent 派发 MCP（stdio）
// 供主 Agent（Claude Code）调用，向已纳管的其他 Agent 派发子任务
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { summarizeAgentStdout } = require('./agent-output-parser');
const dispatchClient = require('./agent-dispatch-client');

/** 每次调用再读：常驻 MCP 进程看不到后来写入的任务上下文 */
function currentDispatchContext() {
  const clientId = process.env.TB_CLIENT_ID || process.env.TB_MAIN_AGENT_ID || '';
  let row = {};
  try {
    const file = path.join(os.homedir(), '.tokenbank', 'mcp', 'bridge-context.json');
    const cur = JSON.parse(fs.readFileSync(file, 'utf8'));
    const byClient = cur && cur.byClient;
    if (byClient && typeof byClient === 'object') {
      row = byClient[clientId] || byClient.default || {};
    }
  } catch { /* 只有环境变量 */ }
  return {
    parentTaskId: process.env.TB_PARENT_TASK_ID || row.parentTaskId || '',
    parentSessionKey: process.env.TB_PARENT_SESSION_KEY || row.parentSessionKey || '',
    parentSessionInstance: process.env.TB_PARENT_SESSION_INSTANCE || row.parentSessionInstance || '',
    workingDir: process.env.TB_WORKING_DIR || row.workingDir || process.cwd(),
    agentRouteId: process.env.TB_AGENT_ROUTE || row.agentRouteId || '',
  };
}

const TOOLS = [
  {
    name: 'tb_list_agents',
    description: '【仅编排】列出可派发目标：本地智能体(assistant:*)、已雇佣社区智能体(community:*)、本机 CLI。不含未雇佣的在线目录。本地优先。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'tb_dispatch_agent',
    description: '【仅编排】向 tb_list_agents 返回的目标派发子任务。默认等它做完再返回；background=true 时马上返回任务号，几个互不依赖的子任务可以先都派出去，再用 tb_task_status(wait="any") 收结果。优先 assistant:<id>（本机执行）；我的其他设备用 mine:<智能体>@<设备>；社区用 community:<assistantId>@<用户名>（对方设备执行，不下载正文）。prompt 须含目标+约束+期望产出。',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: {
          type: 'string',
          description: '目标 ID：优先 assistant:<resourceId>；我的其他设备为 mine:<智能体>@<设备>（不写 @设备 自动挑）；社区为 community:<assistantId>@<用户名>；兜底可用 codex、claude-code、cursor',
        },
        prompt: {
          type: 'string',
          description: '自洽任务描述：目标、输入/上下文、约束、期望产出（路径/格式）；勿省略用户关键细节',
        },
        background: {
          type: 'boolean',
          description: '为 true 时不等结果，马上返回任务号。互不依赖的子任务用它并行；之后用 tb_task_status 收结果',
        },
        previous_task_id: {
          type: 'string',
          description: '接着之前某个子任务的会话继续（同一个智能体、同一台设备），例如让它按反馈再改一版',
        },
      },
      required: ['agent_id', 'prompt'],
    },
  },
  {
    name: 'tb_task_status',
    description: '【仅编排】查子任务的状态和结果。wait="any" 等到其中一个做完就返回（适合并行派出去后逐个收），wait="all" 等全部做完，不写就立刻返回。',
    inputSchema: {
      type: 'object',
      properties: {
        ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'tb_dispatch_agent 返回的任务号',
        },
        wait: {
          type: 'string',
          enum: ['none', 'any', 'all'],
          description: 'none（默认）立刻返回；any 有一个做完就返回；all 全部做完才返回',
        },
        timeout_seconds: {
          type: 'number',
          description: '最多等多久，默认 60，最多 600。到时没做完的照样返回当前状态',
        },
        detail: {
          type: 'boolean',
          description: '默认只给摘要和产出清单；为 true 时给完整结果（只在摘要不够时用，省上下文）',
        },
      },
      required: ['ids'],
    },
  },
  {
    name: 'tb_collect',
    description: '【仅编排】把一个子任务的代码改动取回本机仓库，放在新分支 tb/mesh/<任务号>（只建分支，不合并、不切换当前分支）。之后你可以在本机 git merge / cherry-pick 并跑测试；合进用户的分支前按检查点先问用户。',
    inputSchema: {
      type: 'object',
      properties: { task_id: { type: 'string', description: 'tb_dispatch_agent 返回的任务号' } },
      required: ['task_id'],
    },
  },
  {
    name: 'tb_ask',
    description: '遇到只有派活的人能回答的问题（需求不清、要选方案、要授权动工作区以外的东西）时用：提出问题，然后结束本轮回复，等回答。回答会接在这个会话后面发给你。不要为能自己查清的事提问。',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: '一个具体的问题，写清背景和可选项' },
      },
      required: ['question'],
    },
  },
  {
    name: 'tb_list_community_agents',
    description: '列出本机已雇佣的社区智能体名片（无正文）。不返回未雇佣的在线目录。新雇佣请在 Token Bank「交易」页操作；雇佣后可用 tb_dispatch_agent。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'tb_hire_community_agent',
    description: '雇佣社区智能体到本机名单（只存名片，不下载 Prompt/兵书）。可选同时发起一次远程任务。通常在「交易」页雇佣即可；雇佣后可用 tb_dispatch_agent(agent_id=community:…)。',
    inputSchema: {
      type: 'object',
      properties: {
        assistant_id: { type: 'string', description: '社区智能体 id（来自「交易」页社区列表）' },
        owner: { type: 'string', description: '出租者用户名。云端在该用户的在线设备里自动分发' },
        display_name: { type: 'string' },
        runtime: { type: 'string' },
        description: { type: 'string' },
        prompt: { type: 'string', description: '若提供则雇佣后立即远程执行一次' },
      },
      required: ['assistant_id'],
    },
  },
  {
    name: 'tb_get_prompt',
    description: '按名称或显示名取回 Token Bank 提示词正文（$ARGUMENTS 可填）。日常会话优先 tokenbank-resources / tokenbank-prompts 同名工具；本桥亦可用。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '提示词名称，或 #<id>' },
        args: { type: 'string', description: '可选参数，填充模板里的 $ARGUMENTS' },
      },
      required: ['name'],
    },
  },
];

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function textResult(text, isError = false) {
  return {
    content: [{ type: 'text', text: String(text) }],
    isError: !!isError,
  };
}

/** 产出清单：代码改动和文件，不带内容 */
function outputsText(result) {
  const lines = [];
  const g = result?.git;
  if (g && g.head) {
    lines.push(`代码改动：${g.files_changed || 0} 个文件 +${g.insertions || 0}/-${g.deletions || 0}，${g.commits || 0} 个提交，在 ${g.ref || g.branch || ''}${g.worktree ? '（独立工作树）' : ''}。用 tb_collect 取回到本机分支`);
  }
  const arts = Array.isArray(result?.artifacts) ? result.artifacts : [];
  if (arts.length) {
    lines.push(`产出文件 ${arts.length} 个：${arts.slice(0, 12).map((a) => `${a.path}（${Math.round((a.size || 0) / 1024)} KB）`).join('、')}${arts.length > 12 ? ' …' : ''}`);
  }
  return lines.join('\n');
}

const STATUS_TEXT = {
  pending: '排队中', running: '进行中', completed: '完成', failed: '失败',
  cancelled: '已取消', unreachable: '那台设备暂时连不上', not_found: '找不到', requires_input: '在等回答',
};

/** tb_task_status 的文字结果：先列状态，再贴已做完的结果 */
function formatTaskStatus(tasks = [], { detail = false } = {}) {
  const done = ['completed', 'failed', 'cancelled', 'requires_input'];
  const lines = tasks.map((t) => {
    const device = t.result?.device || t.context?.meshDevice;
    return `- ${t.id} [${t.agent_id || '?'}${device ? ` @${device}` : ''}] ${STATUS_TEXT[t.status] || t.status}`;
  });
  const bodies = tasks.filter((t) => done.includes(t.status)).map((t) => {
    const parseAs = t.agent_id === 'codex' ? 'codex' : 'claude-code';
    const raw = t.result?.output || t.result?.summary || '';
    if (t.status === 'requires_input') {
      return `### ${t.id}（在等回答）\n问题：${t.result?.question || ''}\n回答：tb_dispatch_agent(agent_id="${t.agent_id}", previous_task_id="${t.id}", prompt="<你的回答>")`;
    }
    const out = t.status === 'completed'
      ? (t.result?.summary || summarizeAgentStdout(raw, parseAs) || '(无输出)')
      : (t.error || raw || t.status);
    // 默认只交摘要和产出清单（D14），要全文再带 detail
    const text = String(out);
    const body = detail ? text.slice(0, 20000) : (text.length > 1500 ? `${text.slice(0, 1500)}…（摘要，全文用 detail=true）` : text);
    return [`### ${t.id}（${STATUS_TEXT[t.status] || t.status}）`, body, outputsText(t.result)].filter(Boolean).join('\n');
  });
  const left = tasks.length - tasks.filter((t) => done.includes(t.status) || t.status === 'not_found').length;
  const tail = left > 0 ? `\n还有 ${left} 个没做完，可再用 tb_task_status 等。` : '';
  return [lines.join('\n'), ...bodies].join('\n\n') + tail;
}

async function handleToolCall(name, args = {}) {
  if (name === 'tb_list_agents') {
    const routeId = currentDispatchContext().agentRouteId;
    const agents = await dispatchClient.listAgents({ route: routeId });
    // 本地智能体优先，其次已雇佣社区，最后本机 CLI。未雇佣的在线目录不在这份列表里。
    const rank = (t) => (t === 'assistant' ? 0 : t === 'community' ? 1 : 2);
    // 内置智能管家只在游乐场里回答 Token Bank 自己的问题，不接派发的业务子任务
    const sorted = [...(agents || [])].filter((a) => a && a.id && !a.guardian).sort((a, b) =>
      rank(a.type) - rank(b.type) || String(a.name || '').localeCompare(String(b.name || '')),
    );
    const lines = sorted.map((a) => {
      const kind = a.type === 'assistant' ? '本地智能体'
        : a.type === 'community' ? '社区智能体(远程)'
        : a.type === 'mine' ? '我的设备' : 'CLI';
      const caps = (a.capabilities || []).join(', ');
      const desc = a.description ? ` — ${String(a.description).slice(0, 160)}` : '';
      const ver = a.version ? ` (v${a.version})` : '';
      const runtime = a.runtimeName ? ` @${a.runtimeName}` : '';
      return `- ${a.id}: ${a.name}${ver}${runtime} [${kind}]${caps ? ` (${caps})` : ''}${desc}`;
    });
    // 走智能体路由时，用这条路由的派发规则（用户写的在前，自带的在后）
    let routeHint = '';
    if (routeId) {
      try {
        const routes = require('./agent-routes');
        const route = routes.get(routeId);
        if (route) routeHint = routes.rulesText(route);
      } catch { /* 读不到就用默认规则 */ }
    }
    const hint = routeHint || [
      '【编排规则】',
      '1. 优先匹配「本地智能体」(assistant:*)，用 tb_dispatch_agent 派发；有匹配必须派发，勿自己做。',
      '2. 其次是已雇佣的社区智能体(community:*)。任务在对方设备执行，只拿结果，勿拉取正文。',
      '3. 都没有匹配时，才派发 CLI（codex / claude-code / cursor）或自行完成。',
      '4. 子任务 prompt 写清：目标 + 约束 + 期望产出。',
      '5. 只从上面这份名单里选。任务已有工程、时间线或指定工具链时，选描述覆盖该链路的；不要因为名字更泛就改派另一个。',
    ].join('\n');
    return textResult(lines.length
      ? `${hint}\n\n${lines.join('\n')}`
      : `${hint}\n\n（无可用 Agent — 请降级自行完成，并告知用户）`);
  }

  if (name === 'tb_list_community_agents') {
    try {
      const { listHired } = require('./hired-community-agents');
      const hired = listHired();
      // 可选：标注当前是否仍在线（不展开未雇佣目录）
      let onlineIds = new Set();
      try {
        const { listOnlineCommunityAgents } = require('./community-agent-client');
        const online = await listOnlineCommunityAgents();
        onlineIds = new Set((online.agents || []).map((a) => a.id));
      } catch { /* 在线探测失败不影响已雇名单 */ }
      const lines = hired.map((h) => {
        const online = onlineIds.has(h.assistant_id) ? ' [在线]' : ' [离线或未知]';
        return `- ${h.id}: ${h.display_name || h.assistant_id}${h.runtime ? ` · ${h.runtime}` : ''}${online}${h.description ? ` — ${String(h.description).slice(0, 120)}` : ''}`;
      });
      return textResult(
        lines.length
          ? `已雇佣社区智能体（仅本机名单，无正文）\n派发：tb_dispatch_agent；新雇佣请到「交易」页。\n\n${lines.join('\n')}`
          : '尚无已雇佣社区智能体。请到 Token Bank「交易 → 社区智能体」雇佣后再调用。',
      );
    } catch (e) {
      return textResult(`列出已雇佣社区智能体失败: ${e.message}`, true);
    }
  }

  if (name === 'tb_hire_community_agent') {
    const assistantId = String(args.assistant_id || '').trim();
    if (!assistantId) return textResult('缺少 assistant_id', true);
    try {
      const hiredMod = require('./hired-community-agents');
      const entry = hiredMod.hire({
        assistant_id: assistantId,
        owner: args.owner || args.owner_nickname,
        display_name: args.display_name,
        runtime: args.runtime,
        description: args.description,
      });
      // 名单落盘后，主进程 listAgents 会合并最新 hired（无需本子进程清缓存）

      const prompt = String(args.prompt || '').trim();
      if (!prompt) {
        return textResult(`已雇佣: ${entry.id}（${entry.display_name}）。可用 tb_dispatch_agent 派发。`);
      }
      const ctx = currentDispatchContext();
      const status = await dispatchClient.dispatchAndWait(entry.id, prompt, {
        workingDir: ctx.workingDir,
        parentTaskId: ctx.parentTaskId,
        route: ctx.agentRouteId || undefined,
        parentSessionKey: ctx.parentSessionKey || undefined,
        parentSessionInstanceId: ctx.parentSessionInstance || undefined,
        mode: 'worker',
      });
      if (status.status === 'completed') {
        const out = status.result?.summary || status.result?.output || '(无输出)';
        return textResult(`已雇佣并完成 [${entry.id}]:\n${out}`);
      }
      return textResult(`已雇佣但任务失败 [${entry.id}]: ${status.error || status.status}`, true);
    } catch (e) {
      return textResult(`雇佣失败: ${e.message}`, true);
    }
  }

  if (name === 'tb_dispatch_agent') {
    const agentId = String(args.agent_id || '').trim();
    const prompt = String(args.prompt || '').trim();
    if (!agentId || !prompt) {
      return textResult('缺少 agent_id 或 prompt', true);
    }

    try {
      const ctx = currentDispatchContext();
      const opts = {
        workingDir: ctx.workingDir,
        parentTaskId: ctx.parentTaskId,
        parentSessionKey: ctx.parentSessionKey || undefined,
        parentSessionInstanceId: ctx.parentSessionInstance || undefined,
        previousTaskId: String(args.previous_task_id || '').trim() || undefined,
        mode: 'worker',
      };
      if (args.background === true || args.background === 'true') {
        const t = await dispatchClient.dispatch(agentId, prompt, opts);
        const where = t.device ? `，在「${t.device}」上执行` : '';
        return textResult(`[${t.agentId || agentId}] 已派出${where}。任务号：${t.taskId}\n用 tb_task_status(ids=["${t.taskId}"], wait="any") 收结果。`);
      }
      const status = await dispatchClient.dispatchAndWait(agentId, prompt, opts);

      const canonicalId = status.agent_id || agentId;
      const parseAs = canonicalId === 'codex' ? 'codex' : 'claude-code';
      if (status.status === 'completed') {
        const raw = status.result?.output || status.result?.summary || '';
        const out = status.result?.summary
          || summarizeAgentStdout(raw, parseAs)
          || '(无输出)';
        return textResult(`[${canonicalId}] 任务完成:\n${[out, outputsText(status.result)].filter(Boolean).join('\n')}`);
      }
      if (status.status === 'requires_input') {
        return textResult(`[${canonicalId}] 子任务停下来提问（任务号 ${status.id}）：\n${status.result?.question || ''}\n\n能自己回答就用 tb_dispatch_agent(agent_id="${agentId}", previous_task_id="${status.id}", prompt="<回答>") 续上；需要用户定的，用 tb_ask 转问用户。`);
      }

      const err = status.error || status.result?.output || '未知错误';
      return textResult(`[${canonicalId}] 任务失败 (${status.status}):\n${err}`, true);
    } catch (e) {
      return textResult(`派发失败: ${e.message}`, true);
    }
  }

  if (name === 'tb_task_status') {
    const ids = (Array.isArray(args.ids) ? args.ids : String(args.ids || '').split(','))
      .map((x) => String(x || '').trim()).filter(Boolean);
    if (!ids.length) return textResult('缺少 ids', true);
    const wait = ['any', 'all'].includes(args.wait) ? args.wait : 'none';
    const secs = Math.min(Math.max(Number(args.timeout_seconds) || 60, 1), 600);
    try {
      const tasks = await dispatchClient.taskStatus(ids, { wait, timeoutMs: secs * 1000 });
      return textResult(formatTaskStatus(tasks, { detail: args.detail === true || args.detail === 'true' }));
    } catch (e) {
      return textResult(`查询失败: ${e.message}`, true);
    }
  }

  if (name === 'tb_collect') {
    const taskId = String(args.task_id || '').trim();
    if (!taskId) return textResult('缺少 task_id', true);
    try {
      const r = await dispatchClient.collect(taskId, currentDispatchContext().workingDir);
      if (r.imported) {
        return textResult(`已取回到 ${r.repo} 的分支 ${r.branch}（${r.commits || 0} 个提交，${r.files_changed || 0} 个文件）。看改动：git -C "${r.repo}" diff HEAD...${r.branch}`);
      }
      return textResult(`没有取进仓库：${r.reason}${r.bundle ? `\nbundle 在：${r.bundle}` : ''}`, !r.bundle);
    } catch (e) {
      return textResult(`取回失败: ${e.message}`, true);
    }
  }

  if (name === 'tb_ask') {
    const question = String(args.question || '').trim();
    const taskId = currentDispatchContext().parentTaskId;
    if (!question) return textResult('缺少 question', true);
    if (!taskId) return textResult('不在一个任务里，没法提问', true);
    try {
      await dispatchClient.ask(taskId, question);
      return textResult('问题已经记下。现在结束本轮回复（简短说明你停在哪、在等什么），回答会接着这个会话发给你。');
    } catch (e) {
      return textResult(`提问失败: ${e.message}`, true);
    }
  }

  if (name === 'tb_get_prompt') {
    const ref = String(args.name || args.ref || '').trim();
    const argStr = String(args.args || args.arguments || '').trim();
    if (!ref) return textResult('缺少 name', true);
    const clientId = process.env.TB_CLIENT_ID || process.env.TB_MAIN_AGENT_ID || '';
    const r = await dispatchClient.resolvePrompt(ref, argStr, clientId);
    if (!r || !r.found) {
      return textResult(`未找到提示词: ${ref}(仅投射给当前 Agent 的提示词可用)`, true);
    }
    return textResult(r.text);
  }

  return textResult(`未知工具: ${name}`, true);
}

function handleMessage(msg) {
  const { id, method, params } = msg;

  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'tokenbank-agent-bridge', version: '1.0.0' },
      },
    });
    return;
  }

  if (method === 'notifications/initialized') {
    return;
  }

  if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    return;
  }

  if (method === 'tools/call') {
    const toolName = params?.name;
    const toolArgs = params?.arguments || {};
    handleToolCall(toolName, toolArgs)
      .then(result => send({ jsonrpc: '2.0', id, result }))
      .catch(err => send({
        jsonrpc: '2.0',
        id,
        result: textResult(err.message, true),
      }));
    return;
  }

  if (method === 'ping') {
    send({ jsonrpc: '2.0', id, result: {} });
    return;
  }

  if (id != null) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
}

// stdio JSON-RPC（每行一条消息）——仅作为独立进程运行时启动，便于单测 require
if (require.main === module) {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    const t = line.trim();
    if (!t) return;
    try {
      handleMessage(JSON.parse(t));
    } catch (e) {
      // 忽略非法行
    }
  });
}

module.exports = { TOOLS, handleToolCall, handleMessage };
