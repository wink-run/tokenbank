// client/electron/guardian/hire-guard.js
// 雇佣任务安全审查：别人下发到本机的任务，开工前审一遍，执行中每一步盯着，危险就不执行 / 立即终止。
//  - 只用规则，不调模型；规则放在内置技能里（~/.tokenbank/guardian/skills/hire-task-review/SKILL.md），用户能看能改
//  - 审查本身出问题（规则文件被改坏）→ 一律拦截
//  - 拦截后：给雇佣者一句通用的拒绝；写进看护日志；在对话里告诉用户；同一雇佣者一天被拦两次 → 自动拒接 7 天（可撤销）
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
  { id: 'secrets', label: '读取密钥和凭证', patterns: ['\\.ssh\\b', '\\bid_(?:rsa|ed25519|ecdsa)\\b', '\\.aws/credentials', '\\.gnupg\\b', 'gcloud/[^\\s]*credentials', '\\.tokenbank\\b', '\\.llm-agent\\b', '\\.(?:claude|codex)/[^\\s]*(?:auth|credential|token)', '\\bfind-generic-password\\b', 'Login Data|Cookies\\.sqlite|logins\\.json', '/etc/(?:passwd|shadow)\\b', '(?:^|[\\s;|&])(?:printenv|env)\\s*(?:$|[|>;])', '(?:浏览器|钥匙串).{0,8}(?:密码|登录数据|cookie)'] },
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
    'description: "Token Bank 看护用：别人下发到本机的雇佣任务开工前和执行中的安全审查规则。命中任一条就不执行。"',
    '---',
    '',
    '# 雇佣任务安全审查',
    '',
    '别人通过社区雇佣你的应用或智能体时，任务会在你的机器上执行。看护在开工前和执行中的每一步，按下面的规则审查任务文字、附带的文件和实际执行的命令，命中任一条就不执行或立即终止。',
    '',
    '你可以改下面这个规则块：增加一条让它更严，删掉一条会让别人的任务能做更多事。块里必须是合法的 JSON，写坏了看护会拒绝所有雇佣任务，直到修好。',
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

function scan(text, { rules, sandbox = hasSandbox() } = {}) {
  const s = String(text || '');
  if (!s) return [];
  const hits = [];
  for (const r of rules) {
    if (r.res.some(re => re.test(s))) hits.push({ id: r.id, label: r.label });
  }
  if (!sandbox && OUTSIDE_PATTERNS.some(p => new RegExp(p, 'i').test(s))) hits.push({ id: 'outside', label: '涉及工作目录之外的路径' });
  return hits;
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

function noteBlock({ consumer, hits, prompt, phase }) {
  const g = guardian();
  const day = new Date().toISOString().slice(0, 10);
  const log = store.readJson('hire-blocks.json', []);
  const entry = { at: Date.now(), day, consumer: consumer || '', hits: hits.map(h => h.id), phase, prompt: String(prompt || '').replace(/\s+/g, ' ').slice(0, 300) };
  store.writeJson('hire-blocks.json', [entry, ...(Array.isArray(log) ? log : [])].slice(0, 200));
  const todayCount = [entry, ...(Array.isArray(log) ? log : [])].filter(b => b.day === day && b.consumer === entry.consumer).length;
  const why = hits.map(h => h.label).join('、');
  const what = phase === 'running' ? '执行到一半被我终止了' : '我没让它执行';
  // 第二次：直接拒接一周，事后说一声
  if (consumer && todayCount >= REFUSE_AFTER && !refused()[consumer]) {
    const r = refuseHirer({ consumer, reason: why });
    g.record({
      category: 'install', kind: 'hirer-refused', status: 'done',
      title: `雇佣者 ${consumer} 今天第 ${todayCount} 次下发危险任务（${why}），我拒接了他 ${REFUSE_DAYS} 天`,
      signature: `hirer-refused|${consumer}`, undo: r.undo, meta: { consumer },
    });
    g.record({
      category: 'install', kind: 'hire-blocked', status: 'info', needsUser: true, noMute: false,
      title: '拦了雇佣任务',
      say: `雇佣者 ${consumer} 今天第 ${todayCount} 次下发危险任务（${why}），${what}。两次都不像误会，我已经拒接他 ${REFUSE_DAYS} 天。`,
      signature: `hire-blocked|${consumer}|${day}`,
      actions: [{ label: '撤销拒接', run: { type: 'allowHirer', data: { consumer } }, doneText: `好，不再拒接 ${consumer} 了。他的任务仍然要过安全审查。` }],
      meta: { consumer },
    });
    return;
  }
  g.record({
    category: 'install', kind: 'hire-blocked', status: 'info', needsUser: true,
    title: '拦了雇佣任务',
    say: `拦了 1 个雇佣任务${consumer ? `（雇佣者 ${consumer}）` : ''}：${why}，${what}。`,
    signature: `hire-blocked|${consumer}|${day}`,
    actions: consumer ? [{ label: `拒接他 ${REFUSE_DAYS} 天`, run: { type: 'refuseHirer', data: { consumer, reason: why } }, undo: { type: 'allowHirer', data: { consumer } } }] : [],
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
 * 看护关着也照审：这是安全边界，不随「看护」开关关闭。
 */
function screenTask({ prompt, files, consumer } = {}) {
  if (consumer && refused()[consumer]) return { ok: false, message: REJECT_MESSAGE, hits: [{ id: 'refused', label: '已拒接这个雇佣者' }], silent: true };
  const rules = loadRules();
  if (!rules) {
    noteBroken();
    return { ok: false, message: REJECT_MESSAGE, hits: [{ id: 'rules-broken', label: '审查规则文件损坏' }], silent: true };
  }
  const hits = scan(`${prompt || ''}\n${textOfFiles(files)}`, { rules });
  if (!hits.length) return { ok: true };
  try { noteBlock({ consumer, hits, prompt, phase: 'before' }); } catch (e) { console.warn('[guardian] hire block note:', e.message); }
  return { ok: false, message: REJECT_MESSAGE, hits };
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
function screenStep(step, { consumer, prompt } = {}) {
  if (!step || !['tool_call', 'tool_result'].includes(String(step.stepType || ''))) return null;
  if (String(step.stepType) === 'tool_result') return null;   // 只审它要做的事，不审输出
  const rules = loadRules();
  if (!rules) return [{ id: 'rules-broken', label: '审查规则文件损坏' }];
  let payload = '';
  try { payload = [step.tool_name, typeof step.content === 'string' ? step.content : JSON.stringify(step.content || ''), JSON.stringify(step.tool_input || step.input || step.args || '')].join('\n'); } catch { payload = String(step.content || ''); }
  const hits = scan(payload, { rules });
  if (!hits.length) return null;
  try { noteBlock({ consumer, hits, prompt, phase: 'running' }); } catch (e) { console.warn('[guardian] hire block note:', e.message); }
  return hits;
}

const SECRET_RE = /sk-[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z\-_]{20,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{30,}|xox[bp]-[A-Za-z0-9-]{20,}|-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/g;

/** 结果交回前：抹掉密钥；本机家目录路径换成 ~（工作目录内的相对部分保留） */
function redact(text, { workingDir } = {}) {
  let s = String(text == null ? '' : text);
  if (!s) return s;
  s = s.replace(SECRET_RE, '[已隐去]');
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
  loadRules();   // 第一次启动：把默认规则写成技能文件，用户能看到
}

module.exports = { register, screenTask, screenStep, redact, scan, loadRules, refuseHirer, allowHirer, hasSandbox, skillFile, REJECT_MESSAGE, DEFAULT_RULES, _internal: { compile, refused } };
