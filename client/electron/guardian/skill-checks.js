// client/electron/guardian/skill-checks.js
// 资产体检（纯规则、离线）：质量体检、安全巡检、相似度。只读文件，不改资产。
// 被 diagnose（资产详情诊断）、asset-checks（定期体检）、resource:project（高风险投射确认）共用。
'use strict';

const fs = require('fs');
const path = require('path');

const MAX_FILES = 60;
const MAX_FILE_BYTES = 256 * 1024;
const TEXT_EXT = new Set(['', '.md', '.txt', '.sh', '.bash', '.zsh', '.py', '.js', '.mjs', '.cjs', '.ts', '.json', '.yaml', '.yml', '.toml', '.ps1', '.rb']);
// 超过这个长度，每次加载都要占不少上下文（约 6k token）
const LARGE_SKILL_CHARS = 24000;

/** 读技能目录下的文本文件（限量），返回 [{ rel, text }] */
function readSkillFiles(dir) {
  const out = [];
  const walk = (d, depth) => {
    if (out.length >= MAX_FILES || depth > 4) return;
    let names = [];
    try { names = fs.readdirSync(d); } catch { return; }
    for (const n of names) {
      if (out.length >= MAX_FILES) return;
      if (n === 'node_modules' || n === '.git') continue;
      const p = path.join(d, n);
      let st;
      try { st = fs.lstatSync(p); } catch { continue; }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) { walk(p, depth + 1); continue; }
      if (!TEXT_EXT.has(path.extname(n).toLowerCase()) || st.size > MAX_FILE_BYTES) continue;
      try { out.push({ rel: path.relative(dir, p), text: fs.readFileSync(p, 'utf8') }); } catch { /* ignore */ }
    }
  };
  if (dir && fs.existsSync(dir)) walk(dir, 0);
  return out;
}

function parseHeader(text) {
  const m = String(text || '').match(/^\s*---\s*\n([\s\S]*?)\n---/);
  if (!m) return null;
  const pick = (k) => {
    const mm = m[1].match(new RegExp(`^${k}\\s*:\\s*(.*)$`, 'm'));
    return mm ? mm[1].trim().replace(/^["']|["']$/g, '') : '';
  };
  return { name: pick('name'), description: pick('description') };
}

// 只说「帮忙 / 工具」这类没有具体场景的描述，应用很难判断何时调用
const GENERIC_DESC = /^(a |an |the )?(helper|tool|utility|skill|assistant|助手|工具|技能|帮助|辅助)\b/i;

/** 质量体检：返回 findings（level: warn | info） */
function qualityCheck(resource, files) {
  const findings = [];
  const md = files.find(f => /^skill\.md$/i.test(f.rel));
  if (!md) {
    findings.push({ level: 'warn', code: 'q-no-skill-md', text: '找不到 SKILL.md，应用无法识别这个技能。' });
    return findings;
  }
  const h = parseHeader(md.text);
  if (!h) {
    findings.push({ level: 'warn', code: 'q-no-header', text: 'SKILL.md 缺少开头的 name / description，应用可能不会加载它。', fix: { type: 'completeDescription', label: '补全描述' } });
    return findings;
  }
  const desc = h.description || '';
  if (!desc) {
    findings.push({ level: 'warn', code: 'q-no-description', text: '没有 description，应用不知道什么时候该用它。', fix: { type: 'completeDescription', label: '补全描述' } });
  } else if (desc.length < 15) {
    findings.push({ level: 'warn', code: 'q-short-description', text: `description 太短（「${desc}」），应用可能很少主动调用；写清它做什么、什么时候用。`, fix: { type: 'completeDescription', label: '补全描述' } });
  } else if (GENERIC_DESC.test(desc) && desc.length < 40) {
    findings.push({ level: 'info', code: 'q-generic-description', text: 'description 偏笼统，写上具体的使用场景（比如「审查 PR 时」）更容易被触发。', fix: { type: 'completeDescription', label: '改写描述' } });
  }
  if (h.name && resource && resource.name && h.name !== resource.name) {
    findings.push({ level: 'info', code: 'q-name-mismatch', text: `SKILL.md 里的 name（${h.name}）和目录名（${resource.name}）不一致，部分应用按目录名识别。` });
  }
  if (md.text.length > LARGE_SKILL_CHARS) {
    findings.push({ level: 'info', code: 'q-large', text: `SKILL.md 很长（约 ${Math.round(md.text.length / 1000)}k 字符），每次加载都占上下文；可以把细节拆到单独文件里按需读取。` });
  }
  return findings;
}

// ── 安全巡检 ────────────────────────────────────────────────────────────────
const SECURITY_RULES = [
  { level: 'high', code: 's-pipe-shell', text: '从网上下载脚本直接交给 shell 执行', re: /(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(ba|z)?sh\b/i },
  { level: 'high', code: 's-rm-root', text: '包含删除根目录或主目录的命令', re: /\brm\s+-[a-z]*r[a-z]*\s+(--no-preserve-root\s+)?(\/|~\/?|\$HOME\/?)(\*|\s|$)/im },
  { level: 'high', code: 's-encoded-exec', text: '解码一段隐藏内容后直接执行', re: /base64\s+(-d|--decode)[^\n]*\|\s*(ba|z)?sh|eval\s*\(\s*(atob|Buffer\.from)\(/i },
  { level: 'high', code: 's-exfil', text: '读取密钥或环境变量后发往外部地址', re: /(\.ssh\/id_|\.aws\/credentials|printenv|process\.env|os\.environ|\$\{?[A-Z_]*(KEY|TOKEN|SECRET)\}?)[\s\S]{0,200}(curl|wget|fetch\(|requests\.(post|get)|http\.request)/i },
  { level: 'warn', code: 's-secret-plain', text: '文件里有疑似明文密钥', re: /\b(sk-[A-Za-z0-9_-]{20,}|sk-ant-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{30,}|xox[bp]-[A-Za-z0-9-]{20,})\b/ },
  { level: 'warn', code: 's-cred-path', text: '会读取 SSH 密钥或云账号凭证文件', re: /~?\/?\.ssh\/id_[a-z0-9]+|\.aws\/credentials|\.config\/gcloud\/.*credentials/i },
  { level: 'warn', code: 's-sudo', text: '要求以 sudo / 管理员权限执行命令', re: /\bsudo\s+[a-z]/i },
];

/** 安全巡检：{ risk: 'none' | 'warn' | 'high', findings: [{ level, code, text, file, line }] } */
function securityScan(files) {
  const findings = [];
  for (const f of files) {
    for (const r of SECURITY_RULES) {
      const m = r.re.exec(f.text);
      if (!m) continue;
      if (findings.some(x => x.code === r.code && x.file === f.rel)) continue;
      const line = f.text.slice(0, m.index).split('\n').length;
      findings.push({ level: r.level, code: r.code, text: r.text, file: f.rel, line, snippet: m[0].slice(0, 120) });
    }
  }
  const risk = findings.some(x => x.level === 'high') ? 'high' : (findings.length ? 'warn' : 'none');
  return { risk, findings };
}

// ── 相似度（去重）──────────────────────────────────────────────────────────
function shingles(text) {
  const words = String(text || '').toLowerCase()
    .replace(/^\s*---[\s\S]*?\n---/, '')
    .match(/[a-z0-9]+|[一-鿿]/g) || [];
  const set = new Set();
  for (let i = 0; i + 2 < words.length; i++) set.add(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
  return set;
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  const [small, big] = a.size < b.size ? [a, b] : [b, a];
  for (const x of small) if (big.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

module.exports = { readSkillFiles, parseHeader, qualityCheck, securityScan, shingles, jaccard, SECURITY_RULES, LARGE_SKILL_CHARS };
