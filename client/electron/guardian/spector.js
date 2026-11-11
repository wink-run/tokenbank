// client/electron/guardian/spector.js
// 用 NVIDIA SkillSpector（https://github.com/NVIDIA/SkillSpector，Apache-2.0）给雇佣任务多扫一遍。
//  - 它是用户自己装的命令行工具（Python）。本机有就用，没有就跳过；Token Bank 不自带、不偷偷安装
//  - 只跑静态扫描（--no-llm）：不联网问模型、不花 token，约 3 秒
//  - 把任务文字和文本附件写进一个临时目录当成「技能」来扫；只读扫描，不执行里面任何东西
//  - 最高严重度到 HIGH / CRITICAL 就拦；工具出错或超时不拦（内置规则已经查过），只是这一层没起作用
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const TIMEOUT_MS = 25000;
let found = { at: 0, bin: null };

function candidates() {
  const exe = process.platform === 'win32' ? 'skillspector.exe' : 'skillspector';
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  dirs.push(path.join(os.homedir(), '.local', 'bin'), path.join(os.homedir(), '.tokenbank', 'tools', 'skillspector', 'bin'));
  return dirs.map(d => path.join(d, exe));
}

/** 本机有没有 SkillSpector（结果记 1 分钟） */
function locate() {
  if (Date.now() - found.at < 60000) return found.bin;
  let bin = null;
  for (const c of candidates()) {
    try { fs.accessSync(c, fs.constants.X_OK); bin = c; break; } catch { /* next */ }
  }
  found = { at: Date.now(), bin };
  return bin;
}

function safeName(name, i) {
  const base = path.basename(String(name || '')).replace(/[^\w.\-]+/g, '_').slice(0, 80);
  return base && !/^\.+$/.test(base) && base.toLowerCase() !== 'task.md' ? `${i}-${base}` : `${i}-attachment.txt`;
}

function run(bin, dir) {
  const out = path.join(dir, '..', `${path.basename(dir)}-report.json`);
  return new Promise((resolve) => {
    execFile(bin, ['scan', dir, '--no-llm', '--format', 'json', '--output', out], { timeout: TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, () => {
      let j = null;
      try { j = JSON.parse(fs.readFileSync(out, 'utf8')); } catch { /* 没出报告 */ }
      try { fs.rmSync(out, { force: true }); } catch { /* ignore */ }
      resolve(j);
    });
  });
}

/**
 * @param {{ prompt: string, attachments?: Array<{ name: string, text: string }> }} task
 * @returns {Promise<{ available: boolean, ran: boolean, blocked: boolean, severity: string, findings: Array<{ id: string, severity: string, label: string, file: string }> }>}
 */
async function scanTask({ prompt, attachments = [] } = {}) {
  const none = { available: false, ran: false, blocked: false, severity: 'NONE', findings: [] };
  const bin = locate();
  if (!bin) return none;
  let dir = null;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-hire-scan-'));
    const task = path.join(dir, 'task');
    fs.mkdirSync(task);
    fs.writeFileSync(path.join(task, 'TASK.md'), String(prompt || ''));
    attachments.slice(0, 20).forEach((a, i) => fs.writeFileSync(path.join(task, safeName(a.name, i)), String(a.text || '').slice(0, 500000)));
    const j = await run(bin, task);
    if (!j || !j.risk_assessment) return { ...none, available: true };
    const findings = (j.issues || []).slice(0, 30).map(x => ({
      id: String(x.id || ''), severity: String(x.severity || ''),
      label: [x.category, x.pattern].filter(Boolean).join('：').slice(0, 120), file: String(x.location?.file || ''),
    }));
    const severity = String(j.risk_assessment.max_issue_severity || 'NONE').toUpperCase();
    return { available: true, ran: true, blocked: severity === 'HIGH' || severity === 'CRITICAL', severity, findings };
  } catch {
    return { ...none, available: true };
  } finally {
    if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }
  }
}

function agentGuide() {
  return locate()
    ? '本机装了 SkillSpector（NVIDIA 的技能安全扫描工具）：雇佣任务过了内置规则之后，你会自动再用它静态扫一遍，严重度到 HIGH 就拦。用户问技能安不安全时，也可以用命令 skillspector scan <目录> --no-llm 扫一遍再回答。'
    : '本机没装 SkillSpector（NVIDIA 的技能安全扫描工具，https://github.com/NVIDIA/SkillSpector）。装上之后雇佣任务会多一层扫描。用户要装时，先告诉他需要 Python 3.12 以上、约占 300MB，他同意后再装：uv tool install git+https://github.com/NVIDIA/skillspector.git（没有 uv 就用 pipx install）。';
}

module.exports = { scanTask, locate, agentGuide, _internal: { reset() { found = { at: 0, bin: null }; }, safeName } };
