// client/electron/guardian/capability-gaps.js
// 能力缺口：最近 30 天经常在做某类事（会话里的用户请求 + 派给智能体的任务），却没有对应的技能 / 提示词 / 智能体。
// 纯规则：按固定主题表归类，不花 token。找到缺口就推荐社区里最对得上的免费条目（用户点了才装，可撤销），
// 社区也没有就引导去发现页生成。结果在发现页置顶。
'use strict';

const guardian = require('./index');
const store = require('./store');

const WINDOW_DAYS = 30;
const MIN_TIMES = 3;
const MAX_GAPS = 3;
const STALE_MS = 6 * 60 * 60 * 1000;
const QUIET_DAYS = 30;

// 主题表：label 给用户看；re 同时用来认请求和认资产（名字 + 描述）
const TOPICS = [
  { id: 'commit', label: '写提交信息', re: /commit\s*(message|msg)|提交信息|conventional commits?|写.{0,4}commit/i },
  { id: 'review', label: '代码审查', re: /code\s*review|review (the |this |my )?(pr|pull request|diff|code)|代码审查|审查代码|review\s*一下|cr\b/i },
  { id: 'test', label: '写测试', re: /\b(unit|e2e|integration) tests?\b|write tests?|测试用例|单元测试|写测试|补测试|test coverage/i },
  { id: 'debug', label: '排查报错', re: /\b(debug|stack ?trace|traceback|exception)\b|报错|排查|调试|修\s*bug|fix (the |this )?(bug|error)/i },
  { id: 'refactor', label: '重构代码', re: /\brefactor|重构/i },
  { id: 'deploy', label: '部署上线', re: /\b(deploy|deployment|k8s|kubernetes|helm|docker ?compose|ci\/cd|github actions)\b|部署|上线|发布到生产/i },
  { id: 'sql', label: '数据库与 SQL', re: /\b(sql|postgres(ql)?|mysql|sqlite|query plan|explain analyze)\b|数据库|慢查询|建表/i },
  { id: 'frontend', label: '前端页面', re: /\b(react|vue|css|tailwind|front-?end|ui component)\b|前端|页面样式|组件/i },
  { id: 'docs', label: '写文档', re: /\b(readme|docs?|documentation|api doc)\b|写文档|文档|说明书/i },
  { id: 'translate', label: '翻译', re: /\btranslat(e|ion)\b|翻译|译成|中译英|英译中/i },
  { id: 'report', label: '写周报 / 汇报', re: /周报|日报|月报|工作汇报|weekly (report|update)|status update/i },
  { id: 'slides', label: '做 PPT', re: /\b(ppt|pptx|slides?|deck|keynote)\b|幻灯片|演示文稿/i },
  { id: 'sheet', label: '表格处理', re: /\b(excel|xlsx|csv|spreadsheet)\b|表格|透视表/i },
  { id: 'pdf', label: 'PDF 处理', re: /\bpdf\b/i },
  { id: 'data', label: '数据分析与图表', re: /\b(data analysis|chart|plot|dashboard|pandas|matplotlib)\b|数据分析|图表|可视化/i },
  { id: 'scrape', label: '网页抓取', re: /\b(scrap(e|ing)|crawl(er)?|playwright|puppeteer)\b|爬虫|抓取网页|爬取/i },
  { id: 'image', label: '图片生成与处理', re: /\b(image|logo|icon|illustration)\b.{0,12}(generat|draw|design|make)|生成图片|画一?张|做图|海报|图标设计/i },
  { id: 'video', label: '视频制作', re: /\bvideo\b|视频|剪辑|字幕/i },
  { id: 'email', label: '写邮件', re: /\b(email|e-mail)\b.{0,10}(write|draft|reply)|写邮件|回复邮件|邮件草稿/i },
  { id: 'research', label: '调研与资料整理', re: /\b(research|literature|paper|survey)\b|调研|文献|论文|竞品分析/i },
  { id: 'prd', label: '写需求文档', re: /\b(prd|spec|user stor(y|ies)|requirements?)\b|需求文档|产品需求|功能规格/i },
  { id: 'security', label: '安全检查', re: /\b(security|vulnerab|cve|pentest|xss|sql injection)\b|安全漏洞|安全检查|漏洞扫描/i },
  { id: 'seo', label: 'SEO 与营销文案', re: /\bseo\b|营销文案|推广文案|小红书|公众号文章|copywriting/i },
];

function rm() {
  const m = require('../resource-manager');
  m.init();
  return m;
}

function topicsOf(text) {
  const s = String(text || '');
  return TOPICS.filter(t => t.re.test(s));
}

/** 最近的用户请求：已纳管智能体会话里的原话 + 派给智能体的任务 */
function recentRequests(sinceMs, { collect } = {}) {
  const out = [];
  const norm = (s) => String(s || '').replace(/\s+/g, '').slice(0, 80);
  const taskKeys = new Set();
  try {
    const d = require('../local-stats').getDb();
    const rows = d ? d.prepare('SELECT prompt FROM agent_tasks WHERE created_at >= ? ORDER BY created_at DESC LIMIT 400').all(sinceMs) : [];
    for (const r of rows) if (r.prompt) { out.push(r.prompt); taskKeys.add(norm(r.prompt)); }
  } catch { /* 旧库没有任务表 */ }
  try {
    const sig = (collect || require('../skill-demand-miner').collectWorkSignals)({ sinceDays: WINDOW_DAYS, maxSessions: 120, maxDialogues: 400 });
    for (const dl of sig.dialogues || []) {
      // 派给智能体的任务在它自己的会话里也会出现一次，同一句话只算一次
      if (taskKeys.has(norm(dl.goal)) || [...taskKeys].some(k => k.length >= 12 && norm(dl.goal).includes(k))) continue;
      out.push([dl.goal, ...(dl.notes || [])].join('\n'));
    }
  } catch { /* 没有会话 */ }
  return out;
}

const assetText = (r) => `${r.name || ''} ${r.display_name || ''} ${r.description || ''}`;
const isPaid = (c) => !!(c?.metadata?.user_recommended && c?.metadata?.recommender_user_id);

function findGaps({ requests, owned, catalog }) {
  const counts = new Map();
  for (const text of requests) for (const t of topicsOf(text)) counts.set(t.id, (counts.get(t.id) || 0) + 1);
  const gaps = [];
  for (const t of TOPICS) {
    const n = counts.get(t.id) || 0;
    if (n < MIN_TIMES) continue;
    if (owned.some(r => t.re.test(assetText(r)))) continue;
    const offer = catalog
      .filter(c => !isPaid(c) && ['skill', 'prompt', 'assistant'].includes(c.type) && t.re.test(assetText(c)))
      .sort((a, b) => (a.type === 'skill' ? 0 : 1) - (b.type === 'skill' ? 0 : 1))[0] || null;
    gaps.push({ topic: t, times: n, offer });
  }
  return gaps.sort((a, b) => b.times - a.times).slice(0, MAX_GAPS);
}

const typeLabel = { skill: '技能', prompt: '提示词', assistant: '智能体' };

async function check() {
  if (guardian.modeOf('assets') === 'off') return { ok: true, skipped: true };
  const m = rm();
  const owned = m.listResources({}).filter(r => ['skill', 'prompt', 'assistant'].includes(r.type));
  let catalog = [];
  try { catalog = require('../resource-catalog').listCatalogItems({}); } catch { /* 离线 */ }
  const requests = recentRequests(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const gaps = findGaps({ requests, owned, catalog });
  const open = new Set();
  for (const g of gaps) {
    const sig = `capability-gap|${g.topic.id}`;
    open.add(sig);
    const name = g.offer ? (g.offer.display_name || g.offer.name) : '';
    guardian.record({
      category: 'assets', kind: 'capability-gap', status: 'suggested', countAsRepeat: false, quietDays: QUIET_DAYS,
      title: `最近 ${WINDOW_DAYS} 天有 ${g.times} 次在「${g.topic.label}」，还没有对应的技能`,
      advice: g.offer
        ? `社区里免费的${typeLabel[g.offer.type] || ''}「${name}」对得上，装上后应用遇到这类事会自动用它。`
        : '社区里还没有现成的，可以在发现页让 Token Bank 按你的习惯生成一个。',
      signature: sig,
      ...(g.offer ? {
        apply: { type: 'installCatalogItem', data: { catalogId: g.offer.catalogId } },
      } : {}),
      link: { to: '/resources', label: '去发现页', state: { viewTab: 'recommend', query: g.offer ? name : '' } },
      meta: { topic: g.topic.id, label: g.topic.label, times: g.times, offer: g.offer ? { catalogId: g.offer.catalogId, name, type: g.offer.type } : null },
    });
  }
  // 已经补上或不再常做的，收起
  for (const r of guardian.listRecords({ limit: 300 })) {
    if (r.kind === 'capability-gap' && !open.has(r.signature)) guardian.resolveSignature(r.signature);
  }
  store.writeJson('gaps-state.json', { at: Date.now(), requests: requests.length, gaps: gaps.length });
  return { ok: true, requests: requests.length, gaps: gaps.length };
}

/** 发现页用：太久没算就先算一次，再返回还开着的缺口建议 */
async function listOpen() {
  const st = store.readJson('gaps-state.json', {});
  if (!st.at || Date.now() - st.at > STALE_MS) { try { await check(); } catch { /* ignore */ } }
  return guardian.listRecords({ limit: 300 }).filter(r => r.kind === 'capability-gap' && r.status === 'suggested');
}

/** 采纳：装上社区条目并投射到常用应用；撤销 = 删掉这次装上的 */
async function installCatalogItem({ catalogId }) {
  const m = rm();
  const res = m.installFromCatalog(catalogId);
  if (!res || res.success === false || !res.resource?.id) return { ok: false, error: res?.error || '安装失败' };
  const id = res.resource.id;
  try {
    const ids = res.resource.type === 'skill'
      ? require('../resource-agent-targets').listManagedResourceAgentIds()
      : [...require('../mcp-gateway-targets').listManagedAppTargetIds()];
    if (ids.length) m.projectToAgents(id, ids, 'global', { force: false });
  } catch { /* 没有纳管应用时先只装进资产库 */ }
  let shown = res.resource.display_name || res.resource.name;
  try {
    const item = require('../resource-catalog').getCatalogItem(catalogId);
    if (item && (item.display_name || item.name)) shown = item.display_name || item.name;
  } catch { /* 用资产名 */ }
  guardian.record({
    category: 'assets', kind: 'gap-filled', status: 'done',
    title: `已装上「${shown}」补上能力缺口`,
    undo: { type: 'removeInstalled', data: { ids: [id] } },
    meta: { resourceId: id, catalogId },
  });
  return { ok: true, resourceId: id };
}

function removeInstalled({ ids = [] }) {
  const m = rm();
  for (const id of ids) { try { m.deleteResource(id, {}); } catch { /* 已删 */ } }
  return { ok: true };
}

function register() {
  guardian.registerAction('installCatalogItem', installCatalogItem);
  guardian.registerAction('removeInstalled', removeInstalled);
  guardian.registerCheck('capability-gaps', check, 12 * 60 * 60 * 1000);
}

module.exports = { register, check, listOpen, findGaps, topicsOf, TOPICS, _internal: { installCatalogItem, removeInstalled, recentRequests } };
