// client/electron/guardian/team-watch.js
// 智能管家盯「一批任务」（agent-team.js）的活性：
//   · 还在跑、但很久没有任何进展（没有新步骤、没有子任务开始或结束、没有留言）：提醒用户，给「取消这批任务」
//   · 应用重启前没跟完的：路由那一轮其实已经结束了，就按它的结果收尾（重启后不再补跑验收）
// 只看、只提醒；取消要用户点。每 5 分钟看一次。
'use strict';

const guardian = require('./index');

const STALL_MS = 20 * 60 * 1000;
const EVERY_MS = 5 * 60 * 1000;
const TERMINAL = ['completed', 'failed', 'cancelled'];

function executor() { return require('../agent-executor'); }

async function check({ now = Date.now(), team = require('../agent-team') } = {}) {
  if (guardian.modeOf('gateway') === 'off') return { ok: true, skipped: true };
  const found = [];
  for (const t of team.list({ limit: 50 })) {
    if (t.status !== 'running') continue;
    const lastRound = [...(t.events || [])].reverse().find((e) => (e.type === 'start' || e.type === 'rework') && e.taskId);
    let round = null;
    try { round = lastRound ? await executor().getTaskStatus(lastRound.taskId) : null; } catch { round = null; }
    // 收尾：路由那一轮已经结束、团队还挂着（多半是应用重启过，没人跟了）
    if (round && TERMINAL.includes(round.status) && now - (t.updatedAt || 0) > EVERY_MS) {
      team.update(t.id, (x) => {
        x.status = round.status === 'completed' ? 'delivered' : (round.status === 'cancelled' ? 'cancelled' : 'failed');
        x.endedAt = now;
        x.events.push({ at: now, type: 'end', text: '智能管家收尾（应用重启过，这一轮没有再验收）' });
      });
      continue;
    }
    const last = team.lastActivity(t.id);
    if (!last || now - last < STALL_MS) continue;
    const mins = Math.round((now - last) / 60000);
    found.push(t.id);
    guardian.record({
      category: 'gateway', kind: 'team-stalled', status: 'info', needsUser: true,
      title: `一批任务 ${mins} 分钟没有进展`,
      say: `「${String(t.prompt || '').slice(0, 40)}」这批任务已经 ${mins} 分钟没有任何进展了（没有新步骤、子任务没有开始或结束、协作区没有留言）。可能是成员在互相等，或者某个子任务卡住了。`,
      signature: `team-stalled|${t.id}`,
      actions: [{ label: '取消这批任务', run: { type: 'cancelTeam', data: { teamId: t.id } }, doneText: '已取消这批任务里还在跑的任务。' }],
      meta: { teamId: t.id },
    });
  }
  return { ok: true, stalled: found };
}

/** 取消这批任务里还在跑的：每一轮路由任务和它们的子任务 */
async function cancelTeam({ teamId }) {
  const team = require('../agent-team');
  const nodes = team.tree(teamId);
  let n = 0;
  for (const node of nodes) {
    if (TERMINAL.includes(node.status)) continue;
    try { await executor().cancel(node.id); n += 1; } catch { /* 已经结束了 */ }
  }
  team.update(teamId, (x) => {
    x.status = 'cancelled';
    x.endedAt = Date.now();
    x.events.push({ at: Date.now(), type: 'end', text: `用户取消（停了 ${n} 个还在跑的任务）` });
  });
  return { ok: true, message: `停了 ${n} 个还在跑的任务` };
}

let timer = null;
function register() {
  guardian.registerAction('cancelTeam', cancelTeam);
  guardian.registerCheck('teams', () => check());
  if (!timer) {
    timer = setInterval(() => { guardian.runCheck('teams').catch(() => {}); }, EVERY_MS);
    if (timer.unref) timer.unref();
  }
}

module.exports = { register, check, cancelTeam, STALL_MS };
