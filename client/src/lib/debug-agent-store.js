/** Debug Agent 模式：模块级会话缓存，避免切换菜单/重挂载后任务 state 丢失 */

import { mergeStreamText } from '../../shared/stream-text-merge.js';
import { makeT } from '../i18n.js';

/** 非 React 路径按 localStorage 语言取文案 */
function uiT(key, vars) {
  let lang = 'zh';
  try { lang = localStorage.getItem('lang') || 'zh'; } catch { /* ignore */ }
  return makeT(lang)(key, vars);
}

/** 将同类型步骤折叠为合并后字符数（Codex DB 按行入库会虚增条数） */
function foldedTypeChars(steps, stepType) {
  let acc = '';
  for (const s of steps) {
    if ((s.stepType || 'output') !== stepType) continue;
    acc = mergeStreamText(acc, s.content, {
      isDelta: !!s.is_delta,
      isSnapshot: !!s.is_snapshot,
    });
  }
  return acc.length;
}

export function emptyAgentSession() {
  return {
    agentPrompt: '',
    currentUserPrompt: '',
    /** 本轮用户附图 dataURL（仅内存；落历史时会省略大 base64） */
    currentUserImages: [],
    currentTask: null,
    taskSteps: [],
    taskResult: null,
    executing: false,
    delegations: {},
    /** 已完成的多轮对话 */
    conversationTurns: [],
    /** CLI 侧 session/thread id（Codex resume 用） */
    cliSessionId: null,
    /** 历史归档粘性线程（首轮 taskId），中断续跑不换键 */
    historyThreadId: null,
    /** 当前会话绑定的工作目录 */
    sessionWorkingDir: '',
    /** 用户点击「新会话」后，短暂跳过 DB 历史恢复 */
    skipHistoryRecover: 0,
    /** 当前页面会话实例 ID（新会话/新一轮执行时更新，派发绑定此 ID） */
    sessionInstanceId: '',
    /** 镜像派发的父会话实例 ID（子 Agent 标签用） */
    mirroredSessionInstanceId: '',
  };
}

export function agentSessionKey(agent) {
  return agent?.id || '__hub__';
}

/** 将 MCP/后端 agentId 映射到 Debug 标签页 session key */
export function resolveSessionKey(agentId, agents = []) {
  const raw = String(agentId || '').trim();
  if (!raw) return null;
  if (raw === '__hub__') return raw;

  const list = agents || [];
  const exact = list.find(a => a.id === raw);
  if (exact) return exact.id;

  const lower = raw.toLowerCase();
  const assistant = list.find(a =>
    a.type === 'assistant' && (
      a.name?.toLowerCase() === lower
      || a.resourceId === raw
      || a.resourceId === raw.replace(/^assistant:/, '')
      || (raw.startsWith('assistant:') && a.id.includes(raw.slice('assistant:'.length)))
    ),
  );
  if (assistant) return assistant.id;

  const cli = list.find(a => a.id === lower || a.name?.toLowerCase() === lower);
  if (cli) return cli.id;

  // 已是 assistant: 前缀的完整 id，即使 agents 尚未加载也保留
  if (raw.startsWith('assistant:')) return raw;

  return raw;
}

const store = {
  sessions: {},
  taskRoutes: {},
  /** 派发子任务 → 子 Agent 标签页镜像路由 */
  mirrorRoutes: {},
  /** taskId → 创建时的 sessionInstanceId */
  taskInstances: {},
  selectedAgentId: null,
};

export function getStoreSession(key) {
  if (!store.sessions[key]) store.sessions[key] = emptyAgentSession();
  return store.sessions[key];
}

export function patchStoreSession(key, patch) {
  const prev = getStoreSession(key);
  store.sessions[key] = { ...prev, ...patch };
  return store.sessions[key];
}

export function createSessionInstanceId() {
  return `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 开启当前标签页的新会话实例（新会话 / 新一轮执行） */
export function beginSessionInstance(sessionKey) {
  const id = createSessionInstanceId();
  patchStoreSession(sessionKey, {
    sessionInstanceId: id,
    mirroredSessionInstanceId: '',
  });
  return id;
}

export function routeTask(taskId, sessionKey, sessionInstanceId) {
  if (taskId && sessionKey) store.taskRoutes[taskId] = sessionKey;
  if (taskId && sessionInstanceId) store.taskInstances[taskId] = sessionInstanceId;
}

export function resolveTaskInstance(taskId) {
  return store.taskInstances[taskId] || null;
}

/** 事件是否属于当前页面最新 session。刷新后本地还没有实例号时先收下，避免过程卡住、按钮却停在「停止」。 */
export function eventMatchesSession(sessionKey, sessionInstanceId) {
  if (!sessionKey || !sessionInstanceId) return true;
  const current = getStoreSession(sessionKey).sessionInstanceId;
  if (!current) return true;
  return current === sessionInstanceId;
}

/** 当前 store 会话是否接受该 task 的 sessionInstanceId */
export function sessionTaskInstanceMatches(sess, taskId) {
  if (!sess) return true;
  const taskInstance = resolveTaskInstance(taskId);
  if (!taskInstance) return true;
  if (!sess.sessionInstanceId && !sess.mirroredSessionInstanceId) return true;
  return sess.sessionInstanceId === taskInstance
    || sess.mirroredSessionInstanceId === taskInstance;
}

/** 子 Agent 镜像标签是否接受该 session 实例的事件 */
export function eventMatchesAgentMirror(agentKey, sessionInstanceId) {
  if (!agentKey || !sessionInstanceId) return true;
  const s = getStoreSession(agentKey);
  return s.sessionInstanceId === sessionInstanceId
    || s.mirroredSessionInstanceId === sessionInstanceId;
}

/** 记录子任务在子 Agent 标签页的镜像路由 */
export function routeTaskMirror(taskId, agentTabKey) {
  if (taskId && agentTabKey) store.mirrorRoutes[taskId] = agentTabKey;
}

export function resolveMirrorRoute(taskId) {
  return store.mirrorRoutes[taskId] || null;
}

/** 任务收尾应落在哪个 session（镜像标签优先于父窗口路由） */
export function resolveFinalizeKey(taskId, explicitKey, agents = []) {
  const mirror = resolveMirrorRoute(taskId);
  if (mirror) return mirror;
  if (explicitKey) {
    const s = store.sessions[explicitKey];
    if (s?.currentTask?.id === taskId && s?.currentTask?.parentTaskId) return explicitKey;
  }
  return resolveTaskRoute(taskId, null, null, agents) || explicitKey || null;
}

export function resolveTaskRoute(taskId, agentId, sessionKey, agents = []) {
  const routed = store.taskRoutes[taskId];
  if (routed) return routed;
  const fromSession = sessionKey || resolveSessionKey(agentId, agents);
  if (fromSession) return fromSession;
  return agentId || null;
}

export function setStoreSelectedAgentId(id) {
  store.selectedAgentId = id;
}

export function getStoreSelectedAgentId() {
  return store.selectedAgentId;
}

/** 从任务记录推断应展示在哪个 Agent 标签页 */
export function inferSessionKeyFromTask(status) {
  const ctx = status.context || {};
  // 社区接单不归属本机游乐场标签
  if (ctx.clientId === 'contribute') return null;
  if (typeof ctx.sessionKey === 'string' && ctx.sessionKey.startsWith('contribute:')) return null;
  // 优先用显式 sessionKey（派发子任务会继承父窗口 key）
  if (ctx.sessionKey) return ctx.sessionKey;
  if (ctx.mode === 'orchestrator') return '__hub__';
  return status.agent_id;
}

function mapDbSteps(status) {
  return (status.steps || []).map(s => ({
    taskId: status.id,
    stepNumber: s.step_number,
    stepType: s.step_type,
    content: s.content,
    tool_name: s.tool_name || null,
    // DB 列 / 流式字段双读，避免恢复时丢掉配对与失败态
    tool_use_id: s.tool_use_id || s.toolUseId || null,
    is_error: !!(s.is_error || s.isError || s.status === 'error'),
    timestamp: s.created_at,
    agentId: status.agent_id,
    parentTaskId: status.context?.parentTaskId || null,
  }));
}

/** 将 DB 步骤行转为 ExecutionLog 步骤 */
export function stepsFromTaskStatus(status) {
  return mapDbSteps(status);
}

/**
 * 归档/收尾时选取更完整的步骤。
 * Codex 等流式 Agent 在 DB 按 JSONL 行入库，条数会虚高，需按折叠后内容量比较。
 * 若 DB 侧仍有未配对 tool_call、而内存侧已有结果，优先内存（避免「失败」被冲成「执行中」）。
 */
export function preferRicherSteps(dbSteps = [], storedSteps = []) {
  const stored = Array.isArray(storedSteps) ? storedSteps : [];
  const db = Array.isArray(dbSteps) ? dbSteps : [];
  if (!stored.length) return db;
  if (!db.length) return stored;

  // 内存已收齐工具结果、DB 仍缺结果 → 保留内存（含 closePending / is_error）
  if (hasOpenToolCalls(db) && !hasOpenToolCalls(stored)) return stored;

  const detailTypes = new Set(['thinking', 'tool_call', 'tool_result', 'terminal', 'code_edit', 'system_event']);
  const countDetail = (arr) => arr.filter(s => detailTypes.has(s.stepType)).length;
  const storedDetail = countDetail(stored);
  const dbDetail = countDetail(db);
  if (storedDetail > dbDetail) return stored;
  if (dbDetail > storedDetail) return db;

  const storedFold = foldedTypeChars(stored, 'output') + foldedTypeChars(stored, 'thinking');
  const dbFold = foldedTypeChars(db, 'output') + foldedTypeChars(db, 'thinking');
  if (storedFold > dbFold) return stored;
  if (dbFold > storedFold) return db;

  if (stored.some(s => s.is_delta || s.is_snapshot)) return stored;
  // 平局时优先带 is_error 的一侧，避免失败态被冲掉
  const errCount = (arr) => arr.filter(s => s.stepType === 'tool_result' && s.is_error).length;
  if (errCount(stored) > errCount(db)) return stored;
  return stored;
}

/**
 * 归档/收尾时合并步骤：派发步骤仅存于前端 taskSteps，并与 DB 步骤合并保留编排细节。
 */
export function resolveArchiveSteps(dbSteps = [], storedSteps = []) {
  const stored = Array.isArray(storedSteps) ? storedSteps : [];
  const db = Array.isArray(dbSteps) ? dbSteps : [];
  const delegSteps = stored.filter(s => s.stepType === 'delegation');
  if (!delegSteps.length) {
    return preferRicherSteps(db, stored);
  }
  const storedOther = stored.filter(s => s.stepType !== 'delegation');
  const dbOther = db.filter(s => s.stepType !== 'delegation');
  const other = preferRicherSteps(dbOther, storedOther);
  return [...delegSteps, ...other].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
}

export function patchDelegation(parentKey, childTaskId, patch) {
  if (!parentKey || !childTaskId) return null;
  const parent = getStoreSession(parentKey);
  const dels = { ...(parent.delegations || {}) };
  dels[childTaskId] = { ...(dels[childTaskId] || {}), ...patch };
  patchStoreSession(parentKey, { delegations: dels });
  return dels[childTaskId];
}

/** 查找某子 Agent 标签相关的 hub 派发记录 */
export function findDelegationsForAgentTab(agentKey, agents = []) {
  if (!agentKey || agentKey === '__hub__') return [];
  const hub = getStoreSession('__hub__');
  const hubInstance = hub.sessionInstanceId;
  const out = [];
  for (const [childId, del] of Object.entries(hub.delegations || {})) {
    // 只同步当前 hub 最新 session 的派发
    if (hubInstance && del.sessionInstanceId && del.sessionInstanceId !== hubInstance) continue;
    const tabKey = resolveSessionKey(del.agentId, agents) || del.agentId;
    if (tabKey === agentKey) {
      out.push({ childId, del, parentKey: '__hub__' });
    }
  }
  return out;
}

/**
 * 从聚合入口 delegations 同步镜像到子 Agent 标签
 * （切换标签时补齐执行中/已完成状态）
 */
export function syncDelegatedMirrorToAgentTab(agentKey, agents = []) {
  if (!agentKey || agentKey === '__hub__') return false;
  const matches = findDelegationsForAgentTab(agentKey, agents);
  if (!matches.length) return false;

  const agentSess = getStoreSession(agentKey);
  // 用户点了「新会话」：不回填已完成的旧派发；仅同步仍在执行的派发
  const fresh = isFreshAgentSession(agentSess);
  const candidates = fresh
    ? matches.filter(m => !['completed', 'failed', 'cancelled'].includes(m.del?.status))
    : matches;
  if (!candidates.length) return false;

  const { childId, del } = candidates[candidates.length - 1];
  const terminal = ['completed', 'failed', 'cancelled'].includes(del.status);
  const turns = agentSess.conversationTurns || [];
  const alreadyArchived = turns.some(t => t.taskId === childId);

  routeTaskMirror(childId, agentKey);

  let steps = del.steps || [];
  if (!steps.length && del.result?.summary) {
    steps = [{
      stepType: 'output',
      content: String(del.result.summary),
      timestamp: Date.now(),
      agentId: del.agentId,
    }];
  }

  if (terminal) {
    if (!alreadyArchived && del.prompt) {
      archiveCompletedTurn(agentKey, {
        user: del.prompt,
        steps,
        result: del.result || null,
        status: del.status === 'cancelled' ? 'failed' : del.status,
        taskId: childId,
        timestamp: Date.now(),
      });
    }
    const after = getStoreSession(agentKey);
    patchStoreSession(agentKey, {
      executing: false,
      currentUserPrompt: '',
      currentUserImages: [],
      taskSteps: [],
      taskResult: null,
      conversationTurns: after.conversationTurns,
      currentTask: agentSess.currentTask?.id === childId
        ? { id: childId, status: del.status }
        : agentSess.currentTask,
    });
    return true;
  }

  // 执行中：从 delegations 补齐镜像（可落到「新会话」空白页）
  patchStoreSession(agentKey, {
    currentUserPrompt: del.prompt || agentSess.currentUserPrompt,
    currentTask: { id: childId, status: 'running', parentTaskId: '__hub__' },
    taskSteps: steps.length ? steps : agentSess.taskSteps,
    executing: true,
    taskResult: null,
    mirroredSessionInstanceId: del.sessionInstanceId || getStoreSession('__hub__').sessionInstanceId || '',
    skipHistoryRecover: 0,
  });
  return true;
}

/** 派发子任务镜像到子 Agent 标签（与父窗口 delegations 并行展示） */
export function syncDelegatedToAgentTab(agentKey, patch) {
  if (!agentKey || !patch?.taskId) return;
  // 派发进来的子任务即使目标标签刚「新会话」也要显示（认领该会话）；不因 fresh 提前退出。
  const s = getStoreSession(agentKey);
  patchStoreSession(agentKey, {
    currentUserPrompt: patch.prompt ?? s.currentUserPrompt,
    currentTask: patch.currentTask ?? {
      id: patch.taskId,
      status: patch.executing === false ? (patch.status || 'completed') : 'running',
      parentTaskId: patch.parentTaskId || null,
    },
    taskSteps: patch.steps ?? s.taskSteps,
    taskResult: patch.taskResult ?? s.taskResult,
    executing: patch.executing ?? true,
    skipHistoryRecover: 0,
  });
}

/** 将后端任务状态合并进 store（用于恢复运行中任务） */
export function mergeTaskIntoStore(status) {
  if (!status?.id) return;

  const ctx = status.context || {};
  const key = inferSessionKeyFromTask(status);
  if (isFreshAgentSession(getStoreSession(key))) return;

  routeTask(status.id, key, ctx.sessionInstanceId || null);

  const steps = mapDbSteps(status);
  const running = status.status === 'running' || status.status === 'pending';

  // 派发子任务：更新父窗口 delegations，并镜像到子 Agent 标签
  if (ctx.parentTaskId) {
    const parentKey = key || '__hub__';
    patchDelegation(parentKey, status.id, {
      agentId: status.agent_id,
      prompt: status.prompt,
      steps: preferRicherSteps(steps, getStoreSession(parentKey).delegations?.[status.id]?.steps || []),
      status: status.status,
      result: status.result,
      sessionInstanceId: ctx.sessionInstanceId || getStoreSession(parentKey).sessionInstanceId,
    });

    const agentKey = resolveSessionKey(status.agent_id, []) || status.agent_id;
    if (agentKey && agentKey !== parentKey) {
      routeTaskMirror(status.id, agentKey);
      const mirrorPrev = getStoreSession(agentKey);
      const mergedSteps = preferRicherSteps(steps, mirrorPrev.taskSteps || []);
      if (running) {
        syncDelegatedToAgentTab(agentKey, {
          taskId: status.id,
          parentTaskId: ctx.parentTaskId,
          prompt: status.prompt,
          steps: mergedSteps,
          executing: true,
        });
      } else if (status.prompt) {
        // 「新会话」空白页不回填已完成的历史派发
        if (isFreshAgentSession(getStoreSession(agentKey))) return;
        archiveCompletedTurn(agentKey, {
          user: status.prompt,
          steps: mergedSteps,
          result: status.result || null,
          status: status.status,
          taskId: status.id,
          cliSessionId: status.result?.cliSessionId || null,
          workingDir: ctx.workingDir || getStoreSession(agentKey).sessionWorkingDir || '',
          timestamp: status.completed_at || Date.now(),
          sentAt: status.created_at || status.started_at || null,
        });
        const after = getStoreSession(agentKey);
        patchStoreSession(agentKey, {
          executing: false,
          currentUserPrompt: '',
          currentUserImages: [],
          taskSteps: [],
          taskResult: null,
          conversationTurns: after.conversationTurns,
        });
      }
    }
    return;
  }

  const prev = getStoreSession(key);
  if (running) {
    // 误归档后后端仍在跑：从 conversationTurns 撤回本 task，恢复为当前轮
    const turns = (prev.conversationTurns || []).filter(t => t.taskId !== status.id);
    const fromArchive = (prev.conversationTurns || []).find(t => t.taskId === status.id);
    const fallback = prev.taskSteps?.length ? prev.taskSteps : (fromArchive?.steps || []);
    // 勿用 DB 步骤整表覆盖内存：否则会丢掉 tool_result / is_error，失败工具变回「执行中」
    const restoredSteps = preferRicherSteps(steps, fallback);
    patchStoreSession(key, {
      conversationTurns: turns,
      currentUserPrompt: status.prompt || prev.currentUserPrompt || fromArchive?.user || '',
      currentUserImages: (prev.currentUserImages || []).length
        ? prev.currentUserImages
        : (fromArchive?.images || []),
      currentTask: { ...status, status: 'running' },
      taskSteps: restoredSteps,
      executing: true,
      taskResult: null,
      skipHistoryRecover: 0,
      // 刷新后本地实例号是空的，接上这条任务原来的号，后续步骤才进得来
      ...(ctx.sessionInstanceId && !prev.sessionInstanceId
        ? { sessionInstanceId: ctx.sessionInstanceId }
        : {}),
    });
    return;
  }

  patchStoreSession(key, {
    currentUserPrompt: '',
    currentUserImages: [],
    currentTask: status,
    taskSteps: preferRicherSteps(steps, prev.taskSteps || []),
    executing: false,
    taskResult: status.result || null,
  });

  if (status.prompt || (prev.currentUserImages || []).length) {
    archiveCompletedTurn(key, {
      user: status.prompt || prev.currentUserPrompt || uiT('debug.agent.imageOnlyPrompt'),
      images: prev.currentUserImages || [],
      steps: preferRicherSteps(steps, prev.taskSteps || []),
      result: status.result || null,
      status: status.status,
      taskId: status.id,
      cliSessionId: status.result?.cliSessionId || null,
      workingDir: ctx.workingDir || getStoreSession(key).sessionWorkingDir || '',
      timestamp: status.completed_at || Date.now(),
      sentAt: status.created_at || status.started_at || null,
    });
    const afterArchive = getStoreSession(key);
    patchStoreSession(key, {
      executing: false,
      currentUserPrompt: '',
      currentUserImages: [],
      taskSteps: [],
      taskResult: null,
      conversationTurns: afterArchive.conversationTurns,
      cliSessionId: status.result?.cliSessionId || afterArchive.cliSessionId || null,
    });
  }
}

export function readStoreSnapshot(sessionKey) {
  return { ...(getStoreSession(sessionKey)) };
}

/** 强制结束所有标签页的 executing 锁（停止按钮兜底） */
export function releaseAllExecutingSessions() {
  for (const key of Object.keys(store.sessions)) {
    const s = store.sessions[key];
    if (!s?.executing) continue;
    store.sessions[key] = {
      ...s,
      executing: false,
      currentTask: s.currentTask
        ? { ...s.currentTask, status: 'cancelled' }
        : null,
    };
  }
}

/** 按 taskId 释放所有标签页的 executing 锁（完成/失败事件兜底） */
export function releaseExecutingForTask(taskId, taskPatch = {}) {
  if (!taskId) return [];
  const touched = [];
  for (const key of Object.keys(store.sessions)) {
    const s = store.sessions[key];
    if (s.currentTask?.id !== taskId) continue;
    store.sessions[key] = {
      ...s,
      executing: false,
      currentTask: s.currentTask
        ? { ...s.currentTask, ...taskPatch }
        : s.currentTask,
    };
    touched.push(key);
  }
  // currentTask 丢失时，用路由表兜底释放 executing
  const routedKey = store.taskRoutes[taskId];
  if (routedKey && !touched.includes(routedKey)) {
    const s = store.sessions[routedKey];
    if (s?.executing) {
      store.sessions[routedKey] = {
        ...s,
        executing: false,
        currentTask: s.currentTask
          ? { ...s.currentTask, ...taskPatch, id: s.currentTask.id || taskId }
          : { id: taskId, ...taskPatch },
      };
      touched.push(routedKey);
    }
  }
  // 镜像标签页兜底释放
  const mirrorKey = store.mirrorRoutes[taskId];
  if (mirrorKey && !touched.includes(mirrorKey)) {
    const s = store.sessions[mirrorKey];
    if (s?.executing) {
      store.sessions[mirrorKey] = {
        ...s,
        executing: false,
        currentTask: s.currentTask
          ? { ...s.currentTask, ...taskPatch }
          : { id: taskId, ...taskPatch },
      };
      touched.push(mirrorKey);
    }
  }
  return touched;
}

export function clearSessionTaskState(sessionKey) {
  const instanceId = createSessionInstanceId();
  patchStoreSession(sessionKey, {
    agentPrompt: '',
    currentUserPrompt: '',
    currentUserImages: [],
    currentTask: null,
    taskSteps: [],
    taskResult: null,
    executing: false,
    delegations: {},
    conversationTurns: [],
    cliSessionId: null,
    // 新开会话立刻有自己的键，后续归档不会并进上一条
    historyThreadId: `new:${instanceId}`,
    sessionWorkingDir: '',
    skipHistoryRecover: Date.now(),
    sessionInstanceId: instanceId,
    mirroredSessionInstanceId: '',
  });
}

/** 用户刚点击「新会话」后的空白会话（应忽略迟到的任务收尾/恢复） */
export function isFreshAgentSession(sess) {
  if (!sess?.skipHistoryRecover) return false;
  if (Date.now() - sess.skipHistoryRecover > 120_000) return false;
  return !sess.executing
    && !sess.currentUserPrompt
    && !sess.taskSteps?.length
    && !sess.currentTask
    && !sess.conversationTurns?.length;
}

/** 是否存在尚未收到 tool_result 的 tool_call */
export function hasOpenToolCalls(steps = []) {
  const openNamed = new Set();
  let anonOpen = 0;
  for (const s of steps || []) {
    const t = s?.stepType || s?.kind;
    const id = s?.tool_use_id || null;
    if (t === 'tool_call') {
      if (id) openNamed.add(id);
      else anonOpen += 1;
    } else if (t === 'tool_result') {
      if (id) openNamed.delete(id);
      else if (anonOpen > 0) anonOpen -= 1;
    }
  }
  return openNamed.size > 0 || anonOpen > 0;
}

/**
 * 任务中止/收尾时补齐未完成工具结果，避免 UI 一直显示「执行中」
 */
export function closePendingToolSteps(steps = [], reason) {
  const closeReason = reason || uiT('debug.agent.interrupted');
  const list = Array.isArray(steps) ? [...steps] : [];
  const openNamed = new Map(); // id → tool_name
  const anonStack = []; // { name }
  for (const s of list) {
    const t = s?.stepType || s?.kind;
    const id = s?.tool_use_id || null;
    if (t === 'tool_call') {
      if (id) openNamed.set(id, s.tool_name || 'tool');
      else anonStack.push({ name: s.tool_name || 'tool' });
    } else if (t === 'tool_result') {
      if (id) openNamed.delete(id);
      else if (anonStack.length) anonStack.pop();
    }
  }
  const now = Date.now();
  for (const [id, name] of openNamed) {
    list.push({
      stepType: 'tool_result',
      tool_name: name,
      content: closeReason,
      is_error: true,
      tool_use_id: id,
      timestamp: now,
    });
  }
  for (const item of anonStack) {
    list.push({
      stepType: 'tool_result',
      tool_name: item.name,
      content: closeReason,
      is_error: true,
      tool_use_id: null,
      timestamp: now,
    });
  }
  return list;
}

/** 步骤「丰富度」评分，用于归档 upsert（含工具，避免只比 thinking 丢掉后半段工具链） */
function stepsRichnessScore(steps = []) {
  const list = Array.isArray(steps) ? steps : [];
  const textScore = foldedTypeChars(list, 'output') + foldedTypeChars(list, 'thinking');
  const toolCalls = list.filter(s => (s.stepType || s.kind) === 'tool_call').length;
  const toolResults = list.filter(s => (s.stepType || s.kind) === 'tool_result').length;
  const other = list.filter(s => {
    const t = s.stepType || s.kind;
    return t && t !== 'output' && t !== 'thinking' && t !== 'tool_call' && t !== 'tool_result';
  }).length;
  // 每条工具/结果加权，避免「思考字多但工具链被截断」的残缺归档胜出
  return textScore + toolCalls * 80 + toolResults * 120 + other * 40;
}

function pickRicherResult(a, b) {
  const len = (r) => String(r?.summary || r?.output || '').length;
  const richer = len(b) > len(a) ? b : a;
  const other = richer === a ? b : a;
  if (richer && !richer.artifacts?.length && other?.artifacts?.length) {
    return { ...richer, artifacts: other.artifacts };
  }
  return richer;
}

/** 归档前闭合未完成工具，避免历史里长期显示「未完成」且后半段像被截断 */
function finalizeStepsForArchive(steps = [], status) {
  const reason = status === 'cancelled'
    ? uiT('debug.agent.aborted')
    : uiT('debug.agent.noResult');
  return closePendingToolSteps(steps, reason);
}

/** 任务完成后归档为一轮对话（同 taskId 以更完整内容 upsert） */
export function archiveCompletedTurn(sessionKey, turn) {
  if (!sessionKey || !turn?.user) return;
  const s = getStoreSession(sessionKey);
  const turns = [...(s.conversationTurns || [])];
  const existingIdx = turn.taskId ? turns.findIndex(t => t.taskId === turn.taskId) : -1;
  const incomingSteps = finalizeStepsForArchive(turn.steps || [], turn.status);
  const images = Array.isArray(turn.images) ? turn.images : undefined;

  if (existingIdx >= 0) {
    const prev = turns[existingIdx];
    const prevSteps = finalizeStepsForArchive(prev.steps || [], prev.status);
    const mergedSteps = preferRicherSteps(incomingSteps, prevSteps);
    const mergedResult = pickRicherResult(turn.result, prev.result);
    const richer = stepsRichnessScore(mergedSteps) > stepsRichnessScore(prevSteps)
      || String(mergedResult?.summary || mergedResult?.output || '').length
        > String(prev.result?.summary || prev.result?.output || '').length
      || (mergedSteps.length > (prev.steps || []).length);
    // 即使「不够更富」也要用闭合后的步骤回写，消掉历史里的「未完成」
    if (!richer && !hasOpenToolCalls(prev.steps || [])) return;
    turns[existingIdx] = {
      ...prev,
      steps: richer ? mergedSteps : prevSteps,
      delegations: { ...(prev.delegations || {}), ...(turn.delegations || {}) },
      result: richer ? mergedResult : (prev.result || mergedResult),
      status: turn.status || prev.status,
      timestamp: turn.timestamp || prev.timestamp,
      sentAt: prev.sentAt || turn.sentAt || null,
      // 保留先到的附图；新归档有图则覆盖
      images: (images && images.length) ? images : prev.images,
    };
  } else {
    turns.push({
      user: turn.user,
      steps: incomingSteps,
      delegations: turn.delegations || {},
      result: turn.result || null,
      status: turn.status || 'completed',
      taskId: turn.taskId || null,
      timestamp: turn.timestamp || Date.now(),
      sentAt: turn.sentAt || null,
      ...(images && images.length ? { images } : {}),
    });
  }

  patchStoreSession(sessionKey, {
    conversationTurns: turns,
    cliSessionId: turn.cliSessionId || s.cliSessionId || null,
    sessionWorkingDir: normalizeWorkingDir(turn.workingDir || s.sessionWorkingDir || ''),
    // 粘住首轮线程，避免后续 CLI session 变化把历史拆成新会话
    historyThreadId: s.historyThreadId
      || (turns[0]?.taskId ? `task:${turns[0].taskId}` : null),
  });
}

/** 统一工作目录字符串，避免尾斜杠导致续接失败 */
export function normalizeWorkingDir(dir) {
  const s = String(dir || '').trim();
  if (!s) return '';
  return s.replace(/[\\/]+$/, '');
}

/** 路径末段，供历史列表 / 作曲栏展示（会话绑定工程） */
export function workingDirBasename(dir) {
  const s = normalizeWorkingDir(dir);
  if (!s) return '';
  const parts = s.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] || s;
}

/** 同工作目录下是否可续接 CLI 会话 */
export function shouldContinueCliSession(sessionKey, workingDir) {
  const s = getStoreSession(sessionKey);
  const dir = normalizeWorkingDir(workingDir);
  const bound = normalizeWorkingDir(s.sessionWorkingDir);
  if (!dir || !bound || dir !== bound) return false;
  const last = s.conversationTurns?.length
    ? s.conversationTurns[s.conversationTurns.length - 1]
    : null;
  const sid = s.cliSessionId || last?.cliSessionId || last?.result?.cliSessionId || null;
  // 有明确 sessionId：中止/失败后也可 --resume，避免「停止再继续」丢上下文
  if (sid) return true;
  if (!last) return false;
  // 无 CLI id 时：成功可盲续；中止/失败也允许同目录续聊（靠 prompt 摘要，不拆新会话）
  if (['completed', 'cancelled', 'failed'].includes(last.status) || last?.result?.cancelled) {
    return true;
  }
  return false;
}

/** 上一轮是否为中止/失败且仍可续接 */
export function canResumeInterruptedSession(sessionKey, workingDir) {
  if (!shouldContinueCliSession(sessionKey, workingDir)) return false;
  const s = getStoreSession(sessionKey);
  const last = s.conversationTurns?.length
    ? s.conversationTurns[s.conversationTurns.length - 1]
    : null;
  if (!last) return !!(s.cliSessionId);
  return ['cancelled', 'failed'].includes(last.status) || !!last?.result?.cancelled;
}

/**
 * 无 CLI sessionId 时的续接提示：附带上次工具/输出摘要，降低失忆
 */
export function buildInterruptedContinuePrompt(userPrompt, lastTurn) {
  const base = String(userPrompt || '').trim()
    || uiT('debug.agent.resumePrompt');
  const steps = lastTurn?.steps || [];
  if (!steps.length) return base;
  const bits = [];
  for (const s of steps) {
    const stepType = s?.stepType || s?.kind;
    if (stepType === 'tool_call') {
      const name = s.tool_name || 'tool';
      const arg = String(s.content || '').replace(/\s+/g, ' ').slice(0, 140);
      bits.push(uiT('debug.agent.calledTool', { name, arg: arg ? `: ${arg}` : '' }));
    } else if (stepType === 'tool_result' && s.is_error) {
      bits.push(uiT('debug.agent.toolFailed', { msg: String(s.content || '').slice(0, 100) }));
    } else if (stepType === 'output' && String(s.content || '').trim()) {
      bits.push(uiT('debug.agent.outputSummary', {
        msg: String(s.content).replace(/\s+/g, ' ').slice(0, 180),
      }));
    }
  }
  if (!bits.length) return base;
  return `${base}\n\n${uiT('debug.agent.progressHeader')}\n${bits.slice(-10).join('\n')}`;
}

/** 上一轮是否因超时结束（错误文案里带 timeout） */
export function turnTimedOut(turn) {
  return /timeout/i.test(`${turn?.result?.error || ''} ${turn?.result?.stderr || ''}`);
}

/** 超时后续跑要用的正文：优先最终结果，否则拼接输出步骤 */
export function partialAssistantText(turn) {
  const direct = String(turn?.result?.summary || turn?.result?.output || '').trim();
  if (direct) return direct.slice(0, 80_000);
  const bits = [];
  for (const s of turn?.steps || []) {
    const kind = s?.stepType || s?.kind;
    if (kind !== 'output' && kind !== 'text') continue;
    const text = String(s?.content || '').trim();
    if (text) bits.push(text);
  }
  if (!bits.length) return '';
  const last = bits[bits.length - 1];
  // 快照会把全文反复推送，最后一条已经包含前面的就不要再拼一遍
  if (bits.length > 1 && last.startsWith(bits[0])) return last.slice(0, 80_000);
  return bits.join('\n\n').slice(0, 80_000);
}

/**
 * 超时后续跑。远程任务每次都是新会话，必须把已生成内容放进 prompt。
 */
export function buildTimeoutContinuePrompt(userPrompt, lastTurn) {
  const base = String(userPrompt || '').trim() || uiT('debug.agent.resumePrompt');
  const priorUser = String(lastTurn?.user || '').trim().slice(0, 4_000);
  const partial = partialAssistantText(lastTurn);
  const parts = [uiT('debug.agent.timeoutContinueLead')];
  if (priorUser) parts.push(`${uiT('debug.agent.timeoutOriginal')}\n${priorUser}`);
  if (partial) parts.push(`${uiT('debug.agent.timeoutPartial')}\n${partial}`);
  parts.push(base);
  return parts.join('\n\n');
}

/** Debug Agent 列表前端缓存（stale-while-revalidate） */
let agentsListCache = null;

export function getCachedAgentsList() {
  return agentsListCache;
}

export function setCachedAgentsList(agents) {
  agentsListCache = Array.isArray(agents) ? agents : null;
}
