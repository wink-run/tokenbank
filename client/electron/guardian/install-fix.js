// client/electron/guardian/install-fix.js
// 智能体应用（Claude Code、pi…）一键安装失败时：先认出原因，能安全自动处理的（中断残留、网络抖动）
// 清理后重试一次；处理不了的给出具体办法。只在用户点了安装之后介入，不碰其它流程。
'use strict';

const fs = require('fs');
const path = require('path');
const guardian = require('./index');

const KINDS = [
  { kind: 'staging', test: /ENOTEMPTY|EEXIST/, retry: 'sweep',
    title: '上次安装中断留下了残留文件', advice: '已自动清理残留后重试。' },
  // npm 自己已对网络错误重试多次（约 1 分钟），这里不再叠加重试，只说明原因和办法
  { kind: 'network', test: /ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|socket hang up|fetch failed|network/i,
    title: '连不上 npm 仓库', advice: '检查网络和代理；用了镜像的话确认地址可用（npm config get registry），恢复后再点一键安装。' },
  { kind: 'cert', test: /SELF_SIGNED_CERT|UNABLE_TO_VERIFY_LEAF|UNABLE_TO_GET_ISSUER|CERT_/i,
    title: '证书校验失败（常见于公司代理）', advice: '把代理的根证书路径设到 NODE_EXTRA_CA_CERTS 后重试。' },
  { kind: 'permission', test: /EACCES|EPERM|permission denied/i,
    title: '没有写入 npm 全局目录的权限', advice: '把 npm 全局目录改到用户目录：npm config set prefix ~/.npm-global，并把 ~/.npm-global/bin 加入 PATH。' },
  { kind: 'node-version', test: /EBADENGINE|Unsupported engine|requires node|node:module.*does not provide/i,
    title: 'Node.js 版本过低', advice: '升级到 Node.js 22.19 或更新版本后重试。' },
  { kind: 'no-npm', test: /npm: (command )?not found|spawn npm ENOENT|ENOENT.*npm/i,
    title: '没有找到 npm', advice: '先安装 Node.js（自带 npm），再回来一键安装。' },
  { kind: 'not-found', test: /E404|404 Not Found|is not in this registry/i,
    title: 'npm 仓库里找不到这个包', advice: '可能是镜像源未同步，切回官方源（npm config set registry https://registry.npmjs.org）后重试。' },
];

function classifyNpmError(text) {
  const t = String(text || '');
  for (const k of KINDS) if (k.test.test(t)) return k;
  return { kind: 'unknown', title: '安装失败', advice: '展开详情查看 npm 原始报错。' };
}

/** 清理 npm 原子安装中断留下的 .<包名>-<hash> 暂存目录（与桌面版卸载兜底一致） */
function sweepNpmStaging(npmRoot, pkg) {
  try {
    if (!npmRoot || !pkg) return 0;
    const pkgDir = path.join(npmRoot, pkg);
    const parent = path.dirname(pkgDir);
    const base = path.basename(pkgDir);
    let n = 0;
    if (fs.existsSync(parent)) {
      for (const f of fs.readdirSync(parent)) {
        if (f.startsWith(`.${base}-`)) {
          try { fs.rmSync(path.join(parent, f), { recursive: true, force: true }); n++; } catch { /* ignore */ }
        }
      }
    }
    return n;
  } catch {
    return 0;
  }
}

const wait = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * 包一层安装：attempt() → { ok, error }；sweep() 清理残留（可选）。
 * 返回值在原结果上附 guardian: { kind, title, advice, retried }，界面可直接展示原因和办法。
 */
async function installWithRepair({ id, name, pkg, attempt, sweep }) {
  const first = await attempt();
  if (first.ok) return first;
  const k = classifyNpmError(first.error);
  const label = name || id || pkg;
  const mode = guardian.modeOf('install');

  if (mode !== 'off' && k.retry) {
    if (k.retry === 'sweep' && typeof sweep === 'function') { try { await sweep(); } catch { /* ignore */ } }
    if (k.retry === 'wait') await wait(3000);
    const second = await attempt();
    if (second.ok) {
      guardian.record({
        category: 'install', kind: 'install-repaired', status: 'done',
        title: `安装 ${label} 时${k.title}，已自动处理并装好`,
        detail: String(first.error || '').slice(0, 300),
        meta: { id, pkg, cause: k.kind },
      });
      return { ...second, guardian: { kind: k.kind, title: k.title, advice: k.advice, retried: true } };
    }
    const k2 = classifyNpmError(second.error);
    guardian.record({
      category: 'install', kind: 'install-failed', status: 'failed',
      title: `安装 ${label} 失败：${k2.title}`, advice: k2.advice,
      detail: String(second.error || '').slice(0, 300), signature: `install|${id}|${k2.kind}`,
      meta: { id, pkg, cause: k2.kind, retried: true },
    });
    return { ...second, guardian: { kind: k2.kind, title: k2.title, advice: k2.advice, retried: true } };
  }

  if (mode !== 'off') {
    guardian.record({
      category: 'install', kind: 'install-failed', status: 'failed',
      title: `安装 ${label} 失败：${k.title}`, advice: k.advice,
      detail: String(first.error || '').slice(0, 300), signature: `install|${id}|${k.kind}`,
      meta: { id, pkg, cause: k.kind },
    });
  }
  return { ...first, guardian: { kind: k.kind, title: k.title, advice: k.advice, retried: false } };
}

module.exports = { classifyNpmError, sweepNpmStaging, installWithRepair, KINDS };
