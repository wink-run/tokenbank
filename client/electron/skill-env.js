'use strict';
// 技能要用的 Key / 配置（环境变量）：
//   1) 从技能目录里找出它要哪些变量：SKILL.md 头部声明的（requires.env / primaryEnv），
//      加上正文、参考文档、脚本里出现的 XXX_API_KEY / _TOKEN / _SECRET 之类
//   2) 值存在本机 ~/.tokenbank/skill-env.json，能加密就加密（Electron safeStorage），不写进技能文件，分享技能不会带出去
//   3) 不按应用逐个适配，用通用的三处（和 OpenClaw、dotenv、nvm/conda 这类主流做法一致）：
//      - Token Bank 跑智能体任务时，按技能声明把变量注入进程环境（OpenClaw 的做法）
//      - 技能目录里写一份 .env（只本人可读）：技能目录软链到各应用，脚本用 dotenv 之类直接读到；分享 / 同步不带它
//      - ~/.tokenbank/skill-env.sh，经用户同意在 shell 配置里加一行 source，终端里启动的任何应用都能读到
const fs = require('fs');
const os = require('os');
const path = require('path');

const NAME_RE = /^[A-Z][A-Z0-9_]{1,63}$/;
// 像 Key 的变量名：以这些结尾
const KEYISH = /(?:^|[^A-Za-z0-9_])([A-Z][A-Z0-9_]*(?:_API_KEY|_APIKEY|_KEY|_TOKEN|_SECRET|_SECRET_KEY|_ACCESS_KEY|_ACCESS_KEY_ID|_AK|_SK|_PASSWORD|_PASSWD))(?![A-Za-z0-9_])/g;
// 网关自己管的、系统的：不让技能配置覆盖
const RESERVED = /^(PATH|HOME|USER|SHELL|PWD|TMPDIR|ANTHROPIC_.*|OPENAI_BASE_URL|OPENAI_API_BASE|CODEX_.*|CLAUDE_.*|TOKENBANK_.*|CURSOR_.*|ELECTRON_.*|NODE_.*|GITHUB_TOKEN|GH_TOKEN|NPM_TOKEN)$/;
const SCAN_EXT = /\.(md|markdown|txt|sh|bash|zsh|py|js|mjs|cjs|ts|toml|ya?ml|json|env\.example)$/i;

function storeFile() { return path.join(os.homedir(), '.tokenbank', 'skill-env.json'); }
function shellFile() { return path.join(os.homedir(), '.tokenbank', 'skill-env.sh'); }

function safeStorage() {
  try {
    const { safeStorage: s } = require('electron');
    if (s && typeof s.isEncryptionAvailable === 'function' && s.isEncryptionAvailable()) return s;
  } catch { /* 命令行 / Docker 没有 electron */ }
  return null;
}

function encode(value) {
  const s = safeStorage();
  if (s) return `enc:${s.encryptString(String(value)).toString('base64')}`;
  return `plain:${Buffer.from(String(value), 'utf8').toString('base64')}`;
}

function decode(stored) {
  const v = String(stored || '');
  try {
    if (v.startsWith('enc:')) {
      const s = safeStorage();
      return s ? s.decryptString(Buffer.from(v.slice(4), 'base64')) : '';
    }
    if (v.startsWith('plain:')) return Buffer.from(v.slice(6), 'base64').toString('utf8');
  } catch { /* 解不开就当没配 */ }
  return '';
}

function readStore() {
  try {
    const data = JSON.parse(fs.readFileSync(storeFile(), 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch { return {}; }
}

function writeStore(data) {
  const f = storeFile();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(data, null, 2), { mode: 0o600 });
  try { fs.chmodSync(f, 0o600); } catch { /* Windows */ }
}

/** SKILL.md 头部声明的变量：openclaw 风格 {"requires":{"env":[...]}, "primaryEnv": "..."}，或 yaml 的 env: 列表 */
function declaredEnv(text) {
  const out = new Set();
  const src = String(text || '');
  const fm = src.startsWith('---') ? src.slice(0, Math.max(0, src.indexOf('\n---', 3)) + 4) : '';
  const head = fm || src.slice(0, 4000);
  for (const m of head.matchAll(/"env"\s*:\s*\[([^\]]*)\]/g)) {
    for (const n of m[1].matchAll(/"([A-Z][A-Z0-9_]+)"/g)) out.add(n[1]);
  }
  for (const m of head.matchAll(/"primaryEnv"\s*:\s*"([A-Z][A-Z0-9_]+)"/g)) out.add(m[1]);
  for (const m of head.matchAll(/^\s*(?:env|required_env|requires_env)\s*:\s*\n((?:\s*-\s*[A-Z][A-Z0-9_]+\s*\n?)+)/gm)) {
    for (const n of m[1].matchAll(/-\s*([A-Z][A-Z0-9_]+)/g)) out.add(n[1]);
  }
  for (const m of head.matchAll(/^\s*(?:env|required_env|requires_env)\s*:\s*\[([^\]]*)\]/gm)) {
    for (const n of m[1].matchAll(/([A-Z][A-Z0-9_]+)/g)) out.add(n[1]);
  }
  return [...out].filter(n => NAME_RE.test(n) && !RESERVED.test(n));
}

function mentionedEnv(text) {
  const out = new Set();
  for (const m of String(text || '').matchAll(KEYISH)) {
    if (NAME_RE.test(m[1]) && !RESERVED.test(m[1])) out.add(m[1]);
  }
  return [...out];
}

/** 技能目录里的文本文件（深度 3，最多 60 个、每个 200KB） */
function readSkillTexts(dir) {
  const texts = [];
  if (!dir) return texts;
  const walk = (d, depth) => {
    if (depth > 3 || texts.length >= 60) return;
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (texts.length >= 60) return;
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (SCAN_EXT.test(e.name)) {
        try { if (fs.statSync(p).size <= 200 * 1024) texts.push(fs.readFileSync(p, 'utf8')); } catch { /* ignore */ }
      }
    }
  };
  walk(dir, 0);
  return texts;
}

/** 这个技能要哪些变量：声明的在前（必填），文中出现的在后 */
function detectRequiredEnv({ content = '', dir = null } = {}) {
  const texts = [String(content || ''), ...readSkillTexts(dir)];
  const declared = new Set(texts.flatMap(declaredEnv));
  const mentioned = new Set(texts.flatMap(mentionedEnv));
  return [
    ...[...declared].map(name => ({ name, declared: true })),
    ...[...mentioned].filter(n => !declared.has(n)).map(name => ({ name, declared: false })),
  ];
}

function skillKey(resource) { return String(resource?.name || resource?.id || '').trim(); }

function maskValue(v) {
  const s = String(v || '');
  if (!s) return '';
  return s.length <= 6 ? '••••' : `••••${s.slice(-4)}`;
}

/** 详情面板用：要哪些变量、哪些配过（值只给打码后的） */
function describe(resource, dir) {
  const key = skillKey(resource);
  const saved = readStore()[key] || {};
  const detected = detectRequiredEnv({ content: resource?.content, dir });
  const names = new Set(detected.map(d => d.name));
  const vars = detected.map(d => ({ ...d, set: !!saved[d.name], preview: maskValue(decode(saved[d.name])) }));
  // 用户自己加的（技能里没写到的）
  for (const n of Object.keys(saved)) {
    if (!names.has(n)) vars.push({ name: n, declared: false, custom: true, set: true, preview: maskValue(decode(saved[n])) });
  }
  const missing = vars.filter(v => v.declared && !v.set).map(v => v.name);
  return { key, vars, missing, dotenv: dotenvState(dir), shellHooked: shellHookInstalled() };
}

/** 设一个值；value 为空就删掉。设完同步到 Claude Code 和 shell 文件 */
function setValue(resource, name, value, dir = null) {
  const n = String(name || '').trim();
  if (!NAME_RE.test(n)) throw new Error('变量名只能用大写字母、数字和下划线，且以字母开头');
  if (RESERVED.test(n)) throw new Error(`${n} 由 Token Bank 自己管理，不能在技能里配置`);
  const key = skillKey(resource);
  if (!key) throw new Error('没有这个技能');
  const data = readStore();
  data[key] = data[key] || {};
  if (value == null || String(value) === '') delete data[key][n];
  else data[key][n] = encode(String(value));
  if (!Object.keys(data[key]).length) delete data[key];
  writeStore(data);
  syncOutputs();
  return writeSkillDotenv(dir, skillVars(resource));
}

/** 所有技能配过的变量合在一起（同名以后配的为准） */
function allEnv() {
  const out = {};
  const data = readStore();
  for (const [k, vars] of Object.entries(data)) {
    if (k.startsWith('__') || !vars || typeof vars !== 'object') continue;
    for (const [n, stored] of Object.entries(vars)) {
      const v = decode(stored);
      if (v && NAME_RE.test(n) && !RESERVED.test(n)) out[n] = v;
    }
  }
  return out;
}

function shellQuote(v) { return `'${String(v).replace(/'/g, `'\\''`)}'`; }

/** 写 ~/.tokenbank/skill-env.sh 和 Claude Code settings.json 的 env（只动自己写过的键） */
function syncOutputs() {
  const env = allEnv();
  // 1) shell 文件
  try {
    const f = shellFile();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const lines = ['# Token Bank 生成：技能用到的 Key。在 ~/.zshrc 或 ~/.bashrc 里加一行 source ~/.tokenbank/skill-env.sh', ''];
    for (const [n, v] of Object.entries(env)) lines.push(`export ${n}=${shellQuote(v)}`);
    fs.writeFileSync(f, `${lines.join('\n')}\n`, { mode: 0o600 });
    try { fs.chmodSync(f, 0o600); } catch { /* Windows */ }
  } catch (e) { console.warn('[skill-env] 写 shell 文件失败:', e.message); }
  // 旧版本写进过 Claude Code settings.json 的键：清掉一次，以后不再按应用写
  try {
    const data = readStore();
    const before = Array.isArray(data.__claudeManaged) ? data.__claudeManaged : [];
    if (before.length) {
      const file = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'settings.json');
      try {
        const settings = JSON.parse(fs.readFileSync(file, 'utf8')) || {};
        if (settings.env) {
          for (const n of before) delete settings.env[n];
          fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
        }
      } catch { /* 没有这个文件就算了 */ }
    }
    if ('__claudeManaged' in data) { delete data.__claudeManaged; writeStore(data); }
  } catch { /* ignore */ }
}

const DOTENV_HEAD = '# Token Bank 管理：这个技能用到的 Key。在资产页改，别手动编辑';

/** 技能目录里的 .env：只写自己管的那份；目录里已有别人写的 .env 就不动，返回 foreign */
function writeSkillDotenv(dir, vars) {
  if (!dir) return 'nodir';
  const f = path.join(dir, '.env');
  let existing = null;
  try { existing = fs.readFileSync(f, 'utf8'); } catch { existing = null; }
  if (existing != null && !existing.startsWith(DOTENV_HEAD)) return 'foreign';
  const entries = Object.entries(vars || {});
  try {
    if (!entries.length) { if (existing != null) fs.unlinkSync(f); return 'none'; }
    const body = entries.map(([n, v]) => `${n}=${JSON.stringify(String(v))}`).join('\n');
    fs.writeFileSync(f, `${DOTENV_HEAD}\n${body}\n`, { mode: 0o600 });
    try { fs.chmodSync(f, 0o600); } catch { /* Windows */ }
    return 'written';
  } catch (e) {
    console.warn('[skill-env] 写技能 .env 失败:', e.message);
    return 'error';
  }
}

function skillVars(resource) {
  const saved = readStore()[skillKey(resource)] || {};
  const out = {};
  for (const [n, stored] of Object.entries(saved)) { const v = decode(stored); if (v) out[n] = v; }
  return out;
}

/** 技能目录 .env 现在的情况（给详情面板说明用） */
function dotenvState(dir) {
  if (!dir) return 'nodir';
  try {
    const txt = fs.readFileSync(path.join(dir, '.env'), 'utf8');
    return txt.startsWith(DOTENV_HEAD) ? 'written' : 'foreign';
  } catch { return 'none'; }
}

/** 技能目录有了（比如后来才启用到应用）、配过值、还没有 .env：补写一份 */
function ensureDotenv(resource, dir) {
  if (!dir || dotenvState(dir) !== 'none') return;
  const vars = skillVars(resource);
  if (Object.keys(vars).length) writeSkillDotenv(dir, vars);
}

// ── shell 配置里的一行 source（像 nvm / conda 安装时那样，用户点了才加）──
const HOOK_MARK = '# >>> Token Bank skill keys >>>';
function shellProfiles() {
  const home = os.homedir();
  const all = ['.zshrc', '.bashrc', '.bash_profile', '.profile'].map(n => path.join(home, n));
  const existing = all.filter(f => fs.existsSync(f));
  if (existing.length) return existing;
  return [path.join(home, process.env.SHELL && /zsh/.test(process.env.SHELL) ? '.zshrc' : '.bashrc')];
}
function shellHookInstalled() {
  return shellProfiles().some(f => { try { return fs.readFileSync(f, 'utf8').includes(HOOK_MARK); } catch { return false; } });
}
function installShellHook() {
  if (process.platform === 'win32') throw new Error('Windows 请在系统环境变量里设置，或在 PowerShell 配置里加载');
  const line = `${HOOK_MARK}\n[ -f "$HOME/.tokenbank/skill-env.sh" ] && . "$HOME/.tokenbank/skill-env.sh"\n# <<< Token Bank skill keys <<<\n`;
  const done = [];
  for (const f of shellProfiles()) {
    let txt = '';
    try { txt = fs.readFileSync(f, 'utf8'); } catch { txt = ''; }
    if (txt.includes(HOOK_MARK)) { done.push(f); continue; }
    fs.appendFileSync(f, `${txt && !txt.endsWith('\n') ? '\n' : ''}\n${line}`);
    done.push(f);
  }
  syncOutputs();
  return done;
}

module.exports = {
  detectRequiredEnv, declaredEnv, mentionedEnv, describe, setValue, allEnv, syncOutputs, shellFile, maskValue,
  writeSkillDotenv, installShellHook, shellHookInstalled, ensureDotenv,
};
