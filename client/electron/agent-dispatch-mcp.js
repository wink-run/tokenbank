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
    description: '【仅编排】向 tb_list_agents 返回的目标派发子任务并等待完成。优先 assistant:<id>（本机执行）；社区用 community:<assistantId>@<用户名>（对方设备执行，不下载正文）。prompt 须含目标+约束+期望产出。',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: {
          type: 'string',
          description: '目标 ID：优先 assistant:<resourceId>；社区为 community:<assistantId>@<用户名>；兜底可用 codex、claude-code、cursor',
        },
        prompt: {
          type: 'string',
          description: '自洽任务描述：目标、输入/上下文、约束、期望产出（路径/格式）；勿省略用户关键细节',
        },
      },
      required: ['agent_id', 'prompt'],
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

async function handleToolCall(name, args = {}) {
  if (name === 'tb_list_agents') {
    const agents = await dispatchClient.listAgents();
    // 本地智能体优先，其次已雇佣社区，最后本机 CLI。未雇佣的在线目录不在这份列表里。
    const rank = (t) => (t === 'assistant' ? 0 : t === 'community' ? 1 : 2);
    const sorted = [...(agents || [])].filter((a) => a && a.id).sort((a, b) =>
      rank(a.type) - rank(b.type) || String(a.name || '').localeCompare(String(b.name || '')),
    );
    const lines = sorted.map((a) => {
      const kind = a.type === 'assistant' ? '本地智能体' : a.type === 'community' ? '社区智能体(远程)' : 'CLI';
      const caps = (a.capabilities || []).join(', ');
      const desc = a.description ? ` — ${String(a.description).slice(0, 160)}` : '';
      const ver = a.version ? ` (v${a.version})` : '';
      const runtime = a.runtimeName ? ` @${a.runtimeName}` : '';
      return `- ${a.id}: ${a.name}${ver}${runtime} [${kind}]${caps ? ` (${caps})` : ''}${desc}`;
    });
    const hint = [
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
      const status = await dispatchClient.dispatchAndWait(agentId, prompt, {
        workingDir: ctx.workingDir,
        parentTaskId: ctx.parentTaskId,
        parentSessionKey: ctx.parentSessionKey || undefined,
        parentSessionInstanceId: ctx.parentSessionInstance || undefined,
        mode: 'worker',
      });

      const canonicalId = status.agent_id || agentId;
      const parseAs = canonicalId === 'codex' ? 'codex' : 'claude-code';
      if (status.status === 'completed') {
        const raw = status.result?.output || status.result?.summary || '';
        const out = status.result?.summary
          || summarizeAgentStdout(raw, parseAs)
          || '(无输出)';
        return textResult(`[${canonicalId}] 任务完成:\n${out}`);
      }

      const err = status.error || status.result?.output || '未知错误';
      return textResult(`[${canonicalId}] 任务失败 (${status.status}):\n${err}`, true);
    } catch (e) {
      return textResult(`派发失败: ${e.message}`, true);
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
