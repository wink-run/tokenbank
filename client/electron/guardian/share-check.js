// client/electron/guardian/share-check.js
// 分享前整理：把技能 / 提示词 / 智能体分享到社区之前，找出私人路径、密钥、邮箱、公司内网地址，
// 换成占位符。只返回结果，发不发、用哪一版由用户确认；看护永远不会自动对外发布。
'use strict';

const PUBLIC_MAIL = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'icloud.com', 'me.com', 'yahoo.com',
  'qq.com', 'foxmail.com', '163.com', '126.com', 'yeah.net', 'sina.com', 'proton.me', 'protonmail.com',
  // 代码托管和常见服务：出现在示例邮箱里不代表是公司
  'github.com', 'users.noreply.github.com', 'gitlab.com', 'bitbucket.org', 'anthropic.com', 'openai.com',
]);
const SAFE_MAIL_DOMAIN = /(^|\.)(example\.(com|org|net)|test|invalid|localhost)$/i;
const PLACEHOLDER_USERS = new Set(['user', 'username', 'you', 'yourname', 'me', 'xxx', 'name', 'runner', 'node', 'shared', 'public']);

const RULES = [
  {
    kind: 'path', label: '本机用户目录',
    re: /(\/Users\/|\/home\/)([A-Za-z0-9._-]+)(?=\/|\b)/g,
    keep: (m) => PLACEHOLDER_USERS.has(m[2].toLowerCase()),
    replace: () => '~',
  },
  {
    kind: 'path', label: '本机用户目录',
    re: /([A-Za-z]:\\Users\\)([A-Za-z0-9._ -]+?)(?=\\)/g,
    keep: (m) => PLACEHOLDER_USERS.has(m[2].toLowerCase()),
    replace: () => '%USERPROFILE%',
  },
  {
    kind: 'secret', label: '密钥',
    re: /\b(sk-ant-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|xox[bpas]-[A-Za-z0-9-]{20,}|AIza[0-9A-Za-z_-]{35})\b/g,
    replace: () => '<YOUR_API_KEY>',
  },
  {
    kind: 'secret', label: '密钥',
    re: /(Bearer\s+)([A-Za-z0-9._~+/-]{24,}=*)/g,
    keep: (m) => /^<|YOUR_|\$\{?[A-Z_]+/.test(m[2]),
    replace: (m) => `${m[1]}<YOUR_TOKEN>`,
  },
  {
    kind: 'secret', label: '密钥或密码',
    re: /\b((?:api[_-]?key|access[_-]?token|auth[_-]?token|secret|password|passwd)["']?\s*[:=]\s*["']?)([^\s"'`,;]{12,})/gi,
    keep: (m) => /^<|^\$|YOUR_|^\{\{|^process\.env|^os\.environ|^xxx+$/i.test(m[2]),
    replace: (m) => `${m[1]}<YOUR_SECRET>`,
  },
  {
    kind: 'email', label: '邮箱',
    re: /\b[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)\b/g,
    // user@10.0.0.1 是 ssh 地址不是邮箱，交给内网地址规则
    keep: (m) => SAFE_MAIL_DOMAIN.test(m[1]) || /^(noreply|no-reply)@/i.test(m[0]) || /^\d+(\.\d+){3}$/.test(m[1]),
    replace: () => '<your-email>',
  },
  {
    kind: 'internal', label: '内网地址',
    re: /\b(?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/g,
    replace: () => '<internal-ip>',
  },
  {
    kind: 'internal', label: '内网地址',
    re: /\b(?:[a-z0-9-]+\.)+(?:internal|corp|intranet|lan)\b/gi,
    replace: () => '<internal-host>',
  },
];

function mask(s) {
  const t = String(s);
  if (t.length <= 8) return `${t.slice(0, 2)}…`;
  return `${t.slice(0, 6)}…${t.slice(-2)}`;
}

/** 从邮箱推出公司域名（不是公共邮箱的），同域名的其它地址也算公司信息 */
function companyDomains(texts) {
  const out = new Set();
  const re = /\b[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)\b/g;
  for (const t of texts) {
    let m;
    while ((m = re.exec(String(t || '')))) {
      if (/^(noreply|no-reply)@/i.test(m[0])) continue;
      const d = m[1].toLowerCase();
      if (!PUBLIC_MAIL.has(d) && !SAFE_MAIL_DOMAIN.test(d)) out.add(d);
    }
  }
  return [...out];
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function cleanOne(text, rules, findings) {
  let out = String(text || '');
  for (const r of rules) {
    out = out.replace(r.re, (...args) => {
      const m = args.slice(0, -2); // [整段, 分组...]（规则里没有命名分组）
      if (r.keep && r.keep(m)) return m[0];
      const f = findings.find(x => x.kind === r.kind && x.label === r.label);
      if (f) { f.count++; if (f.samples.length < 3 && !f.samples.includes(mask(m[0]))) f.samples.push(mask(m[0])); } else findings.push({ kind: r.kind, label: r.label, count: 1, samples: [mask(m[0])] });
      return r.replace(m);
    });
  }
  return out;
}

/**
 * @param {{ content?: string, description?: string, displayName?: string }} input
 * @returns {{ findings: Array<{kind,label,count,samples}>, content: string, description: string, displayName: string, changed: boolean }}
 */
function sanitize({ content = '', description = '', displayName = '' } = {}) {
  const domains = companyDomains([content, description]);
  const rules = [
    ...RULES,
    ...domains.map(d => ({
      kind: 'company', label: '公司域名',
      re: new RegExp(`\\b(?:[a-z0-9-]+\\.)*${escapeRe(d)}\\b`, 'gi'),
      replace: () => '<company-domain>',
    })),
  ];
  const findings = [];
  const next = {
    content: cleanOne(content, rules, findings),
    description: cleanOne(description, rules, findings),
    displayName: cleanOne(displayName, rules, findings),
  };
  return { findings, ...next, changed: findings.length > 0 };
}

module.exports = { sanitize, companyDomains };
