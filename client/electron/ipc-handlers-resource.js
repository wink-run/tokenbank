// client/electron/ipc-handlers-resource.js
// 资源管理 IPC
'use strict';

const { ipcMain, BrowserWindow, dialog, shell } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const resourceManager = require('./resource-manager');

/** 展开 ~/ 前缀 */
function expandHome(p) {
  const s = String(p || '').trim();
  if (s === '~') return os.homedir();
  if (s.startsWith('~/') || s.startsWith('~\\')) return path.join(os.homedir(), s.slice(2));
  return s;
}

// 游乐场应用内预览：目录列表 / 文本 / Markdown / HTML / 图片
const PREVIEW_TEXT_MAX = 1.5 * 1024 * 1024;   // 1.5MB
const PREVIEW_IMAGE_MAX = 12 * 1024 * 1024;   // 12MB
const PREVIEW_DIR_MAX_ENTRIES = 500;
const PREVIEW_MARKDOWN_EXTS = new Set(['.md', '.markdown', '.mdx']);
const PREVIEW_HTML_EXTS = new Set(['.html', '.htm']);
const PREVIEW_TEXT_EXTS = new Set([
  '.txt', '.log', '.csv', '.tsv', '.json', '.yaml', '.yml', '.xml',
  '.css', '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.py', '.sh', '.bash', '.zsh',
  '.env', '.toml', '.ini', '.conf', '.cfg', '.rst', '.sql', '.go', '.rs', '.java',
  '.kt', '.swift', '.rb', '.php', '.c', '.h', '.cpp', '.hpp', '.vue', '.svelte',
]);
const PREVIEW_IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.ico']);
const IMAGE_MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};
// HTML 相对资源内联（srcdoc 无法可靠加载 file://）
const PREVIEW_ASSET_MAX = 8 * 1024 * 1024;      // 单资源上限
const PREVIEW_INLINE_TOTAL_MAX = 24 * 1024 * 1024; // 整页内联总量
const ASSET_MIME = {
  ...IMAGE_MIME,
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
};

/** 相对路径 → 绝对路径；跳过 data/http/绝对 file */
function resolveLocalAsset(baseDir, ref) {
  const raw = String(ref || '').trim();
  if (!raw || /^(data:|https?:|blob:|file:|#|\/\/|mailto:)/i.test(raw)) return null;
  // 去掉 hash / query
  const clean = raw.split('#')[0].split('?')[0];
  if (!clean) return null;
  try {
    const abs = path.resolve(baseDir, clean);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return null;
    return abs;
  } catch {
    return null;
  }
}

function fileToDataUrl(absPath) {
  const ext = path.extname(absPath).toLowerCase();
  const mime = ASSET_MIME[ext] || 'application/octet-stream';
  const st = fs.statSync(absPath);
  if (st.size > PREVIEW_ASSET_MAX) return null;
  const buf = fs.readFileSync(absPath);
  // 文本类用 charset，便于 CSS/JS；二进制用 base64
  if (mime.startsWith('text/') || mime === 'application/javascript' || mime === 'image/svg+xml') {
    return `data:${mime};charset=utf-8,${encodeURIComponent(buf.toString('utf8'))}`;
  }
  return `data:${mime};base64,${buf.toString('base64')}`;
}

/**
 * 把 HTML 内相对 src/href/url() 指到的本地文件内联为 data URL。
 * Chromium srcdoc 场景下 file:// 子资源通常被拦，必须内联才能预览到图。
 */
function inlineHtmlLocalAssets(html, filePath) {
  const baseDir = path.dirname(filePath);
  const cache = new Map();
  let total = 0;

  const toData = (abs) => {
    if (cache.has(abs)) return cache.get(abs);
    if (total >= PREVIEW_INLINE_TOTAL_MAX) {
      cache.set(abs, null);
      return null;
    }
    try {
      const st = fs.statSync(abs);
      if (total + st.size > PREVIEW_INLINE_TOTAL_MAX) {
        cache.set(abs, null);
        return null;
      }
      const url = fileToDataUrl(abs);
      if (url) total += st.size;
      cache.set(abs, url);
      return url;
    } catch {
      cache.set(abs, null);
      return null;
    }
  };

  let out = String(html || '');

  // src / href 属性（img、link、script、source 等）
  out = out.replace(/\b(src|href)\s*=\s*(["'])([^"']*)\2/gi, (m, attr, quote, ref) => {
    const abs = resolveLocalAsset(baseDir, ref);
    if (!abs) return m;
    const dataUrl = toData(abs);
    if (!dataUrl) return m;
    return `${attr}=${quote}${dataUrl}${quote}`;
  });

  // CSS url(...)（style 块 / 内联 style）
  out = out.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (m, q, ref) => {
    const abs = resolveLocalAsset(baseDir, ref);
    if (!abs) return m;
    const dataUrl = toData(abs);
    if (!dataUrl) return m;
    return `url(${q || '"'}${dataUrl}${q || '"'})`;
  });

  return out;
}

/** 为 srcdoc 补 charset；相对资源已由 inlineHtmlLocalAssets 处理 */
function htmlForSrcdoc(html) {
  const src = String(html || '');
  if (/<meta[^>]+charset=/i.test(src)) return src;
  if (/<head[^>]*>/i.test(src)) {
    return src.replace(/<head([^>]*)>/i, '<head$1><meta charset="utf-8">');
  }
  if (/<html[^>]*>/i.test(src)) {
    return src.replace(/<html([^>]*)>/i, '<html$1><head><meta charset="utf-8"></head>');
  }
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${src}</body></html>`;
}

function registerResourceHandlers() {
  // 启动时幂等：内置画像/发现/安装智能体自动纳管并尽量投射
  try {
    resourceManager.init();
    resourceManager.ensureBuiltinAssistants();
  } catch (e) {
    console.warn('[IPC] ensureBuiltinAssistants on register:', e.message);
  }

  ipcMain.handle('resource:ensureBuiltinAssistants', async () => {
    try {
      resourceManager.init();
      return resourceManager.ensureBuiltinAssistants();
    } catch (error) {
      console.error('[IPC] resource:ensureBuiltinAssistants error:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('resource:listCatalog', async (_event, filters = {}) => {
    try {
      resourceManager.init();
      return { success: true, ...resourceManager.listCatalog(filters) };
    } catch (error) {
      console.error('[IPC] resource:listCatalog error:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('resource:listResources', async (_event, filters = {}) => {
    try {
      resourceManager.init();
      // 列表时再尝试一次：用户新装 Agent 后可补上投射
      try { resourceManager.ensureBuiltinAssistants(); } catch { /* ignore */ }
      return { success: true, resources: resourceManager.listResources(filters) };
    } catch (error) {
      console.error('[IPC] resource:listResources error:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('resource:installCatalog', async (_event, { catalogId } = {}) => {
    try {
      resourceManager.init();
      return resourceManager.installFromCatalog(catalogId);
    } catch (error) {
      console.error('[IPC] resource:installCatalog error:', error);
      return { success: false, error: error.message };
    }
  });

  // 拉取最新社区目录到本机缓存（推荐/纳管后刷新）
  ipcMain.handle('resource:syncCommunityCatalog', async () => {
    try {
      const catalogSync = require('./catalog-sync');
      const result = await catalogSync.syncCommunityCatalog({});
      return { success: true, ...result };
    } catch (error) {
      console.error('[IPC] resource:syncCommunityCatalog error:', error);
      return { success: false, error: error.message };
    }
  });

  // 把单条 skill 写入本机社区缓存（结算返回 item 后即可纳管）
  ipcMain.handle('resource:upsertCommunitySkill', async (_event, { item } = {}) => {
    try {
      const catalogSync = require('./catalog-sync');
      const ok = catalogSync.upsertCommunitySkillItem(item);
      if (ok) {
        try { require('./resource-catalog').resetCatalogCache(); } catch {}
      }
      return { success: !!ok };
    } catch (error) {
      console.error('[IPC] resource:upsertCommunitySkill error:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('resource:saveResource', async (_event, data = {}) => {
    try {
      resourceManager.init();
      return resourceManager.saveResource(data);
    } catch (error) {
      console.error('[IPC] resource:saveResource error:', error);
      return { success: false, error: error.message };
    }
  });

  // 支持 deleteResource(id) / deleteResource(id, opts) / deleteResource({ resourceId, force })
  ipcMain.handle('resource:deleteResource', async (_event, resourceIdOrPayload, maybeOptions) => {
    try {
      resourceManager.init();
      let resourceId = resourceIdOrPayload;
      let options = maybeOptions || {};
      if (resourceIdOrPayload && typeof resourceIdOrPayload === 'object') {
        resourceId = resourceIdOrPayload.resourceId;
        options = resourceIdOrPayload;
      }
      return resourceManager.deleteResource(resourceId, options || {});
    } catch (error) {
      console.error('[IPC] resource:deleteResource error:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('resource:project', async (_event, { resourceId, agentIds, scope, force, allowRisky } = {}) => {
    try {
      resourceManager.init();
      // 看护安全巡检：高风险技能（下载即执行、外发密钥等）投射前要用户确认一次
      if (!allowRisky) {
        try {
          const risk = require('./guardian/asset-checks').securityGate(resourceManager.getResource(resourceId));
          if (risk) return { success: false, error: 'security-risk', securityFindings: risk.findings };
        } catch (e) { console.warn('[guardian] security gate:', e.message); }
      }
      const result = resourceManager.projectToAgents(resourceId, agentIds, scope || 'global', { force: !!force });
      return result;
    } catch (error) {
      console.error('[IPC] resource:project error:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('resource:verifyProjections', async (_event, { resourceId, repair } = {}) => {
    try {
      resourceManager.init();
      return resourceManager.verifyProjections(resourceId, { repair: !!repair });
    } catch (error) {
      console.error('[IPC] resource:verifyProjections error:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('resource:unproject', async (_event, params = {}) => {
    try {
      resourceManager.init();
      return resourceManager.unproject(params);
    } catch (error) {
      console.error('[IPC] resource:unproject error:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('resource:listAgentTargets', async () => {
    try {
      resourceManager.init();
      // 有新的可投射 Agent 时，补投射内置智能体
      try { resourceManager.ensureBuiltinAssistants(); } catch { /* ignore */ }
      return {
        success: true,
        // skill / prompt / assistant 三套目标分开
        agents: resourceManager.listAgentTargets(),
        promptAgents: resourceManager.listPromptAgentTargets(),
        assistantAgents: resourceManager.listAssistantAgentTargets(),
      };
    } catch (error) {
      console.error('[IPC] resource:listAgentTargets error:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('resource:listScanRoots', async (_event, filters = {}) => {
    try {
      resourceManager.init();
      return resourceManager.listScanRoots(filters || {});
    } catch (error) {
      console.error('[IPC] resource:listScanRoots error:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('resource:scanDiscovered', async (_event, filters = {}) => {
    try {
      resourceManager.init();
      return { success: true, ...resourceManager.listDiscoveredSkills(filters) };
    } catch (error) {
      console.error('[IPC] resource:scanDiscovered error:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('resource:syncDiscovered', async (_event, filters = {}) => {
    try {
      resourceManager.init();
      return resourceManager.syncDiscoveredSkills(filters);
    } catch (error) {
      console.error('[IPC] resource:syncDiscovered error:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('resource:importDiscovered', async (_event, params = {}) => {
    try {
      resourceManager.init();
      return resourceManager.importDiscoveredSkill(params);
    } catch (error) {
      console.error('[IPC] resource:importDiscovered error:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('resource:listAgentInstallations', async (_event, filters = {}) => {
    try {
      resourceManager.init();
      return { success: true, agents: resourceManager.listAgentInstallations(filters) };
    } catch (error) {
      console.error('[IPC] resource:listAgentInstallations error:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('resource:importFromAgent', async (_event, params = {}) => {
    try {
      resourceManager.init();
      return resourceManager.importFromAgent(params || {});
    } catch (error) {
      console.error('[IPC] resource:importFromAgent error:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('resource:removeFromAgent', async (_event, params = {}) => {
    try {
      resourceManager.init();
      return resourceManager.removeFromAgent(params || {});
    } catch (error) {
      console.error('[IPC] resource:removeFromAgent error:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('resource:pickImportPath', async (_event, options = {}) => {
    try {
      const win = BrowserWindow.getFocusedWindow();
      const properties = [];
      if (options.allowDirectory !== false) properties.push('openDirectory');
      if (options.allowFile !== false) properties.push('openFile');
      const result = await dialog.showOpenDialog(win, {
        title: options.title || '导入资产',
        properties: properties.length ? properties : ['openFile'],
        filters: options.allowFile !== false ? [
          { name: 'Markdown / Text', extensions: ['md', 'markdown', 'txt'] },
        ] : undefined,
      });
      if (result.canceled || !result.filePaths?.length) {
        return { success: false, canceled: true };
      }
      return { success: true, path: result.filePaths[0] };
    } catch (error) {
      console.error('[IPC] resource:pickImportPath error:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('resource:importFromPath', async (_event, params = {}) => {
    try {
      resourceManager.init();
      return resourceManager.importFromPath(params || {});
    } catch (error) {
      console.error('[IPC] resource:importFromPath error:', error);
      return { success: false, error: error.message };
    }
  });

  /**
   * 打开路径：目录始终用系统打开；文件默认在资源管理器中定位（reveal），
   * action=open 时用默认应用预览/打开（聊天里点路径预览 PPT 等）。
   */
  ipcMain.handle('resource:openPath', async (_event, { targetPath, action } = {}) => {
    if (!targetPath || typeof targetPath !== 'string') {
      return { success: false, error: 'missing_path' };
    }
    try {
      const resolved = path.resolve(expandHome(targetPath));
      if (!fs.existsSync(resolved)) return { success: false, error: 'not_found' };
      const isFile = fs.statSync(resolved).isFile();
      if (isFile && action !== 'open') {
        shell.showItemInFolder(resolved);
      } else {
        const errMsg = await shell.openPath(resolved);
        if (errMsg) return { success: false, error: errMsg };
      }
      return { success: true };
    } catch (error) {
      console.error('[IPC] resource:openPath error:', error);
      return { success: false, error: error.message };
    }
  });

  /**
   * 游乐场应用内预览：
   * - 目录 → 列出子项（供前端浏览）
   * - Markdown / 文本 / 图片 → 读入内容
   * - 其它 → unsupported（前端回退系统打开）
   */
  ipcMain.handle('resource:previewFile', async (_event, { targetPath } = {}) => {
    if (!targetPath || typeof targetPath !== 'string') {
      return { success: false, error: 'missing_path' };
    }
    try {
      const resolved = path.resolve(expandHome(String(targetPath).replace(/^file:\/\//i, '')));
      if (!fs.existsSync(resolved)) return { success: false, error: 'not_found' };
      const st = fs.statSync(resolved);
      const name = path.basename(resolved);
      const parent = path.dirname(resolved);

      // 文件夹：列出子项
      if (st.isDirectory()) {
        let names = [];
        try { names = fs.readdirSync(resolved); } catch (e) {
          return { success: false, error: e.message || 'read_dir_failed' };
        }
        const entries = [];
        let hitLimit = false;
        for (const entName of names) {
          if (entName === '.' || entName === '..') continue;
          // 跳过常见隐藏噪声（仍可通过系统打开看全量）
          if (entName === '.DS_Store' || entName === 'Thumbs.db') continue;
          if (entries.length >= PREVIEW_DIR_MAX_ENTRIES) { hitLimit = true; break; }
          const full = path.join(resolved, entName);
          let est = null;
          try { est = fs.statSync(full); } catch { continue; }
          entries.push({
            name: entName,
            path: full,
            kind: est.isDirectory() ? 'dir' : 'file',
            size: est.isFile() ? est.size : null,
            ext: est.isFile() ? path.extname(entName).toLowerCase() : '',
          });
        }
        // 目录在前，再按名称排序
        entries.sort((a, b) => {
          if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
          return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
        });
        return {
          success: true,
          kind: 'directory',
          path: resolved,
          name: name || resolved,
          parent,
          size: null,
          entries,
          truncated: hitLimit,
        };
      }

      if (!st.isFile()) return { success: false, error: 'unsupported' };

      const ext = path.extname(resolved).toLowerCase();
      const size = st.size;

      if (PREVIEW_IMAGE_EXTS.has(ext)) {
        if (size > PREVIEW_IMAGE_MAX) {
          return { success: false, error: 'too_large', kind: 'image', path: resolved, name, size };
        }
        const buf = fs.readFileSync(resolved);
        const mime = IMAGE_MIME[ext] || 'application/octet-stream';
        return {
          success: true,
          kind: 'image',
          path: resolved,
          name,
          parent,
          size,
          dataUrl: `data:${mime};base64,${buf.toString('base64')}`,
        };
      }

      if (PREVIEW_HTML_EXTS.has(ext) || PREVIEW_MARKDOWN_EXTS.has(ext) || PREVIEW_TEXT_EXTS.has(ext)) {
        const kind = PREVIEW_HTML_EXTS.has(ext)
          ? 'html'
          : (PREVIEW_MARKDOWN_EXTS.has(ext) ? 'markdown' : 'text');
        if (size > PREVIEW_TEXT_MAX) {
          return { success: false, error: 'too_large', kind, path: resolved, name, size };
        }
        const content = fs.readFileSync(resolved, 'utf8');
        const payload = {
          success: true,
          kind,
          path: resolved,
          name,
          parent,
          size,
          content,
        };
        // HTML：相对图片/CSS 内联为 data URL（srcdoc 无法加载 file://）
        if (kind === 'html') {
          payload.srcdoc = htmlForSrcdoc(inlineHtmlLocalAssets(content, resolved));
        }
        return payload;
      }

      return { success: false, error: 'unsupported', path: resolved, name, size };
    } catch (error) {
      console.error('[IPC] resource:previewFile error:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('resource:listIdleSkills', async (_event, options = {}) => {
    try {
      resourceManager.init();
      return resourceManager.listIdleSkills(options || {});
    } catch (error) {
      console.error('[IPC] resource:listIdleSkills error:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('resource:cleanupSkills', async (_event, params = {}) => {
    try {
      resourceManager.init();
      return resourceManager.cleanupSkills(params.resourceIds || []);
    } catch (error) {
      console.error('[IPC] resource:cleanupSkills error:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('resource:mineDemand', async (_event, options = {}) => {
    try {
      resourceManager.init();
      return resourceManager.mineDemand(options || {});
    } catch (error) {
      console.error('[IPC] resource:mineDemand error:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('resource:installSkillhub', async (_event, params = {}) => {
    try {
      resourceManager.init();
      const slugs = Array.isArray(params.slugs) ? params.slugs : [params.slug];
      if (slugs.filter(Boolean).length > 1) {
        return await resourceManager.installSkillhubSkills(slugs);
      }
      return await resourceManager.installSkillhubSkill(slugs[0] || params.slug, {
        force: !!params.force,
        description: params.description || '',
      });
    } catch (error) {
      console.error('[IPC] resource:installSkillhub error:', error);
      return { success: false, error: error.message };
    }
  });

  // GitHub URL / owner/repo → ~/.tokenbank/skills（不走 skillhub slug）
  ipcMain.handle('resource:installGithubSkill', async (_event, params = {}) => {
    try {
      resourceManager.init();
      return await resourceManager.installGithubSkill(params.source || params.url || params.input, {
        force: !!params.force,
        description: params.description || '',
        installRoot: params.installRoot || undefined,
      });
    } catch (error) {
      console.error('[IPC] resource:installGithubSkill error:', error);
      return { success: false, error: error.message };
    }
  });

  // 从正文提炼卡片说明（推荐到社区等场景）
  ipcMain.handle('resource:extractDescription', async (_event, params = {}) => {
    try {
      const { extractResourceDescription } = require('./resource-description');
      const type = params.type || 'skill';
      const content = String(params.content || '');
      const description = extractResourceDescription(type, content, {
        description: params.description || '',
        name: params.name || '',
      });
      return { success: true, description: description || '' };
    } catch (error) {
      console.error('[IPC] resource:extractDescription error:', error);
      return { success: false, error: error.message, description: '' };
    }
  });

  // 息票兜底：读最近一次命中（MCP 写盘后渲染进程轮询）
  ipcMain.handle('resource:pollHit', async () => {
    try {
      const { readLatestHit } = require('./resource-hit-or-exit');
      return readLatestHit();
    } catch {
      return null;
    }
  });
}

module.exports = { registerResourceHandlers };
