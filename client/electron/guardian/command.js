// client/electron/guardian/command.js
// 说一句话就办：资产页搜索框里的管理类指令（安装、启用 / 停用、诊断、体检、自省、切换执行应用、整理、清理闲置、看状态）。
// 先用规则听懂；规则听不懂、又有模型时，请模型从固定白名单里选一个动作。做业务的请求（写代码、写文章…）不在这里办，
// 引导到游乐场。除了「看状态」这类只读的，其余都要用户在界面上确认后才执行；执行结果写进自动处理记录，能撤销的可撤销。
'use strict';

const guardian = require('./index');

const ACTIONS = new Set(['status', 'check', 'introspect', 'install', 'project', 'unproject', 'diagnose', 'runtime', 'idle', 'tidy', 'business', 'unknown']);
const READ_ONLY = new Set(['status', 'diagnose', 'idle', 'tidy']);

const AGENT_ALIASES = [
  ['claude-code', /claude\s*code|claude|cc\b/i],
  ['codex', /codex/i],
  ['cursor', /cursor/i],
  ['kimi-code', /kimi/i],
  ['workbuddy', /workbuddy/i],
  ['opencode', /opencode/i],
  ['pi', /\bpi\b/i],
];

function rm() {
  const m = require('../resource-manager');
  m.init();
  return m;
}

function agentLabel(id) {
  try { return require('../config-loader').appEntityById(id)?.name || id; } catch { return id; }
}

function findAgent(text) {
  for (const [id, re] of AGENT_ALIASES) if (re.test(String(text || ''))) return id;
  return null;
}

/** 按名字 / 显示名在资产库里找；找不到返回 null */
function findResource(name) {
  const q = String(name || '').trim().replace(/^[「『"'“]|[」』"'”]$/g, '').toLowerCase();
  if (!q) return null;
  const all = rm().listResources({}).filter(r => ['skill', 'prompt', 'assistant'].includes(r.type));
  return all.find(r => r.name.toLowerCase() === q || String(r.display_name || '').toLowerCase() === q)
    || all.find(r => r.name.toLowerCase().includes(q) || String(r.display_name || '').toLowerCase().includes(q))
    || null;
}

const strip = (s) => String(s || '').replace(/^(这个|那个|一下|一个|下)\s*/, '').replace(/\s*(技能|提示词|智能体|吧|一下|呢|吗)\s*$/, '').trim();

/** 规则解析；返回 { action, ...参数 }，认不出时 action = 'unknown' */
function parseRules(text) {
  const s = String(text || '').trim();
  if (!s) return { action: 'unknown' };
  let m;
  if (/^(看护|看护状态|运行情况|状态|现在怎么样|health|status)[?？]?$/i.test(s) || /看护.*(怎么样|正常吗|状态)/.test(s)) return { action: 'status' };
  if (/自省/.test(s)) return { action: 'introspect' };
  if ((m = s.match(/(?:用|换成?|改用|切到)\s*(Claude\s*Code|Codex|Cursor|Kimi(?:\s*Code)?|WorkBuddy)\s*(?:来)?(?:跑|执行|运行)?/i)) && !/(安装|装|启用|投射|停用)/.test(s)) {
    return { action: 'runtime', agent: findAgent(m[1]) };
  }
  if (/(清理|看看|列出).{0,4}闲置|闲置.{0,6}(技能|清理)|没用过的技能/.test(s)) return { action: 'idle' };
  if (/^(体检|检查|检查一下|全面检查|跑一下检查)$/.test(s) || /(体检|检查)一下(资产|技能|所有)?$/.test(s)) return { action: 'check' };
  if ((m = s.match(/^(?:帮我)?(?:安装|装上?|install)\s+(.+)$/i)) || (m = s.match(/^(?:帮我)?(?:安装|装上?)(.+)$/))) {
    return { action: 'install', target: strip(m[1]) };
  }
  if ((m = s.match(/(?:为什么|怎么)\s*(.+?)\s*(?:不生效|没生效|用不了|看不到|没效果|不起作用)/)) || (m = s.match(/^诊断\s*(.+)$/))) {
    return { action: 'diagnose', name: strip(m[1]) };
  }
  if ((m = s.match(/^(?:把)?\s*(.+?)\s*(?:从\s*(\S+?)\s*)?(?:停用|撤下|撤掉|取消投射|关掉|移除)(?:掉)?$/)) || (m = s.match(/^(?:停用|撤下|取消投射)\s*(.+?)(?:\s*(?:从|在)\s*(\S+))?$/))) {
    return { action: 'unproject', name: strip(m[1]), agent: findAgent(m[2] || s) };
  }
  if ((m = s.match(/^(?:把)?\s*(.+?)\s*(?:投射|启用|装)(?:到|给|在)\s*(.+?)(?:上|里)?$/)) || (m = s.match(/^(?:启用|投射)\s*(.+?)$/))) {
    return { action: 'project', name: strip(m[1]), agent: findAgent(m[2] || '') };
  }
  if ((m = s.match(/^(?:把|帮我把)?\s*(.+?)\s*(?:技能|提示词|智能体|资产)?\s*(?:整理|理)一下$/)) || (m = s.match(/^整理\s*(.+?)(?:技能|资产)?$/))) {
    return { action: 'tidy', keyword: strip(m[1]).replace(/^(所有|全部)$/, '') };
  }
  // 做业务的请求：交给游乐场
  if (/^(帮我|请|给我)?\s*(写|生成|做|改|翻译|总结|分析|设计|画|部署|修复|实现|重构|解释|查一下|调研)/.test(s) && s.length > 4) return { action: 'business' };
  return { action: 'unknown' };
}

/** 规则听不懂时请模型从白名单里选（需要模型；没有模型就算了） */
async function parseModel(text) {
  const prompt = [
    '把下面这句话归到 Token Bank 的一个管理动作上，只输出 JSON，不要解释。',
    '可选 action：status（看看护状态）、check（体检）、introspect（自省）、install（安装技能，target=名称/地址/命令）、',
    'project（把资产启用到应用，name=资产名，agent=应用名）、unproject（从应用撤下，name, agent）、diagnose（name）、',
    'runtime（切换执行应用，agent）、idle（看闲置技能）、tidy（整理某类技能，keyword）、business（这是要做事的业务请求，不是管理）、unknown。',
    '格式：{"action":"...","name":"","agent":"","target":"","keyword":""}',
    `这句话：${String(text).slice(0, 300)}`,
  ].join('\n');
  const r = await require('./model-call').chat({ maxTokens: 120, messages: [{ role: 'user', content: prompt }], timeoutMs: 20000 });
  if (!r.ok) return null;
  try {
    const j = JSON.parse((r.text.match(/\{[\s\S]*\}/) || [''])[0]);
    if (!ACTIONS.has(j.action)) return null;
    const out = { action: j.action, source: 'model' };
    if (j.name) out.name = strip(j.name);
    if (j.target) out.target = strip(j.target);
    if (j.keyword) out.keyword = strip(j.keyword);
    if (j.agent) out.agent = findAgent(j.agent);
    return out;
  } catch { return null; }
}

/** 解析并补全：找资产、给出要确认的说明 */
async function parse(text, { allowModel = true } = {}) {
  let plan = parseRules(text);
  if (plan.action === 'unknown' && allowModel && guardian.getSettings().enabled) {
    const viaModel = await parseModel(text).catch(() => null);
    if (viaModel) plan = viaModel;
  }
  const out = { ...plan, text: String(text || '').trim(), readOnly: READ_ONLY.has(plan.action) };
  if (['project', 'unproject', 'diagnose'].includes(plan.action)) {
    const r = findResource(plan.name);
    if (!r) return { ...out, action: 'unknown', reason: `资产库里没找到「${plan.name}」` };
    out.resourceId = r.id;
    out.resourceName = r.display_name || r.name;
  }
  if (plan.action === 'project' && !plan.agent) {
    // 没说装到哪：装到已纳管的应用
    out.agent = null;
  }
  if (plan.action === 'runtime' && !plan.agent) return { ...out, action: 'unknown', reason: '没听出要换成哪个应用' };
  if (plan.action === 'install' && !plan.target) return { ...out, action: 'unknown', reason: '没听出要装什么' };
  out.describe = describe(out);
  return out;
}

function describe(p) {
  const who = p.agent ? agentLabel(p.agent) : '已纳管的应用';
  switch (p.action) {
    case 'status': return '查看智能看护的运行情况';
    case 'check': return '立即跑一遍看护检查（资产体检、投射自愈、配置提醒等）';
    case 'introspect': return '立即做一次定期自省';
    case 'install': return `安装「${p.target}」`;
    case 'project': return `把「${p.resourceName}」启用到 ${who}`;
    case 'unproject': return `把「${p.resourceName}」从 ${p.agent ? who : '所有应用'} 撤下（不删除，可再启用）`;
    case 'diagnose': return `诊断「${p.resourceName}」为什么不生效`;
    case 'runtime': return `以后用 ${agentLabel(p.agent)} 跑兴趣画像、资产发现、技能安装`;
    case 'idle': return '列出 30 天没用过的技能';
    case 'tidy': return p.keyword ? `检查「${p.keyword}」相关技能的重复和质量` : '检查所有技能的重复和质量';
    case 'business': return '这是要做事的请求，交给游乐场的智能体去做';
    default: return p.reason || '没听懂，可以换个说法，比如「安装 owner/repo」「把 git-commit 启用到 Codex」「为什么 xxx 不生效」';
  }
}

function note(title, detail, undo) {
  return guardian.record({ category: 'assets', kind: 'command', status: 'done', title, detail, ...(undo ? { undo } : {}) });
}

/** 执行（界面确认后调用） */
async function run(plan = {}) {
  const m = rm();
  switch (plan.action) {
    case 'status': {
      const h = await require('./health').health();
      const msg = h.level === 'ok' ? '运行正常' : h.level === 'off' ? '智能看护已关闭' : `需要注意：${h.issues.map(i => i.text).join('；')}`;
      return { ok: true, message: msg, link: { to: '/guardian', label: '看护页' } };
    }
    case 'check': {
      const r = await guardian.runChecks();
      const bad = Object.entries(r).filter(([, v]) => v && v.ok === false).length;
      return { ok: true, message: bad ? `检查完成，${bad} 项出错` : '检查完成，结果在看护页的自动处理记录里', link: { to: '/guardian', label: '看护页' } };
    }
    case 'introspect': {
      const r = await require('./introspect').run({ manual: true });
      return r.ok ? { ok: true, message: '自省完成，报告在看护页', link: { to: '/guardian', label: '看护页' } } : { ok: false, error: r.error === 'running' ? '自省正在进行中' : r.error };
    }
    case 'runtime': {
      const prev = require('./engine').status().runtime;
      const r = require('./engine').setRuntime(plan.agent);
      if (!r.ok) return { ok: false, error: r.error };
      note(`已改用 ${agentLabel(plan.agent)} 跑看护任务`, plan.text, prev ? { type: 'commandSetRuntime', data: { agent: prev } } : null);
      return { ok: true, message: `以后用 ${agentLabel(plan.agent)} 跑兴趣画像、资产发现、技能安装` };
    }
    case 'install': {
      const target = plan.target;
      const isGithub = /github\.com\/|^[\w.-]+\/[\w.-]+$/.test(target);
      if (isGithub) {
        const res = await m.installGithubSkill(target);
        if (!res?.success) return { ok: false, error: res?.error || '安装失败' };
        note(`已安装「${res.resource?.display_name || res.skillName}」`, target, { type: 'removeInstalled', data: { ids: [res.resource.id] } });
        return { ok: true, message: `已安装「${res.skillName}」`, link: { to: '/resources', label: '去资产页' } };
      }
      let catalog = [];
      try { catalog = require('../resource-catalog').listCatalogItems({}); } catch { /* 离线 */ }
      const q = target.toLowerCase();
      const hit = catalog.find(c => c.name.toLowerCase() === q || String(c.display_name || '').toLowerCase() === q);
      if (hit && !(hit.metadata?.user_recommended && hit.metadata?.recommender_user_id)) {
        const res = m.installFromCatalog(hit.catalogId);
        if (!res?.success) return { ok: false, error: res?.error || '安装失败' };
        note(`已安装「${hit.display_name || hit.name}」`, target, { type: 'removeInstalled', data: { ids: [res.resource.id] } });
        return { ok: true, message: `已安装「${hit.display_name || hit.name}」`, link: { to: '/resources', label: '去资产页' } };
      }
      if (hit) return { ok: false, error: '这是付费的社区条目，请到资产页的发现里确认后再装' };
      const r = await require('./engine').run({ kind: 'install', prompt: `请安装：${target}`, sessionKey: 'resource-install' });
      if (!r.ok) return { ok: false, error: r.error === 'no-runtime' ? '没有可用的执行应用，先到网关页纳管 Codex / Claude Code 等' : r.error };
      return { ok: true, message: `已交给 ${agentLabel(r.runtime)} 在后台安装「${target}」，进度看侧边栏的看护小圆点`, link: { to: '/guardian', label: '看护页' } };
    }
    case 'project': {
      const r = m.getResource(plan.resourceId);
      if (!r) return { ok: false, error: '资产不存在' };
      if (require('./asset-checks').securityGate(r)) return { ok: false, error: '这个技能有高风险操作，请到资产页查看后再手动投射' };
      let managed = [];
      try {
        managed = r.type === 'skill'
          ? require('../resource-agent-targets').listManagedResourceAgentIds()
          : [...require('../mcp-gateway-targets').listManagedAppTargetIds()];
      } catch { managed = []; }
      if (plan.agent && !managed.includes(plan.agent)) return { ok: false, error: `${agentLabel(plan.agent)} 还没有纳管，先到网关页纳管它` };
      const ids = plan.agent ? [plan.agent] : managed;
      if (!ids.length) return { ok: false, error: '还没有纳管任何应用' };
      let res;
      try { res = m.projectToAgents(r.id, ids, 'global', { force: false }); } catch (e) { return { ok: false, error: e.message }; }
      if (res && res.success === false) return { ok: false, error: res.error || '投射失败' };
      note(`已把「${plan.resourceName}」启用到 ${ids.map(agentLabel).join('、')}`, plan.text, { type: 'commandUnproject', data: { resourceId: r.id, agentIds: ids } });
      return { ok: true, message: `已启用到 ${ids.map(agentLabel).join('、')}；应用通常要新开会话才会读到` };
    }
    case 'unproject': {
      const r = m.getResource(plan.resourceId);
      if (!r) return { ok: false, error: '资产不存在' };
      const ids = (r.projections || []).map(p => p.agentId).filter(id => !plan.agent || id === plan.agent)
        .filter(id => !require('./diagnose').INTERNAL_TARGETS.has(id));
      if (!ids.length) return { ok: false, error: plan.agent ? `它没有投射到 ${agentLabel(plan.agent)}` : '它还没有投射到任何应用' };
      for (const id of ids) m.unproject({ resourceId: r.id, agentId: id });
      note(`已把「${plan.resourceName}」从 ${ids.map(agentLabel).join('、')} 撤下`, plan.text, { type: 'commandProject', data: { resourceId: r.id, agentIds: ids } });
      return { ok: true, message: `已从 ${ids.map(agentLabel).join('、')} 撤下（资产还在，可随时再启用）` };
    }
    case 'diagnose': {
      const d = require('./diagnose').diagnoseResource(plan.resourceId);
      const lines = (d.findings || []).map(f => f.text);
      return { ok: true, message: lines.join(' ') || '没有发现问题', link: { to: '/resources', label: '去资产页修复', state: { selectKey: `r-${plan.resourceId}` } } };
    }
    case 'idle': {
      const r = m.listIdleSkills({ days: 30 });
      const items = (r && r.items) || [];
      return { ok: true, message: items.length ? `${items.length} 个技能 30 天没用过：${items.slice(0, 6).map(i => i.display_name || i.name).join('、')}${items.length > 6 ? ' 等' : ''}。要清理的话到资产页的「清理闲置」里勾选` : '没有 30 天没用过的技能', link: { to: '/resources', label: '去资产页' } };
    }
    case 'tidy': {
      await require('./asset-checks').check();
      const flags = require('./asset-checks').getFlags();
      const kw = String(plan.keyword || '').toLowerCase();
      const skills = m.listResources({ type: 'skill' }).filter(r => !kw || `${r.name} ${r.display_name || ''} ${r.description || ''} ${(r.metadata?.tags || []).join(' ')}`.toLowerCase().includes(kw));
      const dup = skills.filter(r => flags[r.id]?.duplicateOf?.length);
      const weak = skills.filter(r => flags[r.id]?.quality === 'warn');
      if (!skills.length) return { ok: true, message: `没有找到和「${plan.keyword}」相关的技能` };
      const parts = [`${skills.length} 个相关技能`];
      if (dup.length) parts.push(`${dup.length} 个有内容重复：${dup.slice(0, 4).map(r => r.display_name || r.name).join('、')}`);
      if (weak.length) parts.push(`${weak.length} 个描述需要完善：${weak.slice(0, 4).map(r => r.display_name || r.name).join('、')}`);
      if (!dup.length && !weak.length) parts.push('没有重复，描述也都完整');
      return { ok: true, message: parts.join('；'), link: { to: '/resources', label: '去资产页', state: { query: plan.keyword || '' } } };
    }
    case 'business':
      return { ok: true, message: '这类请求交给游乐场的智能体去做', link: { to: '/debug', label: '去游乐场', state: { prompt: plan.text } } };
    default:
      return { ok: false, error: describe(plan) };
  }
}

function register() {
  guardian.registerAction('commandUnproject', ({ resourceId, agentIds = [] }) => {
    const m = rm();
    for (const id of agentIds) { try { m.unproject({ resourceId, agentId: id }); } catch { /* 已撤下 */ } }
    return { ok: true };
  });
  guardian.registerAction('commandProject', ({ resourceId, agentIds = [] }) => {
    const res = rm().projectToAgents(resourceId, agentIds, 'global', { force: false });
    return res && res.success === false ? { ok: false, error: res.error } : { ok: true };
  });
  guardian.registerAction('commandSetRuntime', ({ agent }) => {
    const r = require('./engine').setRuntime(agent);
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  });
}

module.exports = { register, parse, parseRules, run, describe, READ_ONLY };
