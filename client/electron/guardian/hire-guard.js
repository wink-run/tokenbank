// client/electron/guardian/hire-guard.js
// 雇佣任务安全审查：别人下发到本机的任务，开工前审一遍，执行中每一步盯着，危险就不执行 / 立即终止。
//  - 三层，先规矩后智能：① 规则（内置技能 ~/.tokenbank/guardian/skills/hire-task-review/SKILL.md，用户能看能改，加上用户教的规矩）
//    ② 本机装了 SkillSpector 就再静态扫一遍  ③ 前两层都没拦的，交给模型看一眼任务到底想干什么（智能兜底）
//    后两层只会加拦，不会放行规则拦下的；它们出错或超时不拦，按规则的结论走
//  - 审查本身出问题（规则文件被改坏）→ 一律拦截
//  - 拦截后：给雇佣者一句通用的拒绝；写进智能管家日志；在对话里告诉用户；同一雇佣者一天被拦两次 → 自动拒接 7 天（可撤销）
//  - 没有目录沙箱的系统（Windows / Linux 桌面）：凡涉及工作目录之外路径的一律拦截
//  - 结果交回前再抹一遍密钥和本机路径
// 只针对别人下发的任务；用户自己在游乐场跑的不审查。
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('./store');

const REJECT_MESSAGE = '任务被出租方的安全策略拒绝';
const REFUSE_DAYS = 7;
const REFUSE_AFTER = 2;   // 同一雇佣者一天内被拦这么多次就自动拒接

function guardian() {
  return require('./index');
}

function skillFile() {
  return path.join(store.dir(), 'skills', 'hire-task-review', 'SKILL.md');
}

// 默认规则：id、说明、正则（不区分大小写）。写进技能文件的 rules 代码块，用户可以增删
const DEFAULT_RULES = [
  { id: 'destroy', label: '破坏性命令', patterns: ['\\brm\\s+-[a-z]*r[a-z]*f?\\s+(?:--no-preserve-root\\s+)?(?:/|~|\\$HOME|\\.\\.)', '\\bmkfs\\b', '\\bdd\\s+[^\\n]*of=/dev/', '\\bformat\\s+[a-z]:', '\\bdel\\s+/[sq]\\b[^\\n]*[a-z]:\\\\', ':\\(\\)\\s*\\{\\s*:\\|:&\\s*\\}'] },
  // 这些词仍要拦。审查时还会按路径判断目录：落在本单工作目录里的不算，ssh 等本单用不到的目录算。
  { id: 'secrets', label: '读取密钥和凭证', patterns: ['\\.ssh\\b', '\\bid_(?:rsa|ed25519|ecdsa)\\b', '\\.aws/credentials', '\\.gnupg\\b', 'gcloud/[^\\s]*credentials', '\\.kube\\b', '\\.docker\\b', '\\.netrc\\b', '\\.git-credentials\\b', '\\.llm-agent\\b', '\\.(?:claude|codex)/[^\\s]*(?:auth|credential|token)', '\\bfind-generic-password\\b', 'Login Data|Cookies\\.sqlite|logins\\.json', '/etc/(?:passwd|shadow)\\b', '(?:^|[\\s;|&])(?:printenv|env)\\s*(?:$|[|>;])', '(?:浏览器|钥匙串).{0,8}(?:密码|登录数据|cookie)'] },
  { id: 'exfil', label: '把本机文件往外传', patterns: ['\\bcurl\\b[^\\n]*(?:-d\\s*@|--data(?:-binary)?\\s*@|-F\\s*[^\\s]*=@|--upload-file|-T\\s)', '\\bwget\\b[^\\n]*--post-file', '\\b(?:scp|rsync)\\b[^\\n]*\\s[\\w.-]+@[\\w.-]+:', '\\bnc\\s+[\\w.-]+\\s+\\d+', 'base64[^\\n]*\\|\\s*(?:curl|nc|wget)'] },
  { id: 'download-exec', label: '下载后直接执行', patterns: ['\\b(?:curl|wget)\\b[^\\n|]*\\|\\s*(?:sudo\\s+)?(?:ba|z)?sh\\b', '\\biex\\s*\\(\\s*(?:iwr|irm|invoke-webrequest)', 'powershell[^\\n]*-enc(?:odedcommand)?\\b', 'base64\\s+(?:-d|--decode)[^\\n]*\\|\\s*(?:ba|z)?sh'] },
  { id: 'persist', label: '留后门', patterns: ['\\bcrontab\\b', '\\blaunchctl\\b', 'LaunchAgents|LaunchDaemons', '\\bsystemctl\\s+enable\\b', '\\.(?:bashrc|zshrc|bash_profile|profile)\\b', '\\bschtasks\\b', 'CurrentVersion\\\\Run', 'authorized_keys'] },
  { id: 'privilege', label: '提权', patterns: ['\\bsudo\\s+\\S', '\\bsu\\s+-', '\\bchmod\\s+[ug]?\\+s\\b', '\\bchown\\s+root\\b', '\\bsetuid\\b'] },
  { id: 'attack', label: '扫描、攻击或挖矿', patterns: ['\\b(?:nmap|masscan|hydra|sqlmap|metasploit|msfconsole)\\b', '\\b(?:xmrig|minerd|cpuminer)\\b', 'stratum\\+tcp', '\\bddos\\b'] },
  { id: 'jailbreak', label: '要求绕过限制', patterns: ['ignore\\s+(?:all\\s+)?(?:previous|prior|above)\\s+(?:instructions|rules)', '忽略.{0,6}(?:之前|以上|所有|前面).{0,6}(?:指令|限制|规则|要求)', 'disable\\s+(?:the\\s+)?sandbox', '关闭.{0,4}沙箱', '不要.{0,4}(?:告诉|通知|让).{0,6}(?:用户|主人|出租方)', 'dangerously-?skip'] },
];

// 没有目录沙箱时额外用：任务里出现工作目录之外的路径
const OUTSIDE_PATTERNS = ['(?:^|[\\s"\'`=(])~/', '(?:^|[\\s"\'`=(])/(?:Users|home|root|etc|var|opt|usr|private|Library|mnt|Volumes)/', '\\b[a-z]:\\\\(?:Users|Windows|Program)', '\\.\\./\\.\\.', '\\$HOME\\b|%USERPROFILE%|%APPDATA%'];

function skillText(rules) {
  return [
    '---',
    'name: hire-task-review',
    'description: "Token Bank 智能管家用：别人下发到本机的雇佣任务开工前和执行中的安全审查规则。命中任一条就不执行。"',
    '---',
    '',
    '# 雇佣任务安全审查',
    '',
    '别人通过社区雇佣你的应用或智能体时，任务会在你的机器上执行。智能管家在开工前和执行中的每一步，按下面的规则审查任务文字、附带的文件和实际执行的命令，命中任一条就不执行或立即终止。',
    '',
    '你可以改下面这个规则块：增加一条让它更严，删掉一条会让别人的任务能做更多事。块里必须是合法的 JSON，写坏了智能管家会拒绝所有雇佣任务，直到修好。',
    '',
    '```rules',
    JSON.stringify(rules, null, 2),
    '```',
    '',
  ].join('\n');
}

/** 读规则；文件不存在就写一份默认的；存在但坏了 → 返回 null（调用方一律拦截） */
function loadRules() {
  const file = skillFile();
  let text = null;
  try { text = fs.readFileSync(file, 'utf8'); } catch { /* 第一次 */ }
  if (text == null) {
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, skillText(DEFAULT_RULES)); } catch { /* 写不了就用内置的 */ }
    return compile(DEFAULT_RULES);
  }
  const m = text.match(/```rules\s*\n([\s\S]*?)\n```/);
  if (!m) return null;
  try { return compile(JSON.parse(m[1])); } catch { return null; }
}

function compile(rules) {
  if (!Array.isArray(rules)) throw new Error('rules must be a list');
  return rules.map((r) => ({
    id: String(r.id), label: String(r.label || r.id),
    res: (r.patterns || []).map(p => new RegExp(String(p), 'i')),
  }));
}

/** 这台机器上雇佣任务有没有目录沙箱（现在只有 macOS 有） */
function hasSandbox() {
  return process.platform === 'darwin';
}

// 命令和任务文字里的路径。用来判断碰的是哪一个目录，而不是只看有没有敏感词。
const PATH_RE = /(?:~\/|\$HOME\/|%USERPROFILE%(?:\\|\/)|%APPDATA%(?:\\|\/)|[A-Za-z]:[\\/]|\.\.?\/|\/(?!\/))[^\s'"`<>|*?;|&]+|\.(?:ssh|aws|gnupg|kube|docker|tokenbank|llm-agent|netrc|git-credentials)\b(?:[/\\][^\s'"`<>|*?;|&]*)?/gi;

// 和本单无关的凭证目录。出现在路径的某一段里就拒绝；本单工作目录里的同名文件夹不算。
// .tokenbank 是任务自己的目录，不在这里。ssh 这类和本单无关的目录才拒绝。
const SECRET_DIR_SEGMENTS = new Set(['.ssh', '.aws', '.gnupg', '.kube', '.docker', '.llm-agent', '.netrc', '.git-credentials']);

function resolveMention(raw, workingDir) {
  let s = String(raw || '').replace(/[),.;:]+$/g, '');
  if (s === '~' || s.startsWith('~/')) s = path.join(os.homedir(), s.slice(2));
  else if (/^\$HOME\b/i.test(s)) s = path.join(os.homedir(), s.replace(/^\$HOME\/?/i, ''));
  else if (/^%USERPROFILE%/i.test(s)) s = path.join(os.homedir(), s.replace(/^%USERPROFILE%[/\\]?/i, ''));
  else if (/^%APPDATA%/i.test(s)) s = path.join(os.homedir(), 'AppData', 'Roaming', s.replace(/^%APPDATA%[/\\]?/i, ''));
  if (!path.isAbsolute(s)) s = path.resolve(workingDir || '', s);
  return path.normalize(s);
}

function isInside(child, root) {
  if (!root) return false;
  const rel = path.relative(path.resolve(root), child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function eachPath(text, visit) {
  const re = new RegExp(PATH_RE.source, 'gi');
  let m;
  while ((m = re.exec(text))) visit(m[0]);
}

// 本单工作目录里的路径拿掉，剩下的才拿密钥规则去对。目录在任务里面就不算读了别的凭证。
function stripTaskPaths(text, workingDir) {
  if (!workingDir) return text;
  const root = path.resolve(workingDir);
  return text.replace(new RegExp(PATH_RE.source, 'gi'), (raw) => (isInside(resolveMention(raw, workingDir), root) ? ' ' : raw));
}

// 路径落到 ssh 这类本单用不到的目录上就拒绝。.tokenbank 不拒绝。工作目录自身也放行。
function secretDirectoryOutside(text, workingDir) {
  const root = workingDir ? path.resolve(workingDir) : '';
  let hit = false;
  eachPath(text, (raw) => {
    if (hit) return;
    const abs = resolveMention(raw, workingDir);
    if (root && isInside(abs, root)) return;
    const parts = abs.split(/[/\\]/).map((seg) => seg.toLowerCase());
    if (parts.some((seg) => SECRET_DIR_SEGMENTS.has(seg))) { hit = true; return; }
    if (parts.includes('gcloud') && /credential/i.test(abs)) { hit = true; return; }
    if (/^(?:etc[/\\])?(?:passwd|shadow)$/i.test(parts.slice(-2).join('/'))) hit = true;
  });
  return hit;
}

function scan(text, { rules, sandbox = hasSandbox(), workingDir } = {}) {
  const s = String(text || '');
  if (!s) return [];
  const hits = [];
  // 密钥规则看的是拿掉本单目录之后的文字，避免工作目录路径里的字样被当成读凭证
  const outsideText = stripTaskPaths(s, workingDir);
  for (const r of rules) {
    const source = r.id === 'secrets' ? outsideText : s;
    if (r.id === 'secrets' ? secretsRuleHits(r, source) : r.res.some(re => re.test(source))) {
      hits.push({ id: r.id, label: r.label });
    }
  }
  if (secretDirectoryOutside(s, workingDir) && !hits.some(h => h.id === 'secrets')) {
    hits.push({ id: 'secrets', label: '读取密钥和凭证' });
  }
  if (!sandbox && OUTSIDE_PATTERNS.some(p => new RegExp(p, 'i').test(s))) hits.push({ id: 'outside', label: '涉及工作目录之外的路径' });
  return hits;
}

// 只命中「把环境变量倒出来」，但命令只留下变量名、或把值换成占位，就不算读取密钥。
function hidesEnvValues(source) {
  if (/(?:sed|awk)\b[^|\n]*s\/=/.test(source)) return true;
  // cut -d= -f1，两种参数顺序都认。等号和 -f 之间可以有空格。
  if (/\bcut\b[^|\n;]*-d\s*['"]?= ['"]?\s*-f\s*1\b/.test(source)) return true;
  if (/\bcut\b[^|\n;]*-f\s*1\b[^|\n;]*-d\s*['"]?=['"]?/.test(source)) return true;
  if (/\bawk\b[^|\n;]*-F\s*['"]?= ['"]?[^|\n;]*\$1/.test(source)) return true;
  return false;
}

function secretsRuleHits(rule, source) {
  const matched = rule.res.filter((re) => re.test(source));
  if (!matched.length) return false;
  const onlyEnvDump = matched.every((re) => /printenv\|env/.test(re.source));
  if (onlyEnvDump && hidesEnvValues(source)) return false;
  return true;
}

function userRule({ consumer, text, hits }) {
  try {
    return require('./rules').decide('hire-task', { consumer: consumer || '', text: String(text || '').slice(0, 20000), hits: (hits || []).map(h => h.id).join(',') });
  } catch { return null; }
}

function refused() {
  const r = store.readJson('hire-refused.json', {});
  const now = Date.now();
  let changed = false;
  for (const k of Object.keys(r)) if (!(r[k].until > now)) { delete r[k]; changed = true; }
  if (changed) store.writeJson('hire-refused.json', r);
  return r;
}

function refuseHirer({ consumer, days = REFUSE_DAYS, reason = '' }) {
  if (!consumer) return { ok: false, error: '没有雇佣者' };
  const r = refused();
  r[consumer] = { until: Date.now() + days * 24 * 60 * 60 * 1000, reason };
  store.writeJson('hire-refused.json', r);
  const until = new Date(r[consumer].until);
  return { ok: true, message: `已经拒接 ${consumer} 到 ${until.getMonth() + 1} 月 ${until.getDate()} 日。`, undo: { type: 'allowHirer', data: { consumer } } };
}

function allowHirer({ consumer }) {
  const r = refused();
  delete r[consumer];
  store.writeJson('hire-refused.json', r);
  return { ok: true };
}

function clipText(s, n = 180) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  if (t.length <= n) return t;
  return `${t.slice(0, n)}…`;
}

// 对话被压成一段时，取出雇佣者真正要做的那一句，不把前面的助手回复当成任务。
function taskQuote(prompt) {
  const raw = String(prompt || '').trim();
  const users = [...raw.matchAll(/(?:^|\n)\s*(?:User|用户)\s*[:：]\s*([\s\S]*?)(?=\n\s*(?:Assistant|User|用户)\s*[:：]|$)/gi)];
  const last = users.length ? users[users.length - 1][1] : raw;
  return clipText(last, 200);
}

function speakerName(prompt) {
  const re = /(?:^|\n)\s*([^\n:：]{1,32})\s*[:：]\s+\S/g;
  let m;
  while ((m = re.exec(String(prompt || '')))) {
    const name = m[1].trim();
    if (/^(user|assistant|conversation so far)$/i.test(name)) continue;
    return name;
  }
  return '';
}

function whoLine({ consumer, name, prompt }) {
  const nick = String(name || '').trim() || speakerName(prompt);
  const id = String(consumer || '').trim();
  if (nick && id && nick !== id) return `${nick}（编号 ${id}）`;
  if (nick) return nick;
  if (id) return `编号 ${id}`;
  return '没有留下名字';
}

function commandOf(step) {
  if (!step) return '';
  let cmd = '';
  const input = step.tool_input || step.input || step.args;
  if (input && typeof input === 'object') cmd = input.command || input.cmd || '';
  if (!cmd && step.content && typeof step.content === 'object') {
    cmd = step.content.command || step.content.cmd || '';
  }
  if (!cmd && typeof step.content === 'string') {
    try {
      const parsed = JSON.parse(step.content);
      cmd = parsed.command || parsed.cmd || parsed.prompt || '';
    } catch { cmd = step.content; }
  }
  const tool = String(step.tool_name || '').trim();
  const body = clipText(redact(cmd), 300);
  if (tool && body) return `${tool}：${body}`;
  return body || tool;
}

function noteBlock({ consumer, name, agent, taskId, hits, prompt, phase, detail, judged = null }) {
  const g = guardian();
  const day = new Date().toISOString().slice(0, 10);
  const log = store.readJson('hire-blocks.json', []);
  const task = taskQuote(prompt);
  const who = whoLine({ consumer, name, prompt });
  const entry = {
    at: Date.now(), day, consumer: consumer || '', name: String(name || '').trim(),
    agent: String(agent || '').trim(), hits: hits.map(h => h.id), phase,
    prompt: task, detail: clipText(detail, 300),
  };
  store.writeJson('hire-blocks.json', [entry, ...(Array.isArray(log) ? log : [])].slice(0, 200));
  // 自动拒接只数规则和扫描拦下的；模型判断拦的可能看错，不拿来给人定性
  const firm = (b) => !(b.hits.length === 1 && b.hits[0] === 'judge');
  const today = firm(entry) ? [entry, ...(Array.isArray(log) ? log : [])].filter(b => b.day === day && b.consumer === entry.consumer && firm(b)) : [];
  const todayCount = today.length;
  const why = hits.map(h => h.label).join('、');
  const where = String(agent || '').trim() ? `交给「${String(agent).trim()}」` : '下发';
  const doing = phase === 'running'
    ? `执行到一半被停掉${detail ? `。当时要跑的是 ${detail}` : ''}`
    : '还没开始就被拦住';
  const idLine = taskId ? `\n任务号：${taskId}` : '';
  const thisOne = `${who}${where}的任务是：「${task || '（没有任务原文）'}」。${doing}。命中的规则：${why}。${idLine}`;
  // 第二次：直接拒接一周，把今天每次的任务都写上
  if (consumer && todayCount >= REFUSE_AFTER && !refused()[consumer]) {
    const r = refuseHirer({ consumer, reason: why });
    const until = new Date(refused()[consumer].until);
    const untilText = `${until.getMonth() + 1} 月 ${until.getDate()} 日`;
    const earlier = today.slice(1).map((b, i) => {
      const line = `${i + 1}. 「${b.prompt || '（没有任务原文）'}」`;
      return b.detail ? `${line}，做到 ${b.detail}` : line;
    });
    const history = earlier.length ? `今天前面被拦住的是：\n${earlier.join('\n')}\n` : '';
    g.record({
      category: 'install', kind: 'hirer-refused', status: 'done',
      title: `${who}今天第 ${todayCount} 次被拦住（${why}），已拒接到 ${untilText}`,
      signature: `hirer-refused|${consumer}`, undo: r.undo, meta: { consumer },
    });
    g.record({
      category: 'install', kind: 'hire-blocked', status: 'info', needsUser: true, noMute: false,
      title: `拦住了 ${who} 的任务`,
      say: `${thisOne}\n这是今天第 ${todayCount} 次。\n${history}已经拒接到 ${untilText}。`,
      signature: `hire-blocked|${consumer}|${day}`,
      actions: [{ label: '撤销拒接', run: { type: 'allowHirer', data: { consumer } }, doneText: `好，不再拒接 ${who} 了。他的任务仍然要过安全审查。` }],
      meta: { consumer },
    });
    return;
  }
  g.record({
    category: 'install', kind: 'hire-blocked', status: 'info', needsUser: true,
    title: `拦住了 ${who} 的任务`,
    say: thisOne,
    signature: judged ? `hire-blocked|${consumer}|${day}|judge|${judged.key}` : `hire-blocked|${consumer}|${day}|${entry.at}`,
    actions: [
      ...(judged ? [{ label: '拦错了，这类可以做', run: { type: 'hireJudgeWrong', data: judged }, doneText: '记下了，以后这类任务我不拦。命中安全规则的照样会拦。' }] : []),
      ...(consumer ? [{ label: `拒接他 ${REFUSE_DAYS} 天`, run: { type: 'refuseHirer', data: { consumer, reason: why } }, undo: { type: 'allowHirer', data: { consumer } } }] : []),
    ],
    meta: { consumer },
  });
}

function textOfFiles(files) {
  const out = [];
  for (const f of Array.isArray(files) ? files : []) {
    out.push(String(f?.name || ''));
    const data = String(f?.data || f?.url || '');
    // 文本类附件（data URL）解出来一起审；二进制只看文件名
    const m = data.match(/^data:(text\/[^;,]*|application\/(?:json|x-sh|javascript|x-yaml))[^,]*;base64,(.*)$/i);
    if (m) { try { out.push(Buffer.from(m[2], 'base64').toString('utf8').slice(0, 200000)); } catch { /* ignore */ } }
  }
  return out.join('\n');
}

/**
 * 开工前审查。返回 { ok: true } 或 { ok: false, message, hits }。
 * 智能管家关着也照审：这是安全边界，不随「智能管家」开关关闭。
 */
function screenTask({ prompt, files, consumer, workingDir, name, agent, taskId } = {}) {
  if (consumer && refused()[consumer]) return { ok: false, message: REJECT_MESSAGE, hits: [{ id: 'refused', label: '已拒接这个雇佣者' }], silent: true };
  const rules = loadRules();
  if (!rules) {
    noteBroken();
    return { ok: false, message: REJECT_MESSAGE, hits: [{ id: 'rules-broken', label: '审查规则文件损坏' }], silent: true };
  }
  const text = `${prompt || ''}\n${textOfFiles(files)}`;
  let hits = scan(text, { rules, workingDir });
  // 用户教的规矩：多拦一类（block / refuse），或亲口确认过的放行（allow）
  const d = userRule({ consumer, text, hits });
  if (d && d.action === 'allow') return { ok: true, allowedBy: d.rule.id };
  if (d && (d.action === 'block' || d.action === 'refuse')) {
    hits = [...hits, { id: 'user-rule', label: `你定的规矩（${d.rule.reason}）` }];
    if (d.action === 'refuse' && consumer) refuseHirer({ consumer, reason: d.rule.reason });
  }
  if (!hits.length) return { ok: true };
  try { noteBlock({ consumer, name, agent, taskId, hits, prompt, phase: 'before' }); } catch (e) { console.warn('[guardian] hire block note:', e.message); }
  return { ok: false, message: REJECT_MESSAGE, hits };
}

function attachmentsOf(files) {
  const out = [];
  for (const f of Array.isArray(files) ? files : []) {
    const data = String(f?.data || f?.url || '');
    const m = data.match(/^data:(text\/[^;,]*|application\/(?:json|x-sh|javascript|x-yaml|x-python))[^,]*;base64,(.*)$/i);
    if (m) { try { out.push({ name: String(f?.name || ''), text: Buffer.from(m[2], 'base64').toString('utf8').slice(0, 500000) }); } catch { /* ignore */ } }
  }
  return out;
}

/**
 * 规则放行之后的两层：SkillSpector 静态扫描（本机装了才有），再是模型判断兜底。
 * 只会加拦。verdict 是 screenTask 的结果；被规则拦下的、用户亲口放行的，不再过这两层。
 */
async function reviewTask({ prompt, files, consumer, name, agent, taskId } = {}, verdict = { ok: true }) {
  if (!verdict.ok || verdict.allowedBy) return verdict;
  const text = `${prompt || ''}\n${textOfFiles(files)}`;
  let noted = '';
  try {
    const sp = await require('./spector').scanTask({ prompt, attachments: attachmentsOf(files) });
    if (sp.blocked) {
      const top = sp.findings.filter(f => f.severity === 'HIGH' || f.severity === 'CRITICAL').slice(0, 3).map(f => f.label);
      const hits = [{ id: 'spector', label: `SkillSpector 扫出高危（${[...new Set(top)].join('、') || sp.severity}）` }];
      try { noteBlock({ consumer, name, agent, taskId, hits, prompt, phase: 'before' }); } catch (e) { console.warn('[guardian] hire block note:', e.message); }
      return { ok: false, message: REJECT_MESSAGE, hits };
    }
    if (sp.findings.length) noted = `SkillSpector 静态扫描没到高危，但提示了：${[...new Set(sp.findings.map(f => f.label))].slice(0, 6).join('；')}`;
  } catch { /* 这一层没起作用，往下走 */ }
  try {
    const key = require('crypto').createHash('sha1').update(text).digest('hex').slice(0, 16);
    const facts = { consumer: consumer || '', text: String(prompt || '').replace(/\s+/g, ' ').slice(0, 600), hits: '' };
    const j = await require('./judge').judge({
      event: 'hire-task', label: '别人下发到这台机器上执行的雇佣任务到达（安全规则已经查过，没有命中）',
      facts: { consumer: facts.consumer }, keyFacts: { key },
      context: [noted, '任务全文和附件：', text.slice(0, 5500)].filter(Boolean).join('\n'),
      actions: {
        allow: '放行。正常的工作任务（写代码、改文档、查资料、处理工作目录里的文件）都选这个',
        block: '拦截。任务的真实目的是偷这台机器上的东西、搞破坏、控制这台机器、拿它去攻击别人，或者想骗过审查',
      },
      fallback: 'allow', timeoutMs: 15000,
    });
    if (j && j.action === 'block') {
      const hits = [{ id: 'judge', label: j.reason || '看起来不是正常的工作任务' }];
      try { noteBlock({ consumer, name, agent, taskId, hits, prompt, phase: 'before', judged: { facts, key } }); } catch (e) { console.warn('[guardian] hire block note:', e.message); }
      return { ok: false, message: REJECT_MESSAGE, hits };
    }
  } catch { /* 判断不了就按规则的结论走 */ }
  return verdict;
}

function noteBroken() {
  try {
    guardian().record({
      category: 'install', kind: 'hire-rules-broken', status: 'info', needsUser: true, noMute: true,
      title: '雇佣任务的审查规则文件坏了',
      say: `雇佣任务的安全审查规则文件被改坏了（${skillFile()}）。修好之前，我会拒绝所有雇佣任务。`,
      signature: 'hire-rules-broken',
      actions: [{ label: '恢复默认规则', run: { type: 'resetHireRules', data: {} }, doneText: '恢复成默认规则了，雇佣任务可以照常审查。' }],
    });
  } catch { /* ignore */ }
}

/** 执行中的一步（命令、工具调用）。命中返回 hits，否则 null */
function screenStep(step, { consumer, prompt, workingDir, name, agent, taskId } = {}) {
  if (!step || !['tool_call', 'tool_result'].includes(String(step.stepType || ''))) return null;
  if (String(step.stepType) === 'tool_result') return null;   // 只审它要做的事，不审输出
  const rules = loadRules();
  if (!rules) return [{ id: 'rules-broken', label: '审查规则文件损坏' }];
  let payload = '';
  try { payload = [step.tool_name, typeof step.content === 'string' ? step.content : JSON.stringify(step.content || ''), JSON.stringify(step.tool_input || step.input || step.args || '')].join('\n'); } catch { payload = String(step.content || ''); }
  let hits = scan(payload, { rules, workingDir });
  const d = userRule({ consumer, text: payload, hits });
  if (d && d.action === 'allow') return null;
  if (d && (d.action === 'block' || d.action === 'refuse')) hits = [...hits, { id: 'user-rule', label: `你定的规矩（${d.rule.reason}）` }];
  if (!hits.length) return null;
  try { noteBlock({ consumer, name, agent, taskId, hits, prompt, phase: 'running', detail: commandOf(step) }); } catch (e) { console.warn('[guardian] hire block note:', e.message); }
  return hits;
}

const SECRET_RE = /sk-[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z\-_]{20,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{30,}|xox[bp]-[A-Za-z0-9-]{20,}|-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/g;
// 环境变量和配置里的密钥可以在本机用，交回给雇佣者时只留名字
const ASSIGNED_SECRET_RE = /\b([A-Za-z0-9_]*(?:key|token|secret|password|credential)[A-Za-z0-9_]*)(\s*[=:]\s*)(?:"[^"\n]*"|'[^'\n]*'|\S+)/gi;

/** 结果交回前：抹掉密钥；本机家目录路径换成 ~（工作目录内的相对部分保留） */
function redact(text, { workingDir } = {}) {
  let s = String(text == null ? '' : text);
  if (!s) return s;
  s = s.replace(SECRET_RE, '[已隐去]');
  s = s.replace(ASSIGNED_SECRET_RE, '$1$2[已隐去]');
  s = s.replace(/\bBearer\s+\S+/gi, 'Bearer [已隐去]');
  if (workingDir) s = s.split(workingDir).join('.');
  const home = os.homedir();
  if (home && home.length > 3) s = s.split(home).join('~');
  return s;
}

function register() {
  const g = guardian();
  g.registerAction('refuseHirer', refuseHirer);
  g.registerAction('allowHirer', allowHirer);
  g.registerAction('resetHireRules', () => {
    fs.mkdirSync(path.dirname(skillFile()), { recursive: true });
    fs.writeFileSync(skillFile(), skillText(DEFAULT_RULES));
    return { ok: true };
  });
  // 用户说模型判断拦错了：记成案例（以后同类不拦），并清掉这次判断的缓存
  g.registerAction('hireJudgeWrong', ({ facts, key }) => {
    require('./rules').addCase({ event: 'hire-task', facts, expect: 'allow', note: '用户说这类任务可以做，模型判断拦错了' });
    require('./judge').forget('hire-task', { key });
    return { ok: true };
  });
  loadRules();   // 第一次启动：把默认规则写成技能文件，用户能看到
}

module.exports = { register, screenTask, reviewTask, screenStep, redact, scan, loadRules, refuseHirer, allowHirer, hasSandbox, skillFile, REJECT_MESSAGE, DEFAULT_RULES, _internal: { compile, refused } };
