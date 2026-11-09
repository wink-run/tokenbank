/**
 * 自然语言创建智能体：用本地网关生成 name / 人设，并从候选 skill 中挑选绑定。
 */

/** 英文标识：小写 + 连字符 */
export function slugifyAssistantId(raw = '') {
  const s = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return s || `assistant-${Date.now().toString(36)}`;
}

/** 解析智能体编辑器正文 → soul / skills / 其它字段 */
export function parseAssistantEditorContent(content) {
  const text = String(content || '').trim();
  if (!text) {
    return { soul: '', skills: [], prompts: [], runtime_agent: '', parameters: null, extra: {} };
  }
  try {
    const obj = JSON.parse(text);
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      const {
        soul, system_prompt, systemPrompt, skills, prompts, runtime_agent, parameters, ...rest
      } = obj;
      return {
        soul: String(soul || system_prompt || systemPrompt || '').trim(),
        skills: Array.isArray(skills) ? skills.map(String).filter(Boolean) : [],
        prompts: Array.isArray(prompts) ? prompts.map(String).filter(Boolean) : [],
        runtime_agent: String(runtime_agent || '').trim(),
        parameters: parameters && typeof parameters === 'object' ? parameters : null,
        extra: rest || {},
      };
    }
  } catch { /* 纯文本 soul */ }
  return {
    soul: text,
    skills: [],
    prompts: [],
    runtime_agent: '',
    parameters: null,
    extra: {},
  };
}

/** soul + skills → 规范 JSON 正文 */
export function buildAssistantContent({
  soul = '',
  skills = [],
  prompts = [],
  runtime_agent = '',
  parameters = null,
  extra = {},
} = {}) {
  const payload = { ...(extra && typeof extra === 'object' ? extra : {}) };
  const s = String(soul || '').trim();
  if (s) payload.soul = s;
  const sk = [...new Set((skills || []).map(String).filter(Boolean))];
  if (sk.length) payload.skills = sk;
  const pr = [...new Set((prompts || []).map(String).filter(Boolean))];
  if (pr.length) payload.prompts = pr;
  if (runtime_agent) payload.runtime_agent = String(runtime_agent).trim();
  if (parameters && typeof parameters === 'object') payload.parameters = parameters;
  return JSON.stringify(payload, null, 2);
}

async function resolveGatewayBase() {
  let base = 'http://127.0.0.1:11430';
  if (!window.electronAPI?.gateway?.status) return base;
  try {
    const st = await window.electronAPI.gateway.status();
    const port = st?.port || st?.listenPort || st?.localPort;
    if (port) base = `http://127.0.0.1:${port}`;
    else if (st?.url || st?.baseUrl) base = String(st.url || st.baseUrl).replace(/\/$/, '');
  } catch { /* 默认口 */ }
  return base;
}

function extractJsonObject(text) {
  const raw = String(text || '');
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

/**
 * @param {string} brief 自然语言需求
 * @param {{ name: string, display_name?: string, description?: string }[]} skillCandidates
 * @param {{ name: string, display_name?: string, description?: string }[]} [promptCandidates]
 * @returns {Promise<{ name: string, display_name: string, description: string, soul: string, skills: string[], prompts: string[], tags: string[] }>}
 */
/** 按与需求的相关度给候选排序，避免超过上限时把相关的截掉 */
function rankByBrief(list, brief) {
  const q = String(brief || '').toLowerCase();
  const grams = new Set();
  for (let i = 0; i < q.length - 1; i++) grams.add(q.slice(i, i + 2));
  q.split(/[^a-z0-9]+/).filter((w) => w.length > 2).forEach((w) => grams.add(w));
  const score = (s) => {
    const hay = `${s.name || ''} ${s.display_name || ''} ${s.description || ''}`.toLowerCase();
    let n = 0;
    grams.forEach((g) => { if (hay.includes(g)) n += 1; });
    return n;
  };
  return [...(list || [])].map((s, i) => ({ s, i, k: score(s) }))
    .sort((a, b) => b.k - a.k || a.i - b.i)
    .map((x) => x.s);
}

/**
 * 一句话生成智能体。
 * @param communityCandidates 社区目录里还没纳管的技能 [{ catalogId, name, display_name, description, paid }]
 * @returns 额外返回 communitySkills（建议一起纳管的社区技能）和 missing（哪里都找不到的能力）
 */
export async function generateAssistantFromNl(brief, skillCandidates = [], promptCandidates = [], communityCandidates = []) {
  const text = String(brief || '').trim();
  if (text.length < 4) throw new Error('brief_too_short');
  if (!window.electronAPI?.llm?.fetch) throw new Error('llm_unavailable');

  const catalog = rankByBrief(skillCandidates, text).slice(0, 80).map((s) => ({
    name: s.name,
    title: s.display_name || s.name,
    desc: String(s.description || '').slice(0, 80),
  }));
  const skillNames = new Set(catalog.map((c) => c.name));
  const promptCatalog = (promptCandidates || []).slice(0, 80).map((s) => ({
    name: s.name,
    title: s.display_name || s.name,
    desc: String(s.description || '').slice(0, 80),
  }));
  const promptNames = new Set(promptCatalog.map((c) => c.name));
  const localNames = new Set((skillCandidates || []).map((s) => s.name));
  const community = rankByBrief(
    (communityCandidates || []).filter((c) => c && c.name && !localNames.has(c.name)),
    text,
  ).slice(0, 60);
  const communityCatalog = community.map((c) => ({
    name: c.name,
    title: c.display_name || c.name,
    desc: String(c.description || '').slice(0, 80),
  }));
  const communityByName = new Map(community.map((c) => [c.name, c]));

  const prompt = [
    '你是智能体设计师。根据用户需求生成一个可运行的 AI 智能体配置。',
    '只输出一个 JSON 对象，不要 markdown，不要解释。',
    '字段：',
    '- name: 短英文标识（小写字母/数字/连字符）',
    '- display_name: 中文显示名',
    '- description: 一句话简介（≤80字）',
    '- soul: 完整人设/系统提示（角色、职责、工作方式、输出风格；中文，≥80字）',
    '- skills: 从「本机 skills」中挑选 0～8 个真实 name（可空数组；禁止编造）',
    '- community_skills: 本机没有、但「社区 skills」里有且确实需要的，挑 0～5 个真实 name（禁止编造）',
    '- missing: 完成这类任务还需要、但本机和社区都没有的能力，用 0～3 个简短中文短语描述（如「读写 Excel」）',
    '- prompts: 从候选提示词中挑选 0～6 个真实 name（可空数组；禁止编造）',
    '- tags: 2～5 个英文小写标签',
    '',
    `用户需求：${text}`,
    '',
    `本机 skills（只能从 name 中选）：${JSON.stringify(catalog)}`,
    `社区 skills（本机未安装，只能从 name 中选）：${JSON.stringify(communityCatalog)}`,
    `候选 prompts（只能从 name 中选）：${JSON.stringify(promptCatalog)}`,
  ].join('\n');

  const base = await resolveGatewayBase();
  const res = await window.electronAPI.llm.fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'auto',
      temperature: 0.4,
      max_tokens: 1200,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res || res.status >= 400) {
    const detail = String(res?.body || '').slice(0, 200);
    throw new Error(detail || `llm_http_${res?.status || 0}`);
  }
  let data = {};
  try { data = JSON.parse(res.body || '{}'); } catch { data = {}; }
  const content = data?.choices?.[0]?.message?.content || data?.content || '';
  const parsed = extractJsonObject(content);
  if (!parsed) throw new Error('bad_llm_json');

  const name = slugifyAssistantId(parsed.name || parsed.display_name || text);
  const display_name = String(parsed.display_name || parsed.name || name).trim() || name;
  const description = String(parsed.description || '').trim().slice(0, 180);
  const soul = String(parsed.soul || parsed.system_prompt || '').trim();
  if (soul.length < 40) throw new Error('soul_too_short');

  const skills = (Array.isArray(parsed.skills) ? parsed.skills : [])
    .map(String)
    .filter((s) => skillNames.has(s));
  const prompts = (Array.isArray(parsed.prompts) ? parsed.prompts : [])
    .map(String)
    .filter((s) => promptNames.has(s));
  const tags = (Array.isArray(parsed.tags) ? parsed.tags : [])
    .map((t) => String(t || '').trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 8);

  const communitySkills = [...new Set((Array.isArray(parsed.community_skills) ? parsed.community_skills : []).map(String))]
    .map((n) => communityByName.get(n))
    .filter(Boolean)
    .slice(0, 5);
  const missing = (Array.isArray(parsed.missing) ? parsed.missing : [])
    .map((m) => String(m || '').trim())
    .filter((m) => m && m.length <= 30)
    .slice(0, 3);

  return { name, display_name, description, soul, skills, prompts, tags, communitySkills, missing };
}
