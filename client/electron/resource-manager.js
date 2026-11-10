// client/electron/resource-manager.js
// Prompt / Skill / Assistant 统一纳管与投射
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const localStats = require('./local-stats');
const { STATS_DIR } = require('../shared/telemetry');
const {
  getCatalogItem,
  listCatalogItems,
  listCatalogGrouped,
  RESOURCE_TYPE_LABELS,
  BUILTIN_ASSISTANT_CATALOG_IDS,
  isBuiltinAssistantCatalogId,
} = require('./resource-catalog');

/** 内置智能体自动投射时的优先运行时 */
const BUILTIN_ASSISTANT_PREFERRED_AGENTS = ['codex', 'claude-code', 'cursor', 'workbuddy'];
const { projectResource, unprojectResource, verifyProjection } = require('./resource-projector');
const {
  resolveAuthorityDir,
  syncSkillContentToAuthority,
  normalizeSkillDirPath,
  copyDirRecursive,
  materializeSkillDir,
} = require('./resource-canonical');

/** Token Bank 落盘 skill 的默认权威根（agents-hub，已被 Skill 扫描器覆盖） */
const SKILL_HUB_ROOT = path.join(os.homedir(), '.agents', 'skills');
const {
  TOKENBANK_SKILL_ROOT,
  parseGithubSkillRef,
  materializeGithubSkill,
} = require('./skill-github-install');
const {
  extractResourceDescription,
  isBlankCardDesc,
  shouldReplaceDescription,
} = require('./resource-description');
/** 缺失依赖（数据异常）每种只报一次，避免刷屏 */
const _missingCatalogDepLogged = new Set();
const {
  AGENT_RESOURCE_TARGETS,
  listProjectableAgentIds,
  listSkillProjectableAgentIds,
  listAssistantProjectableAgentIds,
  listPromptProjectableAgentIds,
} = require('./resource-agent-targets');
const {
  scanAllAgentSkills,
  buildAgentSkillScanIndex,
  removeRawAgentSkill,
  groupDiscoveredSkills,
  findScanGroupByScanKey,
  hashContent: scanHashContent,
  parseSkillFrontmatter,
} = require('./resource-skill-scanner');
const {
  parseAssistantConfig,
  formatAssistantContent,
  assistantContentNeedsMigration,
  resolveAssistantRuntimeAgent,
  withAssistantRuntimeAgent,
  hasAssistantEnableProjection,
  resolveAssistantContext,
  ASSISTANT_RUNTIME_IDS,
  DEFAULT_RUNTIME_AGENT,
} = require('./resource-assistant');

/**
 * 按模板智能填充参数：正文含 $ARGUMENTS → 全部替换为参数；不含 → 参数非空时以分隔线追加。
 * 纯函数，供 resolvePrompt 与单测直接使用。
 */
function applyPromptArguments(body, argString) {
  const text = String(body || '');
  const args = typeof argString === 'string' ? argString.trim() : '';
  if (text.includes('$ARGUMENTS')) {
    return text.split('$ARGUMENTS').join(args);
  }
  return args ? `${text}\n\n---\n\n${args}` : text;
}

class ResourceManager {
  constructor() {
    this._ready = false;
    /** 最近一次扫描参数，供纳管时定位 Skill */
    this._lastScanOptions = { customDirs: [] };
  }

  _getDb() {
    return localStats.requireDb(STATS_DIR);
  }

  init() {
    if (this._ready) return;
    this._getDb();
    // 回滚未完成的 assistant→agent 改名：库内 type=agent 恢复为 assistant
    this._migrateAgentTypeToAssistant();
    this._ready = true;
  }

  /** 将误写为 agent 的资源类型纠正回 assistant（幂等） */
  _migrateAgentTypeToAssistant() {
    try {
      const db = this._getDb();
      const info = db.prepare(
        "UPDATE resources SET type = 'assistant', updated_at = ? WHERE type = 'agent'",
      ).run(Date.now());
      if (info.changes > 0) {
        console.log(`[resource-manager] migrated ${info.changes} resource(s) type agent → assistant`);
        this._invalidateAgentList?.();
      }
    } catch (e) {
      console.warn('[resource-manager] migrate agent→assistant failed:', e.message);
    }
  }

  /** 是否内置智能体（不可删除；source=builtin） */
  _isBuiltinAssistant(resource, catalogId) {
    if (catalogId && isBuiltinAssistantCatalogId(catalogId)) return true;
    if (!resource) return false;
    if (resource.source === 'builtin') return true;
    if (resource.metadata && resource.metadata.builtin) return true;
    const url = String(resource.source_url || '');
    if (url.startsWith('builtin:')) return true;
    if (url.startsWith('catalog:')) {
      return isBuiltinAssistantCatalogId(url.slice('catalog:'.length));
    }
    return BUILTIN_ASSISTANT_CATALOG_IDS.some((cid) => {
      const item = getCatalogItem(cid);
      return item && item.name === resource.name && resource.type === 'assistant';
    });
  }

  _markBuiltinSource(resourceId, catalogId) {
    const db = this._getDb();
    const now = Date.now();
    const sourceUrl = `builtin:${catalogId || resourceId}`;
    db.prepare(`
      UPDATE resources
      SET source = 'builtin', source_url = ?, updated_at = ?
      WHERE id = ?
    `).run(sourceUrl, now, resourceId);
    // metadata.builtin 标记，便于 UI 识别
    const row = db.prepare('SELECT metadata FROM resources WHERE id = ?').get(resourceId);
    if (!row) return;
    let meta = {};
    try { meta = JSON.parse(row.metadata || '{}') || {}; } catch { meta = {}; }
    if (meta.builtin) return;
    meta.builtin = true;
    db.prepare('UPDATE resources SET metadata = ? WHERE id = ?')
      .run(JSON.stringify(meta), resourceId);
  }

  _pickBuiltinProjectAgentId(allowedIds) {
    const ids = Array.isArray(allowedIds) ? allowedIds : [];
    for (const pref of BUILTIN_ASSISTANT_PREFERRED_AGENTS) {
      if (ids.includes(pref)) return pref;
    }
    return ids[0] || null;
  }

  /**
   * 确保内置智能体已纳管，并在有可投射 Agent 时自动投射（幂等）。
   * 无可投射 Agent 时仅纳管，不抛错。
   */
  ensureBuiltinAssistants() {
    // 注意：不可再调 init() 若其内部会 ensureBuiltin 形成递归；此处只保证 DB + 迁移
    if (!this._ready) {
      this._getDb();
      this._migrateAgentTypeToAssistant();
      this._ready = true;
    }
    const results = [];
    for (const catalogId of BUILTIN_ASSISTANT_CATALOG_IDS) {
      try {
        const item = getCatalogItem(catalogId);
        if (!item) {
          results.push({ catalogId, status: 'missingCatalog' });
          continue;
        }
        const installed = this.installFromCatalog(catalogId);
        const resourceId = installed?.resource?.id
          || this._findByTypeName(item.type, item.name)?.id;
        if (!resourceId) {
          results.push({ catalogId, status: 'installFailed' });
          continue;
        }
        this._markBuiltinSource(resourceId, catalogId);
        let resource = this.getResource(resourceId);
        if ((resource.projections || []).length > 0) {
          results.push({ catalogId, status: 'ready', resourceId, agentId: resource.projections[0].agentId });
          continue;
        }
        const { listManagedResourceAgentIds } = require('./resource-agent-targets');
        const allowed = listManagedResourceAgentIds();
        const agentId = this._pickBuiltinProjectAgentId(allowed);
        if (!agentId) {
          results.push({ catalogId, status: 'needAgent', resourceId });
          continue;
        }
        let proj = this.projectToAgents(resourceId, [agentId], 'global', { force: false });
        if (proj && proj.conflicts && proj.conflicts.length) {
          proj = this.projectToAgents(resourceId, [agentId], 'global', { force: true });
        }
        if (!proj || !proj.success) {
          results.push({
            catalogId,
            status: 'projectFailed',
            resourceId,
            error: (proj && proj.error) || 'project failed',
          });
          continue;
        }
        resource = this.getResource(resourceId);
        results.push({ catalogId, status: 'projected', resourceId, agentId });
      } catch (e) {
        console.warn('[resource-manager] builtin assistant ensure failed:', catalogId, e.message);
        results.push({ catalogId, status: 'error', error: e.message });
      }
    }
    return { success: true, results };
  }

  _parseJson(raw, fallback = {}) {
    if (!raw) return fallback;
    try { return JSON.parse(raw); } catch { return fallback; }
  }

  _hashContent(content) {
    return crypto.createHash('sha256').update(String(content || '')).digest('hex').slice(0, 16);
  }

  /** Skill：登记权威目录（用户安装位置），必要时同步 SKILL.md */
  _persistSkillAuthority(resourceId, resource, options = {}) {
    if (!resource || resource.type !== 'skill') return null;

    const meta = { ...(resource.metadata || {}) };
    if (options.authorityPath) {
      meta.authorityPath = normalizeSkillDirPath(options.authorityPath, resource.name)
        || options.authorityPath;
      delete meta.canonicalPath;
    } else if (options.sourceDir) {
      meta.authorityPath = normalizeSkillDirPath(options.sourceDir, resource.name) || options.sourceDir;
      meta.scannedFrom = meta.authorityPath;
      delete meta.canonicalPath;
    }

    const authorityDir = resolveAuthorityDir({ ...resource, metadata: meta });
    if (authorityDir && resource.content != null && options.syncContent) {
      syncSkillContentToAuthority(authorityDir, resource.content, resource.metadata?.files || null);
      meta.authorityPath = authorityDir;
    }

    const db = this._getDb();
    db.prepare('UPDATE resources SET metadata = ?, updated_at = ? WHERE id = ?').run(
      JSON.stringify(meta),
      Date.now(),
      resourceId,
    );
    return authorityDir || meta.authorityPath || null;
  }

  /**
   * 无磁盘来源的 skill 落盘到默认权威目录（~/.agents/skills/<name>），并登记
   * agents-hub scan 投射。使被扫描器发现（「已纳管」tab 显示）、可投射、可卸载。
   * @returns {string} 权威目录绝对路径
   */
  _materializeSkillToHub(resourceId, resource) {
    const skillDir = path.join(SKILL_HUB_ROOT, resource.name);
    materializeSkillDir(skillDir, resource.content || '', resource.metadata?.files || null);
    const authorityPath = path.resolve(skillDir);

    const db = this._getDb();
    const meta = { ...(resource.metadata || {}), authorityPath, scannedFrom: authorityPath };
    delete meta.canonicalPath;
    const now = Date.now();
    db.prepare('UPDATE resources SET metadata = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(meta), now, resourceId);

    const existing = db.prepare(
      'SELECT id FROM resource_projections WHERE resource_id = ? AND agent_id = ? AND scope = ?',
    ).get(resourceId, 'agents-hub', 'global');
    if (!existing) {
      db.prepare(`
        INSERT INTO resource_projections
        (id, resource_id, agent_id, scope, projection_type, target_path, status, created_at)
        VALUES (?, ?, 'agents-hub', 'global', 'scan', ?, 'active', ?)
      `).run(`proj-${resourceId}-agents-hub-global`, resourceId, skillDir, now);
    }
    return authorityPath;
  }

  /**
   * 保证 skill 已落盘：已有真实权威目录则同步 SKILL.md，否则物化到 agents-hub。
   * catalog 安装 / 手动新建的 DB-only skill 经此获得磁盘存在。
   */
  _ensureSkillOnDisk(resourceId) {
    const resource = this.getResource(resourceId);
    if (!resource || resource.type !== 'skill') return null;
    // 已有本机权威目录：只登记路径，不回写 SKILL.md，避免改原始 skill
    if (resolveAuthorityDir(resource)) {
      return this._persistSkillAuthority(resourceId, resource, { syncContent: false });
    }
    return this._materializeSkillToHub(resourceId, resource);
  }

  _mergeAuthorityMetadata(resource, patch = {}) {
    return {
      ...resource,
      metadata: { ...(resource.metadata || {}), ...patch },
    };
  }

  _rowToResource(row) {
    if (!row) return null;
    const metadata = this._parseJson(row.metadata, {});
    // 命中字段：优先列，兼容旧库写在 metadata 的降级
    const useCount = Math.max(
      0,
      Number(row.use_count != null ? row.use_count : metadata.use_count) || 0,
    );
    const lastUsedAt = row.last_used_at != null
      ? Number(row.last_used_at) || null
      : (metadata.last_used_at != null ? Number(metadata.last_used_at) || null : null);
    const resource = {
      id: row.id,
      type: row.type,
      name: row.name,
      // Skill 一律用 name，不套中文 display_name，避免与磁盘原文不一致
      display_name: row.type === 'skill' ? row.name : (row.display_name || row.name),
      description: row.description || '',
      content: row.content || '',
      metadata,
      source: row.source || 'local',
      source_url: row.source_url || null,
      hash: row.hash,
      created_at: row.created_at,
      updated_at: row.updated_at,
      use_count: useCount,
      last_used_at: lastUsedAt,
    };
    if (resource.type === 'skill') {
      resource.authorityPath = resolveAuthorityDir(resource);
    }
    if (resource.type === 'assistant') {
      return this._ensureAssistantContentFormat(resource);
    }
    return resource;
  }

  /** 读取时自动将 system_prompt 迁移为 soul 并写回库 */
  _ensureAssistantContentFormat(resource) {
    if (!resource || resource.type !== 'assistant') return resource;
    if (!assistantContentNeedsMigration(resource.content)) return resource;

    const content = formatAssistantContent(resource.content);
    const now = Date.now();
    const hash = this._hashContent(content);
    this._getDb().prepare(`
      UPDATE resources SET content = ?, hash = ?, updated_at = ? WHERE id = ?
    `).run(content, hash, now, resource.id);

    return { ...resource, content, hash, updated_at: now };
  }

  _getProjections(resourceId) {
    const db = this._getDb();
    const rows = db.prepare(`
      SELECT * FROM resource_projections WHERE resource_id = ? ORDER BY created_at DESC
    `).all(resourceId);
    return rows.map(r => this._mapProjectionRow(r));
  }

  /** 单行投射 → 前端结构 */
  _mapProjectionRow(r) {
    return {
      id: r.id,
      resourceId: r.resource_id,
      agentId: r.agent_id,
      scope: r.scope,
      projectionType: r.projection_type,
      targetPath: r.target_path,
      status: r.status,
      createdAt: r.created_at,
      label: AGENT_RESOURCE_TARGETS[r.agent_id]?.label || r.agent_id,
    };
  }

  /** 一次查出全部投射，按 resource_id 分组（避免 list 时 N+1） */
  _getProjectionsByResourceId() {
    const db = this._getDb();
    const rows = db.prepare(`
      SELECT * FROM resource_projections ORDER BY created_at DESC
    `).all();
    const map = new Map();
    for (const r of rows) {
      const list = map.get(r.resource_id) || [];
      list.push(this._mapProjectionRow(r));
      map.set(r.resource_id, list);
    }
    return map;
  }

  listCatalog(filters = {}) {
    this.init();
    // 打开目录时同样确保内置智能体已默认纳管
    try { this.ensureBuiltinAssistants(); } catch { /* ignore */ }
    const sets = {
      managedSet: this._getManagedDepKeySet(),
      catalogSet: this._getCatalogDepKeySet(),
    };
    const items = listCatalogItems(filters).map(item => {
      const installed = this._findByTypeName(item.type, item.name);
      const out = {
        ...item,
        installed: !!installed,
        resourceId: installed?.id || null,
      };
      // 目录智能体同样标注无法解析的依赖，纳管前即可发现
      if (item.type === 'assistant') this._annotateAssistantDeps(out, sets);
      return out;
    });
    return {
      items,
      grouped: listCatalogGrouped(),
      typeLabels: RESOURCE_TYPE_LABELS,
    };
  }

  _findByTypeName(type, name) {
    const row = this._getDb().prepare(
      'SELECT * FROM resources WHERE type = ? AND name = ?',
    ).get(type, name);
    return this._rowToResource(row);
  }

  /** 本机已纳管的 skill/prompt：`type:name` 集合，用于智能体依赖校验 */
  _getManagedDepKeySet() {
    const rows = this._getDb().prepare(
      "SELECT type, name FROM resources WHERE type IN ('skill', 'prompt')",
    ).all();
    return new Set(rows.map(r => `${r.type}:${r.name}`));
  }

  /** 社区目录中的 skill/prompt：`type:name` 集合 */
  _getCatalogDepKeySet() {
    return new Set(
      listCatalogItems()
        .filter(c => c.type === 'skill' || c.type === 'prompt')
        .map(c => `${c.type}:${c.name}`),
    );
  }

  /**
   * 智能体声明了、但目录与本机均不存在、且无法运行时自装的依赖。
   * skill 可由执行时 skillhub 按需安装，不算缺失；仅 prompt 需事先纳管/进目录。
   * @returns {{ type: string, name: string }[]}
   */
  _getAssistantMissingDeps(assistantItem, { managedSet, catalogSet } = {}) {
    const config = parseAssistantConfig((assistantItem && assistantItem.content) || '');
    const managed = managedSet || this._getManagedDepKeySet();
    const catalog = catalogSet || this._getCatalogDepKeySet();
    const missing = [];
    for (const name of config.prompts || []) {
      const key = `prompt:${name}`;
      if (managed.has(key) || catalog.has(key)) continue;
      missing.push({ type: 'prompt', name });
    }
    return missing;
  }

  /** 给智能体资源挂上 missingDeps / depsBroken，供 UI 标识 */
  _annotateAssistantDeps(resource, sets) {
    if (!resource || resource.type !== 'assistant') return resource;
    const missingDeps = this._getAssistantMissingDeps(resource, sets);
    resource.missingDeps = missingDeps;
    resource.depsBroken = missingDeps.length > 0;
    return resource;
  }

  listResources(filters = {}) {
    this.init();
    const db = this._getDb();
    let sql = 'SELECT * FROM resources WHERE type != ?';
    const params = ['template'];

    if (filters.type) {
      sql += ' AND type = ?';
      params.push(filters.type);
    }
    if (filters.query) {
      sql += ' AND (name LIKE ? OR display_name LIKE ? OR description LIKE ?)';
      const q = `%${filters.query}%`;
      params.push(q, q, q);
    }
    sql += ' ORDER BY created_at DESC';

    const rows = db.prepare(sql).all(...params);
    const needAnnotate = !filters.type || filters.type === 'assistant';
    const sets = needAnnotate
      ? { managedSet: this._getManagedDepKeySet(), catalogSet: this._getCatalogDepKeySet() }
      : null;
    // Skill：会话 skill_calls 回填命中，避免 Cursor 附加 Skill 仍显示「未使用」
    let skillStats = null;
    const needSkillHits = !filters.type || filters.type === 'skill';
    if (needSkillHits) {
      try { skillStats = localStats.getSkillCallStatsMap?.() || null; } catch { skillStats = null; }
    }
    // 批量取投射，避免每资源一次 SQL
    const projById = this._getProjectionsByResourceId();
    return rows.map(row => {
      const resource = this._rowToResource(row);
      resource.projections = projById.get(resource.id) || [];
      if (needAnnotate) this._annotateAssistantDeps(resource, sets);
      if (skillStats && resource.type === 'skill') {
        this._mergeSkillCallHits(resource, skillStats);
      }
      return resource;
    });
  }

  /**
   * 用 skill_calls 合并命中字段（只抬升，不覆盖更大的 MCP 命中）
   * @param {object} resource
   * @param {Map<string, { count: number, lastTs: number }>} statsMap
   */
  _mergeSkillCallHits(resource, statsMap) {
    if (!resource || resource.type !== 'skill' || !statsMap) return resource;
    const key = String(resource.name || '').trim().toLowerCase();
    const alt = String(resource.display_name || '').trim().toLowerCase();
    const st = statsMap.get(key) || (alt && alt !== key ? statsMap.get(alt) : null);
    if (!st) return resource;
    const last = Number(st.lastTs) || 0;
    const count = Number(st.count) || 0;
    if (last > (Number(resource.last_used_at) || 0)) resource.last_used_at = last;
    if (count > (Number(resource.use_count) || 0)) resource.use_count = count;
    return resource;
  }

  /**
   * 将 skill_calls 汇总写回 resources.use_count / last_used_at（Hit-or-Exit）
   * @returns {{ updated: number }}
   */
  applySessionSkillHits() {
    this.init();
    let statsMap;
    try { statsMap = localStats.getSkillCallStatsMap?.(); } catch { statsMap = null; }
    if (!statsMap || !statsMap.size) return { updated: 0 };

    const db = this._getDb();
    const skills = db.prepare(
      "SELECT id, name, display_name, use_count, last_used_at FROM resources WHERE type = 'skill'",
    ).all();
    let updated = 0;
    const upd = db.prepare(`
      UPDATE resources
      SET use_count = ?, last_used_at = ?, updated_at = updated_at
      WHERE id = ?
    `);
    const run = db.transaction((rows) => {
      for (const row of rows) {
        const key = String(row.name || '').trim().toLowerCase();
        const alt = String(row.display_name || '').trim().toLowerCase();
        const st = statsMap.get(key) || (alt && alt !== key ? statsMap.get(alt) : null);
        if (!st) continue;
        const nextCount = Math.max(Number(row.use_count) || 0, Number(st.count) || 0);
        const nextLast = Math.max(Number(row.last_used_at) || 0, Number(st.lastTs) || 0);
        if (nextCount === (Number(row.use_count) || 0)
          && nextLast === (Number(row.last_used_at) || 0)) continue;
        if (!nextLast && !nextCount) continue;
        upd.run(nextCount, nextLast || null, row.id);
        updated += 1;
      }
    });
    try { run(skills); } catch (e) {
      console.warn('[resource-manager] applySessionSkillHits:', e.message);
    }
    return { updated };
  }

  getResource(resourceId) {
    this.init();
    const row = this._getDb().prepare('SELECT * FROM resources WHERE id = ?').get(resourceId);
    const resource = this._rowToResource(row);
    if (resource) {
      resource.projections = this._getProjections(resourceId);
      this._annotateAssistantDeps(resource);
    }
    return resource;
  }

  /**
   * 解析提示词引用（触发词后的 `name` 或 `#id`）为展开后的正文。
   * @param {string} ref 提示词 name，或 `#<id>` / 纯 id
   * @param {string} argString 触发词后的参数原文（可空）
   * @returns {{ found: boolean, id?: string, name?: string, text?: string }}
   */
  resolvePrompt(ref, argString = '') {
    this.init();
    const raw = String(ref || '').trim();
    if (!raw) return { found: false };

    // 先按稳定 name，再 #id；最后按 display_name（UI 常用中文名如「小黑」）
    let resource = this._findByTypeName('prompt', raw);
    if (!resource) {
      const id = raw.startsWith('#') ? raw.slice(1).trim() : raw;
      const byId = id ? this.getResource(id) : null;
      if (byId && byId.type === 'prompt') resource = byId;
    }
    if (!resource) {
      const row = this._getDb().prepare(`
        SELECT id FROM resources
        WHERE type = 'prompt' AND (display_name = ? OR name = ?)
        LIMIT 1
      `).get(raw, raw);
      if (row) resource = this.getResource(row.id);
    }
    if (!resource || resource.type !== 'prompt') return { found: false };

    return {
      found: true,
      id: resource.id,
      name: resource.name,
      text: applyPromptArguments(resource.content || '', argString),
    };
  }

  /** 投射给该 client 的 prompt 轻量列表;clientId 为空 → 全部 prompt */
  listPromptsForClient(clientId) {
    this.init();
    const db = this._getDb();
    const cid = String(clientId || '').trim();
    if (!cid) {
      return db.prepare(`
        SELECT id, name, display_name, description FROM resources
        WHERE type = 'prompt' ORDER BY updated_at DESC
      `).all();
    }
    return db.prepare(`
      SELECT DISTINCT r.id, r.name, r.display_name, r.description
      FROM resources r
      JOIN resource_projections ps ON ps.resource_id = r.id
      WHERE r.type = 'prompt' AND ps.agent_id = ?
      ORDER BY r.updated_at DESC
    `).all(cid);
  }

  /** 该 client 是否有 ≥1 条 prompt 投射(决定是否给它下发 prompt MCP) */
  hasPromptProjections(clientId) {
    this.init();
    const cid = String(clientId || '').trim();
    if (!cid) return false;
    const row = this._getDb().prepare(`
      SELECT 1 FROM resource_projections ps
      JOIN resources r ON r.id = ps.resource_id
      WHERE ps.agent_id = ? AND r.type = 'prompt' LIMIT 1
    `).get(cid);
    return !!row;
  }

  /** resolvePrompt + 投射校验:仅当该 prompt 投射给 clientId 才返回;clientId 为空不过滤 */
  resolvePromptForClient(ref, argString = '', clientId = '') {
    const r = this.resolvePrompt(ref, argString);
    if (!r.found) return r;
    const cid = String(clientId || '').trim();
    if (!cid) return r;
    const row = this._getDb().prepare(
      'SELECT 1 FROM resource_projections WHERE resource_id = ? AND agent_id = ? LIMIT 1',
    ).get(r.id, cid);
    return row ? r : { found: false };
  }

  /** 投射给该 client 的智能体(武将)轻量列表;clientId 为空 → 全部 assistant */
  listAssistantsForClient(clientId) {
    this.init();
    const db = this._getDb();
    const cid = String(clientId || '').trim();
    if (!cid) {
      return db.prepare(`
        SELECT id, name, display_name, description FROM resources
        WHERE type = 'assistant' ORDER BY updated_at DESC
      `).all();
    }
    return db.prepare(`
      SELECT DISTINCT r.id, r.name, r.display_name, r.description
      FROM resources r
      JOIN resource_projections ps ON ps.resource_id = r.id
      WHERE r.type = 'assistant' AND ps.agent_id = ?
      ORDER BY r.updated_at DESC
    `).all(cid);
  }

  /** 该 client 是否有 ≥1 条智能体投射 */
  hasAssistantProjections(clientId) {
    this.init();
    const cid = String(clientId || '').trim();
    if (!cid) return false;
    const row = this._getDb().prepare(`
      SELECT 1 FROM resource_projections ps
      JOIN resources r ON r.id = ps.resource_id
      WHERE ps.agent_id = ? AND r.type = 'assistant' LIMIT 1
    `).get(cid);
    return !!row;
  }

  /** 投射给该 client 的 Skill 轻量列表;clientId 为空 → 全部 skill */
  listSkillsForClient(clientId) {
    this.init();
    const db = this._getDb();
    const cid = String(clientId || '').trim();
    if (!cid) {
      return db.prepare(`
        SELECT id, name, display_name, description FROM resources
        WHERE type = 'skill' ORDER BY updated_at DESC
      `).all();
    }
    return db.prepare(`
      SELECT DISTINCT r.id, r.name, r.display_name, r.description
      FROM resources r
      JOIN resource_projections ps ON ps.resource_id = r.id
      WHERE r.type = 'skill' AND ps.agent_id = ?
      ORDER BY r.updated_at DESC
    `).all(cid);
  }

  /** 资源是否投射给该 client(clientId 为空视为不设限,返回 true) */
  isResourceProjectedToClient(resourceId, clientId) {
    this.init();
    const cid = String(clientId || '').trim();
    if (!cid) return true;
    const row = this._getDb().prepare(
      'SELECT 1 FROM resource_projections WHERE resource_id = ? AND agent_id = ? LIMIT 1',
    ).get(resourceId, cid);
    return !!row;
  }

  /**
   * 解析智能体引用并做投射校验；返回出战全文(soul+绑定兵器)。
   * clientId 为空不过滤投射。
   */
  resolveAssistantForClient(ref, clientId = '') {
    this.init();
    const raw = String(ref || '').trim();
    if (!raw) return { found: false };

    let resource = this._findByTypeName('assistant', raw);
    if (!resource) {
      const id = raw.startsWith('#') ? raw.slice(1).trim() : raw;
      const byId = id ? this.getResource(id) : null;
      if (byId && byId.type === 'assistant') resource = byId;
    }
    if (!resource) {
      const row = this._getDb().prepare(`
        SELECT id FROM resources
        WHERE type = 'assistant' AND (display_name = ? OR name = ?)
        LIMIT 1
      `).get(raw, raw);
      if (row) resource = this.getResource(row.id);
    }
    if (!resource || resource.type !== 'assistant') return { found: false };

    const cid = String(clientId || '').trim();
    if (cid) {
      const proj = this._getDb().prepare(
        'SELECT 1 FROM resource_projections WHERE resource_id = ? AND agent_id = ? LIMIT 1',
      ).get(resource.id, cid);
      if (!proj) return { found: false };
    }

    const config = parseAssistantConfig(resource.content);
    const text = resolveAssistantContext(config, this);
    return {
      found: true,
      id: resource.id,
      name: resource.name,
      resource,
      config,
      text,
    };
  }

  /** 记录资源被 MCP/点将命中(use_count / last_used_at)，并通知主窗口息票 */
  recordResourceHit(resourceId, clientId = '') {
    this.init();
    const id = String(resourceId || '').trim();
    if (!id) return false;
    const now = Date.now();
    let ok = false;
    let useCount = 0;
    let name = '';
    let displayName = '';
    let type = '';
    try {
      const r = this._getDb().prepare(`
        UPDATE resources
        SET use_count = COALESCE(use_count, 0) + 1, last_used_at = ?, updated_at = updated_at
        WHERE id = ?
      `).run(now, id);
      ok = (r.changes || 0) > 0;
    } catch (e) {
      // 旧库尚未迁移列时降级写 metadata，避免打断点将
      try {
        const row = this._getDb().prepare('SELECT metadata FROM resources WHERE id = ?').get(id);
        if (!row) return false;
        let meta = {};
        try { meta = JSON.parse(row.metadata || '{}') || {}; } catch { meta = {}; }
        meta.use_count = Number(meta.use_count || 0) + 1;
        meta.last_used_at = now;
        this._getDb().prepare('UPDATE resources SET metadata = ? WHERE id = ?')
          .run(JSON.stringify(meta), id);
        ok = true;
      } catch {
        console.warn('[resource-manager] recordResourceHit:', e.message);
        return false;
      }
    }
    if (!ok) return false;
    try {
      const row = this._getDb().prepare(
        'SELECT name, display_name, type, use_count, metadata FROM resources WHERE id = ?',
      ).get(id);
      if (row) {
        name = row.name || '';
        displayName = row.display_name || row.name || '';
        // 残留 type=agent 时仍按 assistant 播武将特效
        type = row.type === 'agent' ? 'assistant' : (row.type || '');
        useCount = Number(row.use_count || 0) || 0;
        if (!useCount) {
          try {
            const meta = JSON.parse(row.metadata || '{}') || {};
            useCount = Number(meta.use_count || 0) || 0;
          } catch { /* ignore */ }
        }
      }
      const { notifyResourceHit } = require('./resource-hit-or-exit');
      notifyResourceHit({
        id,
        name,
        displayName,
        type,
        useCount,
        clientId: String(clientId || '').trim(),
      });
    } catch { /* 息票失败不影响点将 */ }
    return true;
  }

  /** 今日点将/取用次数(assistant+prompt)，供 Tray */
  countResourceHitsSince(sinceTs, types = ['assistant', 'prompt']) {
    this.init();
    const since = Number(sinceTs) || 0;
    const typeList = (Array.isArray(types) ? types : ['assistant', 'prompt'])
      .map((t) => String(t || '').trim())
      .filter(Boolean);
    if (!typeList.length) return 0;
    try {
      const placeholders = typeList.map(() => '?').join(',');
      const row = this._getDb().prepare(`
        SELECT COUNT(*) AS n FROM resources
        WHERE type IN (${placeholders})
          AND last_used_at IS NOT NULL AND last_used_at >= ?
      `).get(...typeList, since);
      return Number(row?.n || 0);
    } catch {
      return 0;
    }
  }

  /** Tray 快捷口令：已投射且优先近用的智能体 */
  listQuickInvokeAssistants(clientId, limit = 3) {
    this.init();
    const cid = String(clientId || '').trim();
    const lim = Math.max(1, Math.min(10, Number(limit) || 3));
    try {
      let rows;
      if (cid) {
        rows = this._getDb().prepare(`
          SELECT DISTINCT r.id, r.name, r.display_name, r.description, r.last_used_at, r.use_count
          FROM resources r
          JOIN resource_projections ps ON ps.resource_id = r.id
          WHERE r.type = 'assistant' AND ps.agent_id = ?
          ORDER BY COALESCE(r.last_used_at, 0) DESC, r.updated_at DESC
          LIMIT ?
        `).all(cid, lim);
      } else {
        rows = this._getDb().prepare(`
          SELECT id, name, display_name, description, last_used_at, use_count
          FROM resources WHERE type = 'assistant'
          ORDER BY COALESCE(last_used_at, 0) DESC, updated_at DESC
          LIMIT ?
        `).all(lim);
      }
      return rows;
    } catch {
      // 无 last_used_at 列时回退
      return this.listAssistantsForClient(cid).slice(0, lim);
    }
  }

  installFromCatalog(catalogId) {
    this.init();
    const item = getCatalogItem(catalogId);
    if (!item) throw new Error('目录项不存在');

    // 先按 type+name；再按稳定 id（避免 type 曾被误改时重复 INSERT 撞 PRIMARY KEY）
    const stableId = `res-${item.type}-${item.name}`;
    let existing = this._findByTypeName(item.type, item.name) || this.getResource(stableId);
    if (existing && existing.type !== item.type && item.type === 'assistant') {
      try {
        this._getDb().prepare(
          'UPDATE resources SET type = ?, updated_at = ? WHERE id = ?',
        ).run(item.type, Date.now(), existing.id);
        existing = this.getResource(existing.id);
      } catch (e) {
        console.warn('[resource-manager] fix resource type:', existing.id, e.message);
      }
    }
    if (existing) {
      let installedDependencies = [];
      // 内置智能体：纠正 source / metadata
      if (this._isBuiltinAssistant(existing, catalogId) || isBuiltinAssistantCatalogId(catalogId)) {
        this._markBuiltinSource(existing.id, catalogId);
      }
      // 智能体「已纳管」时仍要补齐绑定的 skill/prompt,并确保 skill 落盘可扫到
      if (item.type === 'assistant') {
        this._invalidateAgentList();
        installedDependencies = this._installAssistantCatalogDeps(item);
        try { this.syncDiscoveredSkills({ includeManaged: true }); } catch (e) {
          console.warn('[resource-manager] sync after assistant deps:', e.message);
        }
      } else if (item.type === 'skill') {
        try { this._ensureSkillOnDisk(existing.id); } catch (e) {
          console.warn('[resource-manager] ensure skill on disk:', e.message);
        }
      }
      return {
        success: true,
        resource: this.getResource(existing.id),
        alreadyInstalled: true,
        installedDependencies,
      };
    }

    const now = Date.now();
    const id = `res-${item.type}-${item.name}`;
    // Skill 不改写原文；展示统一用 name，避免与磁盘 SKILL.md 不一致
    const content = item.type === 'assistant'
      ? formatAssistantContent(item.content || '')
      : (item.content || '');
    const displayName = item.type === 'skill'
      ? item.name
      : (item.display_name || item.name);
    const builtin = !!(item.metadata && item.metadata.builtin)
      || isBuiltinAssistantCatalogId(catalogId);
    const meta = { ...(item.metadata || {}) };
    if (builtin) meta.builtin = true;
    const source = builtin ? 'builtin' : 'catalog';
    const sourceUrl = builtin ? `builtin:${catalogId}` : `catalog:${catalogId}`;
    const description = extractResourceDescription(item.type, content, {
      description: item.description || '',
      name: item.name,
    });
    const db = this._getDb();
    db.prepare(`
      INSERT INTO resources
      (id, type, name, display_name, description, content, metadata, source, source_url, hash, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      item.type,
      item.name,
      displayName,
      description,
      content,
      JSON.stringify(meta),
      source,
      sourceUrl,
      this._hashContent(content),
      now,
      now,
    );

    if (item.type === 'skill') this._ensureSkillOnDisk(id);
    let installedDependencies = [];
    if (item.type === 'assistant') {
      this._invalidateAgentList();
      installedDependencies = this._installAssistantCatalogDeps(item);
      // 级联 skill 落盘后刷进本机技能列表
      try { this.syncDiscoveredSkills({ includeManaged: true }); } catch (e) {
        console.warn('[resource-manager] sync after assistant install:', e.message);
      }
    }

    const resource = this.getResource(id);
    return { success: true, resource, alreadyInstalled: false, installedDependencies };
  }

  /**
   * 纳管智能体时，级联纳管其声明的 skill / prompt 依赖（存在于社区目录且尚未纳管者）。
   * 已在库中的 skill 也会 _ensureSkillOnDisk,保证「技能」Tab 扫描可见。
   * @returns {string[]} 新纳管依赖的 resourceId 列表
   */
  _installAssistantCatalogDeps(assistantItem) {
    const config = parseAssistantConfig(
      (assistantItem && assistantItem.content) || '',
    );

    // MCP 依赖:装进 mcp-manager(供投射时同步给运行时 agent,给智能体绑定工具如 fetch)
    // 若用户已具备同等能力(已装/已发现同工具的 MCP),则不重复安装。
    for (const mcpName of config.mcp || []) {
      try {
        const mcpCat = require('./mcp-catalog');
        const mcpManager = require('./mcp-manager');
        const item = mcpCat.getCatalogItem(mcpName);
        if (!item) continue;
        const tools = (item.metadata && item.metadata.tools) || [];
        if (this._hasMcpCapabilityTools(tools, mcpName)) continue; // 已有该能力,不用装
        mcpManager.installFromCatalog(mcpName);
      } catch (e) {
        console.warn('[resource-manager] 级联装 MCP 失败:', mcpName, e.message);
      }
    }

    const deps = [
      ...(config.skills || []).map(name => ({ type: 'skill', name })),
      ...(config.prompts || []).map(name => ({ type: 'prompt', name })),
    ];
    if (!deps.length) return [];

    const catalogItems = listCatalogItems();
    const installed = [];
    for (const dep of deps) {
      const existingDep = this._findByTypeName(dep.type, dep.name);
      if (existingDep) {
        // 已在库:技能必须落盘,否则「技能」列表(磁盘扫描)看不到
        if (dep.type === 'skill') {
          try { this._ensureSkillOnDisk(existingDep.id); } catch (e) {
            console.warn('[resource-manager] 补落盘技能失败:', dep.name, e.message);
          }
        }
        continue;
      }
      const catItem = catalogItems.find(c => c.type === dep.type && c.name === dep.name);
      if (!catItem) {
        // 扫描刚入库的本机项再查一次
        const again = this._findByTypeName(dep.type, dep.name);
        if (again) {
          if (dep.type === 'skill') {
            try { this._ensureSkillOnDisk(again.id); } catch { /* ignore */ }
          }
          continue;
        }
        // skill：目录没有属常态，执行时可由 skillhub 自装，不报错
        if (dep.type === 'skill') continue;
        // prompt：无法运行时自装，记为数据异常（每种只报一次）
        const missKey = `${assistantItem?.name || '?'}::${dep.type}:${dep.name}`;
        if (!_missingCatalogDepLogged.has(missKey)) {
          _missingCatalogDepLogged.add(missKey);
          console.error(
            '[resource-manager] 数据异常: 智能体声明的提示词既不在社区目录、本机也未纳管:',
            dep.name,
            assistantItem?.name ? `(assistant=${assistantItem.name})` : '',
          );
        }
        continue;
      }
      try {
        const r = this.installFromCatalog(catItem.catalogId);
        if (r?.resource && !r.alreadyInstalled) installed.push(r.resource.id);
        else if (r?.resource && dep.type === 'skill') {
          try { this._ensureSkillOnDisk(r.resource.id); } catch { /* ignore */ }
        }
      } catch (e) {
        console.warn('[resource-manager] 级联纳管依赖失败:', dep.name, e.message);
      }
    }
    return installed;
  }

  saveResource(data = {}) {
    this.init();
    const db = this._getDb();
    const now = Date.now();
    // 残留 type=agent 一律按 assistant 入库，避免 UNIQUE / 列表漏项
    let type = data.type || 'prompt';
    if (type === 'agent') type = 'assistant';
    const name = String(data.name || '').trim();
    if (!name) throw new Error('name 不能为空');

    const id = data.id || `res-${type}-${name.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
    let content = data.content != null ? String(data.content) : '';
    if (type === 'assistant') content = formatAssistantContent(content);
    const metadata = { ...(data.metadata || {}) };
    // Skill 入库展示名固定为 name，不改写正文
    const displayName = type === 'skill' ? name : (data.display_name || name);
    // 无说明或仍是 You are… 时，从正文自动提炼卡片简介
    const description = extractResourceDescription(type, content, {
      description: data.description || '',
      name,
    });

    const existing = db.prepare('SELECT id, source FROM resources WHERE id = ?').get(id);
    if (!existing) {
      const nameTaken = db.prepare('SELECT id FROM resources WHERE type = ? AND name = ?').get(type, name);
      if (nameTaken) throw new Error(`同名资产已存在: ${name}`);
    }

    const wasNew = !existing;
    if (existing) {
      db.prepare(`
        UPDATE resources SET
          display_name = ?, description = ?, content = ?, metadata = ?, hash = ?, updated_at = ?
        WHERE id = ?
      `).run(
        displayName,
        description,
        content,
        JSON.stringify(metadata),
        this._hashContent(content),
        now,
        id,
      );
    } else {
      db.prepare(`
        INSERT INTO resources
        (id, type, name, display_name, description, content, metadata, source, hash, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        type,
        name,
        displayName,
        description,
        content,
        JSON.stringify(metadata),
        data.source || 'local',
        this._hashContent(content),
        now,
        now,
      );
    }

    const saved = this.getResource(id);
    let installedDependencies = [];
    if (saved?.type === 'assistant') {
      this._invalidateAgentList();
      // 新建智能体时级联纳管 content 中声明的目录技能/提示词,便于在技能列表可见
      if (wasNew) {
        installedDependencies = this._installAssistantCatalogDeps({ content });
      }
    } else if (saved?.type === 'skill') {
      this._ensureSkillOnDisk(id);
    } else if (saved?.type === 'prompt') {
      // 权威源=DB:MCP 调用时实时读库,编辑后无需重刷任何文件
    }
    return { success: true, resource: this.getResource(id), installedDependencies };
  }

  /** 升级 Skill：同步到已有权威目录的 SKILL.md（软链自动生效） */
  syncSkillCanonical(resourceId) {
    this.init();
    const resource = this.getResource(resourceId);
    if (!resource || resource.type !== 'skill') throw new Error('不是 Skill 资产');
    const authorityDir = resolveAuthorityDir(resource);
    if (!authorityDir) {
      throw new Error('尚未确定权威目录，请先在本机纳管或投射到某个 Agent');
    }
    this._persistSkillAuthority(resourceId, resource, { syncContent: true });
    // 软链型投射写权威即生效；复制型不会自动同步，需重刷。
    const resynced = this._resyncCopyProjections(this.getResource(resourceId));
    return { success: true, resource: this.getResource(resourceId), ...resynced };
  }

  /**
   * 解析 Skill 权威目录（与卸载删文件逻辑一致）
   */
  _resolveSkillAuthorityDir(resource) {
    if (!resource) return null;
    const meta = resource.metadata || {};
    let authorityDir = resolveAuthorityDir(resource)
      || normalizeSkillDirPath(meta.authorityPath || meta.scannedFrom || meta.canonicalPath, resource.name)
      || null;
    if (!authorityDir) {
      const origin = (resource.projections || []).find(p =>
        p.projectionType === 'scan' || p.projectionType === 'origin',
      );
      if (origin?.targetPath) {
        authorityDir = normalizeSkillDirPath(origin.targetPath, resource.name);
      }
    }
    if (!authorityDir && resource.authorityPath) {
      authorityDir = normalizeSkillDirPath(resource.authorityPath, resource.name);
    }
    return authorityDir ? path.resolve(authorityDir) : null;
  }

  /**
   * 路径是否指向权威目录（规范化后比较）
   */
  _isAuthorityTarget(targetPath, authorityDir, resourceName) {
    if (!targetPath || !authorityDir) return false;
    const { pathsEqual } = require('./resource-canonical');
    const a = normalizeSkillDirPath(targetPath, resourceName) || targetPath;
    const b = normalizeSkillDirPath(authorityDir, resourceName) || authorityDir;
    return pathsEqual(a, b);
  }

  /**
   * 用户可点 × 取消的投射：软链/副本，或其它 Agent 上的多余实体。
   * 权威源本身、公共目录（agents-hub/custom）标记不拦截卸载。
   */
  _isRemovableProjection(proj, authorityDir, resourceName) {
    if (!proj) return false;
    // 界面不展示、也无法 × 的公共目录，不造成卸载死锁
    if (proj.agentId === 'agents-hub' || proj.agentId === 'tokenbank' || proj.agentId === 'custom' || proj.agentId === 'aweskill') {
      return false;
    }
    const t = proj.projectionType;
    if (t === 'symlink' || t === 'copy') {
      if (authorityDir && this._isAuthorityTarget(proj.targetPath, authorityDir, resourceName)) return false;
      return true;
    }
    if (t === 'scan' || t === 'origin') {
      // 无权威路径时无法区分，不拦截（避免「只有权威源却无法卸载」死锁）
      if (!authorityDir) return false;
      if (this._isAuthorityTarget(proj.targetPath, authorityDir, resourceName)) return false;
      return true;
    }
    return false;
  }

  /**
   * 卸载 Skill：真实删除权威目录（须已无可取消的投射）。
   * @returns {{ deleted: boolean, path: string|null }}
   */
  _deleteSkillFiles(resource) {
    const authorityDir = this._resolveSkillAuthorityDir(resource);
    if (!authorityDir) {
      throw new Error('无法定位 Skill 权威目录，卸载中止');
    }

    const abs = path.resolve(authorityDir);
    if (!fs.existsSync(abs)) {
      return { deleted: false, path: abs, missing: true };
    }

    try {
      const st = fs.lstatSync(abs);
      if (st.isSymbolicLink()) {
        fs.unlinkSync(abs);
      } else {
        fs.rmSync(abs, { recursive: true, force: true });
      }
    } catch (e) {
      throw new Error(`删除权威目录失败: ${e.message}`);
    }

    if (fs.existsSync(abs)) {
      throw new Error(`权威目录删除后仍存在: ${abs}`);
    }
    return { deleted: true, path: abs };
  }

  /**
   * @param {string} resourceId
   * @param {{ force?: boolean }} [options] force=true：有投射时先撤再删权威目录（强制卸载）
   */
  deleteResource(resourceId, { force = false } = {}) {
    this.init();
    const db = this._getDb();
    const resource = this.getResource(resourceId);
    if (!resource) throw new Error('资产不存在');
    if (this._isBuiltinAssistant(resource)) {
      throw new Error('内置智能体不可删除');
    }

    // Skill：默认有可取消投射则禁止；force 时自动撤投射再删文件
    if (resource.type === 'skill' && !force) {
      const authorityDir = this._resolveSkillAuthorityDir(resource);
      const blocking = (resource.projections || []).filter(p =>
        this._isRemovableProjection(p, authorityDir, resource.name),
      );
      if (blocking.length > 0) {
        throw new Error('请先取消所有投射后再卸载');
      }
    }

    const promptClientIds = resource.type === 'prompt'
      ? (resource.projections || []).map(p => p.agentId)
      : [];

    // 先撤投射（软链/副本），再删权威目录，避免残留指向已删路径的链接
    for (const proj of resource.projections || []) {
      try {
        unprojectResource(resource, proj.agentId, proj.projectionType, proj.targetPath);
      } catch {}
    }

    let deletedFiles = null;
    if (resource.type === 'skill') {
      deletedFiles = this._deleteSkillFiles(resource);
    }

    db.prepare('DELETE FROM resource_projections WHERE resource_id = ?').run(resourceId);
    db.prepare('DELETE FROM resources WHERE id = ?').run(resourceId);
    this._resyncPromptClients(promptClientIds);
    // 删除智能体后清 Debug Agent 列表缓存，避免已删智能体仍显示为 tab
    if (resource.type === 'assistant') this._invalidateAgentList();
    return { success: true, deletedFiles };
  }

  /** 清 agent-executor 的 Agent 列表缓存（智能体增删改后 Debug 立即反映） */
  _invalidateAgentList() {
    try { require('./agent-executor').invalidateAgentListCache?.(); } catch { /* ignore */ }
  }

  /** 智能体 JSON 中引用的 Prompt / Skill（须已纳管） */
  _collectAssistantDependencies(resource) {
    if (resource.type !== 'assistant') return { resources: [], missing: [] };
    const config = parseAssistantConfig(resource.content);
    const resources = [];
    const missing = [];
    const seen = new Set();

    for (const name of config.prompts || []) {
      const row = this._findByTypeName('prompt', name);
      if (!row) {
        missing.push({ type: 'prompt', name });
        continue;
      }
      if (!seen.has(row.id)) {
        seen.add(row.id);
        resources.push(this.getResource(row.id));
      }
    }
    for (const name of config.skills || []) {
      const row = this._findByTypeName('skill', name);
      // 未纳管 skill 不记 missing：执行时可 skillhub 自装
      if (!row) continue;
      if (!seen.has(row.id)) {
        seen.add(row.id);
        resources.push(this.getResource(row.id));
      }
    }
    return { resources: resources.filter(Boolean), missing };
  }

  /** 将单个资产投射到多个 Agent */
  _projectOneResourceToAgents(resource, agentIds, scope = 'global', options = {}) {
    const db = this._getDb();
    const now = Date.now();
    let workingResource = { ...resource };
    const resourceId = resource.id;

    // 先做文件系统投射并收集结果，再在单个事务里落库，避免中途失败留下半态 DB。
    const pending = [];
    for (const agentId of agentIds) {
      const existingRow = db.prepare(
        'SELECT id, projection_type, target_path FROM resource_projections WHERE resource_id = ? AND agent_id = ? AND scope = ?',
      ).get(resourceId, agentId, scope);

      const existingProjection = existingRow
        ? { projectionType: existingRow.projection_type, targetPath: existingRow.target_path }
        : null;

      const proj = projectResource(workingResource, agentId, scope, {
        existingProjection,
        force: !!options.force,
      });
      // 冲突不改变权威元数据
      if (proj.authorityPath && proj.projectionType !== 'conflict') {
        workingResource = this._mergeAuthorityMetadata(workingResource, {
          authorityPath: proj.authorityPath,
        });
      }
      pending.push({ agentId, existingRow, proj });
    }

    const results = [];
    const persist = db.transaction((entries) => {
      for (const { agentId, existingRow, proj } of entries) {
        if (existingRow) {
          db.prepare(`
            UPDATE resource_projections SET
              projection_type = ?, target_path = ?, status = ?, created_at = ?
            WHERE id = ?
          `).run(proj.projectionType, proj.targetPath, proj.status, now, existingRow.id);
          results.push({ agentId, projectionId: existingRow.id, resourceId, ...proj, updated: true });
        } else {
          const projectionId = `proj-${resourceId}-${agentId}-${scope}`;
          db.prepare(`
            INSERT INTO resource_projections
            (id, resource_id, agent_id, scope, projection_type, target_path, status, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            projectionId, resourceId, agentId, scope,
            proj.projectionType, proj.targetPath, proj.status, now,
          );
          results.push({ agentId, projectionId, resourceId, ...proj, updated: false });
        }
      }
    });
    persist(pending);

    if (resource.type === 'skill' && workingResource.metadata?.authorityPath) {
      this._persistSkillAuthority(resourceId, workingResource, {
        authorityPath: workingResource.metadata.authorityPath,
      });
    }

    return { results, workingResource };
  }

  projectToAgents(resourceId, agentIds = [], scope = 'global', options = {}) {
    this.init();
    const resource = this.getResource(resourceId);
    if (!resource) throw new Error('资产不存在');

    // 投射目标白名单：
    //  - skill 必须有 skills 目录 → 只能投到可承载 skill 的已纳管 agent
    //  - prompt / 智能体 走 MCP/中转 → 可投到任意已纳管应用（含 Trae / API 应用）
    const { listManagedResourceAgentIds, getAgentTarget } = require('./resource-agent-targets');
    let requested = [...new Set(agentIds || [])].filter(Boolean);
    let allowed;
    if (resource.type === 'skill') {
      allowed = new Set(listManagedResourceAgentIds());
    } else {
      const { listManagedAppTargetIds } = require('./mcp-gateway-targets');
      const { resolveMcpSyncClientId } = require('./mcp-agent-targets');
      // 归一到交付 cid：能映射 stdio sync client 的归一（codex-desktop→codex），其余按自身（走中转）
      requested = requested.map(id => resolveMcpSyncClientId(id) || id);
      allowed = listManagedAppTargetIds();
    }
    const ids = [...new Set(requested.filter(id => allowed.has(id)))];
    if (!ids.length) throw new Error('请至少选择一个已纳管的应用');

    // Skill 落盘只能进可承载 skill 的目标（智能体的关联 Skill 依赖同理）
    const skillHostableIds = ids.filter(id => getAgentTarget(id));

    const resourcesToProject = [resource];
    let missingDeps = [];
    if (resource.type === 'assistant') {
      const { resources, missing } = this._collectAssistantDependencies(resource);
      // prompt 依赖在运行时内联进 system 上下文(resolveAssistantContext),仅 Skill 需要落盘投射
      resourcesToProject.push(...resources.filter(r => r.type === 'skill'));
      missingDeps = missing;
    }

    const results = [];
    for (const res of resourcesToProject) {
      // skill 类资源（含智能体关联 Skill）只投到 skill-hostable 目标，避免对 Trae/API 目标物化失败
      const targetIds = res.type === 'skill' ? skillHostableIds : ids;
      if (!targetIds.length) continue;
      const batch = this._projectOneResourceToAgents(res, targetIds, scope, { force: !!options.force });
      results.push(...batch.results);
    }

    // 智能体：投射目标同步为 Debug 运行时（投到 Codex → Debug 显示 Codex）
    if (resource.type === 'assistant') {
      this._syncAssistantRuntimeFromProjections(resourceId);
      this._syncAssistantMcpToProjections(resourceId);
      // 无 stdio 通道的应用(Trae/API)：内置 resources+prompts 经中转交付(tb_list_resources / tb_get_resource)
      this._ensureRelayDelivery(ids, ['tokenbank-resources', 'tokenbank-prompts']);
    }

    // 提示词：投射后刷新受影响 client 的 MCP 配置(下发/保持 tokenbank-prompts)
    if (resource.type === 'prompt') {
      this._resyncPromptClients(ids);
    }

    const symlinkCount = results.filter(r => r.projectionType === 'symlink').length;
    const copyCount = results.filter(r => r.projectionType === 'copy').length;
    const scanCount = results.filter(r => r.projectionType === 'scan' || r.projectionType === 'origin').length;
    const conflicts = results.filter(r => r.projectionType === 'conflict');
    let hint = '提示词已投射:目标 Agent 会话可通过 MCP 工具 tb_get_prompt 按名取回(tb_list_prompts 可列出)。';
    if (resource.type === 'skill') {
      if (symlinkCount) {
        hint = 'Skill 已通过目录软链投射；权威目录保留在用户安装位置，修改该目录即可同步。';
      } else if (scanCount) {
        hint = '该 Agent 保留本机 Skill 目录作为权威源；其他 Agent 可软链指向此处。';
      } else if (copyCount) {
        hint = 'Skill 已投射（软链不可用时已回退为复制，副本不会随权威目录自动更新）。请重启 Agent 或 Reload 后生效。';
      }
    } else if (resource.type === 'assistant') {
      const depLabels = resourcesToProject.slice(1).map(r => r.display_name || r.name);
      // 说清楚：智能体本体不落盘到目标 Agent，仅在 Token Bank（Debug）内以 system 上下文运行；此处主要投射其关联 Skill。
      hint = '智能体已标记可用（本体在 Token Bank 内以上下文运行，不写入目标 Agent 目录）';
      if (depLabels.length) {
        hint += `，已同步投射关联 Skill：${depLabels.join('、')}`;
      }
      if (missingDeps.length) {
        const miss = missingDeps.map(m => `${m.name}（${RESOURCE_TYPE_LABELS[m.type] || m.type}）`).join('、');
        hint += `。以下关联项尚未纳管，请先添加：${miss}`;
      } else {
        hint += '。';
      }
    }

    if (conflicts.length) {
      const labels = conflicts.map(c => `${c.agentId}`).join('、');
      hint += `⚠️ ${conflicts.length} 处目标已存在同名的其他目录，为防误删未覆盖（${labels}）。确认可覆盖后可选「强制投射」。`;
    }

    return {
      success: true,
      resource: this.getResource(resourceId),
      results,
      hint,
      conflicts,
      projectedDependencies: resourcesToProject.slice(1).map(r => r.id),
      missingDependencies: missingDeps,
    };
  }

  /**
   * 校验某资产的所有投射是否仍健康；repair=true 时尝试重建可修复的软链。
   * @returns {{ success, resource, projections: Array }}
   */
  verifyProjections(resourceId, { repair = false } = {}) {
    this.init();
    const resource = this.getResource(resourceId);
    if (!resource) throw new Error('资产不存在');
    const db = this._getDb();
    const out = [];

    for (const proj of resource.projections || []) {
      let health = verifyProjection(resource, proj.agentId, proj.projectionType, proj.targetPath);
      let repaired = false;
      if (!health.healthy && health.repairable && repair) {
        try {
          const fixed = projectResource(resource, proj.agentId, proj.scope, {});
          db.prepare(`
            UPDATE resource_projections SET projection_type = ?, target_path = ?, status = ?, created_at = ?
            WHERE id = ?
          `).run(fixed.projectionType, fixed.targetPath, fixed.status, Date.now(), proj.projectionId || proj.id);
          health = verifyProjection(resource, proj.agentId, fixed.projectionType, fixed.targetPath);
          repaired = true;
        } catch (e) {
          health = { ...health, repairError: e.message };
        }
      }
      out.push({ ...proj, health, repaired });
    }

    return { success: true, resource: this.getResource(resourceId), projections: out };
  }

  /**
   * 权威目录升级后，重刷所有「复制」型投射（软链型无需重刷，copy 型不会自动同步）。
   */
  _resyncCopyProjections(resource) {
    if (!resource || resource.type !== 'skill') return { resynced: 0 };
    const authorityDir = resolveAuthorityDir(resource);
    if (!authorityDir) return { resynced: 0 };
    let resynced = 0;
    for (const proj of resource.projections || []) {
      if (proj.projectionType !== 'copy') continue;
      const targetDir = normalizeSkillDirPath(proj.targetPath, resource.name) || proj.targetPath;
      if (!targetDir) continue;
      try {
        fs.rmSync(targetDir, { recursive: true, force: true });
        copyDirRecursive(authorityDir, targetDir);
        resynced += 1;
      } catch (e) {
        console.warn('[resource-manager] copy resync failed:', proj.agentId, e.message);
      }
    }
    return { resynced };
  }

  unproject({ resourceId, agentId, projectionId }) {
    this.init();
    const db = this._getDb();
    let row;

    if (projectionId) {
      row = db.prepare('SELECT * FROM resource_projections WHERE id = ?').get(projectionId);
    } else if (resourceId && agentId) {
      row = db.prepare(
        'SELECT * FROM resource_projections WHERE resource_id = ? AND agent_id = ?',
      ).get(resourceId, agentId);
    }
    if (!row) throw new Error('投射记录不存在');

    const resource = this.getResource(row.resource_id);
    if (resource) unprojectResource(resource, row.agent_id, row.projection_type, row.target_path);
    db.prepare('DELETE FROM resource_projections WHERE id = ?').run(row.id);

    if (resource?.type === 'assistant') {
      this._syncAssistantRuntimeFromProjections(row.resource_id);
    }

    if (resource?.type === 'prompt') {
      this._resyncPromptClients([row.agent_id]);
    }

    return { success: true, resource: this.getResource(row.resource_id) };
  }

  /**
   * 撤掉某 client（Gateway 应用 id 或 agent_id）上的全部资源投射。
   * 磁盘卸载失败仍删库记录，避免已删应用继续占着投射标签。
   */
  unprojectAllForClient(clientId) {
    if (!clientId) return { count: 0 };
    this.init();
    const db = this._getDb();
    const rows = db.prepare('SELECT id FROM resource_projections WHERE agent_id = ?').all(clientId);
    let count = 0;
    for (const row of rows) {
      try {
        this.unproject({ projectionId: row.id });
        count += 1;
      } catch (e) {
        try { db.prepare('DELETE FROM resource_projections WHERE id = ?').run(row.id); count += 1; } catch { /* ignore */ }
        console.warn('[resource-manager] unprojectAllForClient', clientId, e.message);
      }
    }
    return { count };
  }

  /** 清掉已删除 app-* 上的资源投射残留 */
  pruneStaleDeletedAppProjections() {
    if (this._pruningStale) return { count: 0 };
    this._pruningStale = true;
    try {
      const { isDeletedAppClientId } = require('./mcp-gateway-targets');
      const db = this._getDb();
      const ids = db.prepare('SELECT DISTINCT agent_id FROM resource_projections').all()
        .map((r) => r.agent_id)
        .filter((id) => isDeletedAppClientId(id));
      let count = 0;
      for (const id of ids) count += this.unprojectAllForClient(id).count || 0;
      return { count, stale: ids };
    } finally {
      this._pruningStale = false;
    }
  }

  /**
   * 按当前投射列表同步智能体 content.runtime_agent，并刷新 Debug Agent 列表缓存
   */
  /** 已装/已发现的 MCP 里是否已提供这些工具(判断用户是否已具备该能力,避免重复安装) */
  _hasMcpCapabilityTools(toolNames, hintName) {
    try {
      const want = new Set(toolNames || []);
      if (!want.size && !hintName) return false;
      const mcpManager = require('./mcp-manager');
      const mcpCat = require('./mcp-catalog');
      const servers = (mcpManager.listServers && mcpManager.listServers()) || [];
      for (const s of servers) {
        let tools = (s.metadata && s.metadata.tools) || [];
        const cid = (s.metadata && s.metadata.catalogId) || s.catalogId;
        if ((!tools || !tools.length) && cid) {
          const it = mcpCat.getCatalogItem(cid);
          tools = (it && it.metadata && it.metadata.tools) || [];
        }
        if (tools.some(t => want.has(t))) return true;
        const hay = `${s.name || ''} ${s.id || ''}`.toLowerCase();
        if (hintName && hay.includes(String(hintName).toLowerCase())) return true;
      }
    } catch { /* ignore */ }
    return false;
  }

  /** 把智能体声明的 MCP(如 fetch)同步到它投射到的运行时 agent,给发现智能体绑定联网抓取能力。
   *  已内置该能力的运行时(如 Claude Code 自带 WebFetch)跳过,不重复绑定。 */
  _syncAssistantMcpToProjections(resourceId) {
    const resource = this.getResource(resourceId);
    if (!resource || resource.type !== 'assistant') return;
    const config = parseAssistantConfig(resource.content);
    if (!(config.mcp || []).length) return;
    // Claude Code 内置 WebFetch,视为已有 fetch 能力
    const BUILTIN_FETCH = new Set(['claude-code']);
    const wantsFetch = config.mcp.includes('fetch');
    const clientIds = [...new Set(
      (resource.projections || [])
        .map(p => p.agentId)
        .filter(id => ASSISTANT_RUNTIME_IDS.has(id))
        .filter(id => !(wantsFetch && BUILTIN_FETCH.has(id))),
    )];
    if (!clientIds.length) return;
    try {
      require('./mcp-manager').syncToClients({ clientIds });
    } catch (e) {
      console.warn('[resource-manager] 智能体 MCP 同步失败:', e.message);
    }
  }

  _syncAssistantRuntimeFromProjections(resourceId) {
    const resource = this.getResource(resourceId);
    if (!resource || resource.type !== 'assistant') return null;
    const config = parseAssistantConfig(resource.content);
    const hasRuntimeProj = (resource.projections || []).some(p => ASSISTANT_RUNTIME_IDS.has(p.agentId));
    const hasEnableProj = hasAssistantEnableProjection(resource.projections);
    // CLI 投射 → 跟投射；仅 Cursor 等启用投射 → 保留配置运行时；全取消 → 回默认
    let nextRuntime;
    if (hasRuntimeProj) {
      nextRuntime = resolveAssistantRuntimeAgent(config, resource.projections || []);
    } else if (hasEnableProj) {
      nextRuntime = config.runtime_agent || DEFAULT_RUNTIME_AGENT;
    } else {
      nextRuntime = DEFAULT_RUNTIME_AGENT;
    }
    if (!nextRuntime || nextRuntime === config.runtime_agent) {
      try { require('./agent-executor').invalidateAgentListCache?.(); } catch { /* ignore */ }
      return resource;
    }
    const content = withAssistantRuntimeAgent(resource.content, nextRuntime);
    const now = Date.now();
    const hash = this._hashContent(content);
    this._getDb().prepare(`
      UPDATE resources SET content = ?, hash = ?, updated_at = ? WHERE id = ?
    `).run(content, hash, now, resourceId);
    try { require('./agent-executor').invalidateAgentListCache?.(); } catch { /* ignore */ }
    return this.getResource(resourceId);
  }

  /** Skill / Prompt / 智能体投射目标：已纳管应用（同源） */
  listAgentTargets() {
    const { listManagedResourceAgentIds } = require('./resource-agent-targets');
    const allowed = new Set(listManagedResourceAgentIds());
    return Object.values(AGENT_RESOURCE_TARGETS)
      .filter(t => allowed.has(t.id))
      .map(t => ({
        id: t.id,
        label: t.label,
        skillRoot: t.getSkillRoot(),
      }));
  }

  /** 智能体投射目标：与 Skill 相同（已纳管）；runtime 能力见 listAssistantRuntimeAgentIds */
  listAssistantAgentTargets() {
    return this.listAgentTargets();
  }

  /**
   * prompt 投射目标 = 已纳管应用（与 Skill / 智能体一致）
   */
  listPromptAgentTargets() {
    return this.listAgentTargets();
  }

  /** prompt 投射变更后刷新对应 client 的 MCP 配置(失败仅告警,不阻断) */
  _resyncPromptClients(clientIds) {
    const ids = [...new Set(clientIds || [])].filter(Boolean);
    if (!ids.length) return;
    try {
      require('./mcp-manager').syncToClients({ clientIds: ids });
    } catch (e) {
      console.warn('[resource-manager] prompt MCP re-sync failed:', e.message);
    }
    // 无 stdio 写盘通道的应用(Trae / API)：把内置 prompts 绑到内置中转，按 cid 交付
    this._ensureRelayDelivery(ids, ['tokenbank-prompts']);
  }

  /**
   * 为没有 stdio 写盘通道的已纳管应用（Trae / API 应用）绑定内置 MCP 到内置中转，
   * 使其经 HTTP 中转（/mcp/{cid}）按投射集取到 prompt / resources。stdio 应用不受影响。
   */
  _ensureRelayDelivery(clientIds, serverIds) {
    try {
      const { listSyncEnabledClientIds, resolveMcpSyncClientId } = require('./mcp-agent-targets');
      const stdio = new Set(listSyncEnabledClientIds());
      const relayCids = [...new Set(clientIds || [])]
        .map((id) => resolveMcpSyncClientId(id) || id)
        .filter((id) => id && !stdio.has(id));
      if (!relayCids.length) return;
      const mcp = require('./mcp-manager');
      for (const serverId of serverIds) {
        try {
          mcp.setServerGatewayRouted(serverId, true, relayCids);
        } catch (e) {
          console.warn('[resource-manager] relay bind failed:', serverId, e.message);
        }
      }
    } catch (e) {
      console.warn('[resource-manager] ensure relay delivery failed:', e.message);
    }
  }

  /** 规范化 Skill 扫描参数（默认目录始终扫；customDirs 为用户补充目录） */
  _buildSkillScanOptions(filters = {}) {
    const customDirs = (filters.customDirs || [])
      .map(d => String(d || '').trim())
      .filter(Boolean);
    return { customDirs };
  }

  _applyScanOptions(filters = {}) {
    this._lastScanOptions = this._buildSkillScanOptions(filters);
    return this._lastScanOptions;
  }

  _getActiveScanOptions(filters = {}) {
    if (filters.customDirs || filters.scanScope) {
      return this._applyScanOptions(filters);
    }
    return this._lastScanOptions;
  }

  /** 列出当前全部扫描监控目录（默认 + 用户添加） */
  listScanRoots(filters = {}) {
    this.init();
    const { listDefaultSkillScanRoots } = require('./resource-skill-scanner');
    const opts = this._getActiveScanOptions(filters);
    const defaults = listDefaultSkillScanRoots();
    const customs = (opts.customDirs || []).map((d) => {
      const p = path.resolve(String(d || '').trim());
      return {
        id: `custom:${p}`,
        label: path.basename(p) || p,
        path: p,
        kind: 'custom',
        exists: (() => { try { return fs.existsSync(p); } catch { return false; } })(),
      };
    });
    return { success: true, roots: [...defaults, ...customs] };
  }

  /** 扫描本机 Agent / aweskill 已有 Skill，排除已纳管项
   * @param {object} filters
   * @param {{ rawEntries?: object[], grouped?: object[] }} [prefetched] 复用已扫结果，避免二次读盘
   */
  listDiscoveredSkills(filters = {}, prefetched = null) {
    this.init();
    const scanOptions = this._applyScanOptions(filters);
    const managed = this.listResources({ type: 'skill' });
    const managedByName = new Map(managed.map(r => [r.name, r]));
    const grouped = Array.isArray(prefetched?.grouped)
      ? prefetched.grouped
      : groupDiscoveredSkills(
        Array.isArray(prefetched?.rawEntries)
          ? prefetched.rawEntries
          : scanAllAgentSkills(scanOptions),
      );
    const projById = this._getProjectionsByResourceId();

    let items = grouped.map(g => {
      const managedRes = managedByName.get(g.name);
      const managed = !!managedRes;
      const contentChanged = managedRes && managedRes.hash && managedRes.hash !== g.hash;
      // Skill 展示统一用 name，不改写原始文件、不套推荐中文名
      const display_name = g.name;
      // 说明:库内为空时回退扫描结果(不少 SkillHub 包无 YAML description)
      const description = String(managedRes?.description || '').trim()
        || String(g.description || '').trim()
        || '';
      return {
        ...g,
        display_name,
        description,
        // 列表不带全文，预览时再读；大幅减轻 IPC/渲染
        content: '',
        managed,
        contentChanged,
        resourceId: managedRes?.id || null,
        // 纳管时间(未纳管为 0,排序靠后)
        created_at: managedRes?.created_at || 0,
        updated_at: managedRes?.updated_at || 0,
        // 权威目录（具体 skill 路径），供前端展示
        authorityPath: managedRes?.metadata?.authorityPath
          || g.agents?.[0]?.skillDir
          || (g.agents?.[0]?.skillPath ? path.dirname(g.agents[0].skillPath) : null),
        // 附上当前投射目标（前端「已安装」页展示软链映射）
        projections: managedRes ? (projById.get(managedRes.id) || []) : [],
      };
    });

    // 默认只展示未纳管；includeManaged 时一并展示（含内容变更）
    if (!filters.includeManaged) {
      items = items.filter(i => !i.managed || i.contentChanged);
    }
    if (filters.query) {
      const q = String(filters.query).toLowerCase();
      items = items.filter(i =>
        i.name.toLowerCase().includes(q)
        || (i.display_name || '').toLowerCase().includes(q)
        || (i.description || '').toLowerCase().includes(q),
      );
    }

    // 按纳管时间倒序;未纳管的按名称排在后面
    items.sort((a, b) => {
      const ta = Number(a.created_at || 0);
      const tb = Number(b.created_at || 0);
      if (tb !== ta) return tb - ta;
      return String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN');
    });

    const { listDefaultSkillScanRoots } = require('./resource-skill-scanner');
    const scanStats = {
      totalOnDisk: grouped.length,
      managedCount: grouped.filter(g => managedByName.has(g.name)).length,
      pendingCount: items.filter(i => !i.managed).length,
      customDirs: scanOptions.customDirs,
      // 供前端列出全部监控目录（默认 + 自添）
      defaultRoots: listDefaultSkillScanRoots(),
    };

    return { items, scanStats };
  }

  /**
   * `.agents`（agents-hub）协议目录下的 skill：默认投射到本机已安装 Agent。
   * 用 metadata.autoProjectedFromAgentsHub 只尝试一次，避免用户撤投射后被同步加回。
   * 项目内 / 自定义扫描根下的 .agents/skills 不自动投到全局 Agent 目录。
   */
  _maybeAutoProjectFromAgentsHub(resourceId, group) {
    // 仅认全局 ~/.agents/skills；同 hash 的项目内/自定义根副本不触发、也不拦截
    const hubAgents = (group?.agents || []).filter((a) => (
      a.agentId === 'agents-hub'
      && !a.projectRoot
      && !a.customScanRoot
      && a.scope !== 'project'
      && a.scope !== 'custom'
    ));
    if (!hubAgents.length || !resourceId) return;

    const resource = this.getResource(resourceId);
    if (!resource) return;
    const meta = resource.metadata && typeof resource.metadata === 'object' ? resource.metadata : {};
    if (meta.autoProjectedFromAgentsHub) return;

    const db = this._getDb();
    const now = Date.now();
    // 先打标，防止投射抛错或下次 sync 反复尝试
    const nextMeta = { ...meta, autoProjectedFromAgentsHub: true };
    db.prepare('UPDATE resources SET metadata = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(nextMeta), now, resourceId);

    const already = new Set(
      (db.prepare(
        'SELECT agent_id FROM resource_projections WHERE resource_id = ? AND status = ?',
      ).all(resourceId, 'active') || []).map((r) => r.agent_id),
    );
    const targets = listSkillProjectableAgentIds().filter((aid) => !already.has(aid));
    if (!targets.length) return;

    try {
      this.projectToAgents(resourceId, targets, 'global', { force: false });
    } catch (e) {
      console.warn('[resource-manager] auto-project from .agents failed:', e?.message || e);
    }
  }

  /** 将扫描到的本机 Skill 纳管进 Token Bank（不移动原文件，记录 scan 投射） */
  /**
   * 把单个扫描分组写入 resources 并建立 scan 投射。
   * 单个纳管与批量同步共用；updateIfExists=false 且已存在时跳过写入。
   * @returns {{ id: string, updated: boolean, skipped: boolean }}
   */
  _importDiscoveredGroup(group, entry, { updateIfExists = false } = {}) {
    const existing = this._findByTypeName('skill', group.name);
    if (existing && !updateIfExists) {
      this._maybeAutoProjectFromAgentsHub(existing.id, group);
      return { id: existing.id, updated: false, skipped: true };
    }

    const now = Date.now();
    const id = existing?.id || `res-skill-${group.name}`;
    const db = this._getDb();
    const sourceDir = entry.skillDir || path.dirname(entry.skillPath);
    const authorityPath = path.resolve(sourceDir);
    // 已打标（含 AI 用途）优先保留，避免扫描同步用空 frontmatter 覆盖后重复打标
    const existingTags = Array.isArray(existing?.metadata?.tags) ? existing.metadata.tags : [];
    const scannedTags = Array.isArray(entry.metadata?.tags) ? entry.metadata.tags : [];
    const metadata = {
      ...(existing?.metadata || {}),
      tags: existingTags.length ? existingTags : scannedTags,
      authorityPath,
      scannedFrom: authorityPath,
      originAgents: group.agents.map(a => a.agentId),
    };
    const source = `agent:${entry.agentId}`;
    // 不改写原始 Skill；展示名与入库名一律用 skill name
    const nextDisplayName = group.name;
    // 已有像样说明优先保留；空或 You are… 角色句则从扫描正文提炼
    const scannedDesc = String(group.description || '').trim();
    const existingDesc = String(existing?.description || '').trim();
    const refinedDesc = extractResourceDescription('skill', entry.content || '', {
      description: scannedDesc || existingDesc,
      name: group.name,
    });
    const nextDescription = shouldReplaceDescription(existingDesc, refinedDesc)
      ? refinedDesc
      : (existingDesc || refinedDesc || scannedDesc);
    const nextContent = entry.content || '';

    if (existing) {
      db.prepare(`
        UPDATE resources SET
          display_name = ?, description = ?, content = ?, metadata = ?, source = ?, hash = ?, updated_at = ?
        WHERE id = ?
      `).run(
        nextDisplayName,
        nextDescription,
        nextContent,
        JSON.stringify(metadata),
        source,
        scanHashContent(nextContent),
        now,
        id,
      );
    } else {
      db.prepare(`
        INSERT INTO resources
        (id, type, name, display_name, description, content, metadata, source, source_url, hash, created_at, updated_at)
        VALUES (?, 'skill', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        group.name,
        nextDisplayName,
        nextDescription,
        nextContent,
        JSON.stringify(metadata),
        source,
        entry.skillPath,
        scanHashContent(nextContent),
        now,
        now,
      );
    }

    this._persistSkillAuthority(id, this.getResource(id), { authorityPath });

    // 为本机已有该 Skill 的 Agent 建立 scan 投射（不替换原目录）
    // 注意：已有 symlink/copy 是用户主动投射，扫描不得降级成 scan（否则取消后易被误扫回）
    for (const agent of group.agents) {
      const targetDir = agent.skillDir || path.dirname(agent.skillPath);
      const projId = `proj-${id}-${agent.agentId}-global`;
      const existingProj = db.prepare(
        'SELECT id, projection_type FROM resource_projections WHERE resource_id = ? AND agent_id = ? AND scope = ?',
      ).get(id, agent.agentId, 'global');

      if (existingProj) {
        const keepManaged = existingProj.projection_type === 'symlink'
          || existingProj.projection_type === 'copy';
        if (keepManaged) continue;
        db.prepare(`
          UPDATE resource_projections SET
            projection_type = 'scan', target_path = ?, status = 'active', created_at = ?
          WHERE id = ?
        `).run(targetDir, now, existingProj.id);
      } else {
        db.prepare(`
          INSERT INTO resource_projections
          (id, resource_id, agent_id, scope, projection_type, target_path, status, created_at)
          VALUES (?, ?, ?, 'global', 'scan', ?, 'active', ?)
        `).run(projId, id, agent.agentId, targetDir, now);
      }
    }

    // 协议目录 ~/.agents/skills：纳管后默认投射到已安装应用
    this._maybeAutoProjectFromAgentsHub(id, group);

    return { id, updated: !!existing, skipped: false };
  }

  importDiscoveredSkill({ scanKey, updateIfExists = false } = {}) {
    this.init();
    const scanOptions = this._lastScanOptions;
    const group = findScanGroupByScanKey(scanKey, scanOptions);
    if (!group) throw new Error('未找到该 Skill，请重新扫描');

    const entry = scanAllAgentSkills(scanOptions).find(i => i.scanKey === group.scanKey)
      || scanAllAgentSkills(scanOptions).find(i => i.name === group.name && i.hash === group.hash);
    if (!entry) throw new Error('无法读取 Skill 文件');

    const { id, updated, skipped } = this._importDiscoveredGroup(group, entry, { updateIfExists });
    if (skipped) {
      return { success: true, resource: this.getResource(id), alreadyInstalled: true };
    }

    return {
      success: true,
      resource: this.getResource(id),
      alreadyInstalled: false,
      updated,
      hint: '已纳管本机 Skill，权威目录保留在原安装位置；可在「本机」页软链投射到其他 Agent。',
    };
  }

  /**
   * 扫描即纳管：把所有本机 Skill 静默纳管（未纳管→纳管，内容变更→更新），
   * 返回统一的本机 Skill 列表（均已纳管、带 resourceId + projections）。
   * 同时补齐智能体 content.skills 中的目录技能落盘,避免「绑定了但技能 Tab 看不到」。
   */
  syncDiscoveredSkills(filters = {}) {
    this.init();
    // 1) 先扫本机并纳管，再补智能体依赖——避免「本机有 skill、目录没有」被误判为缺失
    const scanOptions = this._applyScanOptions(filters);
    const rawEntries = scanAllAgentSkills(scanOptions);
    const grouped = groupDiscoveredSkills(rawEntries);
    // 轻量已纳管索引（勿走 listResources，避免同步阶段再拉全量投射/正文）
    const managedByName = new Map(
      this._getDb().prepare(
        "SELECT id, name, hash, description FROM resources WHERE type = 'skill'",
      ).all().map((r) => [r.name, r]),
    );

    let imported = 0;
    let updated = 0;
    for (const group of grouped) {
      const managedRes = managedByName.get(group.name);
      const contentChanged = managedRes && managedRes.hash && managedRes.hash !== group.hash;
      // 已纳管但说明为空（或只剩误解析的 `|`）、扫描已补出正文说明 → 回写库
      const descMissing = managedRes
        && isBlankCardDesc(managedRes.description)
        && !isBlankCardDesc(group.description);
      if (managedRes && !contentChanged && !descMissing) {
        // 已纳管未变更：仍尝试一次 .agents 默认投射（幂等，靠 metadata 防重）
        this._maybeAutoProjectFromAgentsHub(managedRes.id, group);
        continue;
      }

      const entry = rawEntries.find(i => i.scanKey === group.scanKey)
        || rawEntries.find(i => i.name === group.name && i.hash === group.hash);
      if (!entry) continue;

      this._importDiscoveredGroup(group, entry, { updateIfExists: !!(contentChanged || descMissing) });
      if (managedRes) updated += 1;
      else imported += 1;
    }

    // 2) 再按智能体声明补齐目录依赖；此时本机 skill 应已入库
    try {
      for (const a of this.listResources({ type: 'assistant' })) {
        this._installAssistantCatalogDeps(a);
      }
    } catch (e) {
      console.warn('[resource-manager] ensure assistant skill deps:', e.message);
    }

    // 复用本次扫盘结果，禁止 listDiscoveredSkills 再扫一遍
    const { items, scanStats } = this.listDiscoveredSkills(
      { ...filters, includeManaged: true },
      { rawEntries, grouped },
    );
    return { success: true, imported, updated, items, scanStats };
  }

  /**
   * 用 skillhub CLI 把技能装到 ~/.agents/skills,并同步进已纳管列表。
   * 不依赖发现智能体口头确认,以磁盘 SKILL.md 存在为准。
   * @param {string} slug
   * @param {{ force?: boolean, description?: string }} [opts]
   */
  async installSkillhubSkill(slug, { force = false, description = '' } = {}) {
    this.init();
    const name = String(slug || '').trim();
    if (!name) throw new Error('slug 不能为空');

    fs.mkdirSync(SKILL_HUB_ROOT, { recursive: true });
    const targetDir = path.join(SKILL_HUB_ROOT, name);
    const skillMd = ['SKILL.md', 'skill.md']
      .map((f) => path.join(targetDir, f))
      .find((p) => fs.existsSync(p));

    if (!skillMd || force) {
      await new Promise((resolve, reject) => {
        const args = ['install', name, '--dir', SKILL_HUB_ROOT, '--json'];
        if (force) args.push('--force');
        execFile('skillhub', args, {
          timeout: 180000,
          maxBuffer: 8 * 1024 * 1024,
          windowsHide: true,
          shell: process.platform === 'win32',
          env: process.env,
        }, (err, stdout, stderr) => {
          if (err) {
            const detail = String(stderr || stdout || err.message || '').replace(/\s+/g, ' ').trim().slice(0, 400);
            reject(new Error(detail || `skillhub install ${name} failed`));
            return;
          }
          resolve({ stdout, stderr });
        });
      });
    }

    const skillMdAfter = ['SKILL.md', 'skill.md']
      .map((f) => path.join(targetDir, f))
      .find((p) => fs.existsSync(p));
    if (!skillMdAfter) {
      throw new Error(`安装后未找到 ${name}/SKILL.md,未写入技能列表`);
    }

    // 扫描即纳管,确保出现在「已纳管」技能列表
    this.syncDiscoveredSkills({ includeManaged: true });

    let resource = this._findByTypeName('skill', name);
    if (!resource) {
      // frontmatter name 可能与 slug 目录名不同,按路径导入
      const imported = this.importFromPath({ sourcePath: targetDir, type: 'skill' });
      resource = imported && imported.resource;
    }
    if (!resource) throw new Error(`技能 ${name} 已落盘但纳管失败`);

    // 推荐卡说明写入库(SKILL.md 常无 YAML description)
    const hint = String(description || '').trim();
    if (hint && !(resource.description || '').trim()) {
      const db = this._getDb();
      db.prepare('UPDATE resources SET description = ?, updated_at = ? WHERE id = ?')
        .run(hint, Date.now(), resource.id);
      resource = this.getResource(resource.id);
    }

    return {
      success: true,
      resource: this.getResource(resource.id),
      skillDir: targetDir,
      alreadyInstalled: !!skillMd && !force,
    };
  }

  /** 批量安装 SkillHub 技能(逐个;单个失败不中断后续) */
  async installSkillhubSkills(slugs = []) {
    const results = [];
    for (const raw of slugs || []) {
      const slug = String(raw || '').trim();
      if (!slug) continue;
      try {
        const r = await this.installSkillhubSkill(slug);
        results.push({ slug, success: true, resourceId: r.resource && r.resource.id, alreadyInstalled: r.alreadyInstalled });
      } catch (e) {
        results.push({ slug, success: false, error: e.message || String(e) });
      }
    }
    const ok = results.filter((r) => r.success).length;
    return {
      success: ok > 0 && results.every((r) => r.success),
      installed: ok,
      failed: results.length - ok,
      results,
    };
  }

  /**
   * 从 GitHub URL / owner/repo 安装 Skill（skillhub 无法把 GitHub URL 当 slug）。
   * 默认落到 ~/.tokenbank/skills，再扫描纳管。
   * @param {string} source 用户输入或 GitHub URL
   * @param {{ force?: boolean, description?: string, installRoot?: string }} [opts]
   */
  async installGithubSkill(source, { force = false, description = '', installRoot } = {}) {
    this.init();
    const ref = parseGithubSkillRef(source);
    if (!ref) {
      throw new Error('无法识别 GitHub Skill 地址（需要 https://github.com/owner/repo）');
    }

    const landed = await materializeGithubSkill(ref, {
      force,
      installRoot: installRoot || TOKENBANK_SKILL_ROOT,
    });

    this.syncDiscoveredSkills({ includeManaged: true });

    let resource = this._findByTypeName('skill', landed.skillName);
    if (!resource) {
      const imported = this.importFromPath({ sourcePath: landed.skillDir, type: 'skill' });
      resource = imported && imported.resource;
    }
    if (!resource) {
      // frontmatter name 可能与目录名不同，按路径再扫一次
      this.syncDiscoveredSkills({ includeManaged: true });
      resource = this._findByTypeName('skill', landed.skillName);
    }
    if (!resource) throw new Error(`技能 ${landed.skillName} 已落盘但纳管失败`);

    const hint = String(description || '').trim();
    if (hint && !(resource.description || '').trim()) {
      const db = this._getDb();
      db.prepare('UPDATE resources SET description = ?, updated_at = ? WHERE id = ?')
        .run(hint, Date.now(), resource.id);
      resource = this.getResource(resource.id);
    }
    // 记下来源：多设备同步时另一台可以按同一地址装，分享推荐也据此认出不是自己写的
    if (resource.metadata?.github_source !== ref.sourceUrl) {
      const db = this._getDb();
      db.prepare('UPDATE resources SET metadata = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify({ ...(resource.metadata || {}), github_source: ref.sourceUrl }), Date.now(), resource.id);
    }

    return {
      success: true,
      resource: this.getResource(resource.id),
      skillDir: landed.skillDir,
      skillName: landed.skillName,
      sourceUrl: ref.sourceUrl,
      alreadyInstalled: !!landed.alreadyInstalled,
    };
  }

  getPostProjectHint(resourceType, agentIds = []) {
    if (resourceType === 'skill') {
      return 'Skill 已软链指向用户安装目录；修改该目录内容后各 Agent 自动同步。';
    }
    if (agentIds.length) {
      return '已在 Token Bank 关联所选 Agent；Prompt / Assistant 的 Debug 选用能力将在编排页接入。';
    }
    return '';
  }

  /** 各 Agent skills 目录中的 Skill 安装情况 */
  listAgentInstallations(filters = {}) {
    this.init();
    const scanOptions = this._getActiveScanOptions(filters);
    const managed = this.listResources({ type: 'skill' });
    const managedByName = new Map(managed.map(r => [r.name, r]));
    const scanIndex = buildAgentSkillScanIndex(scanOptions);
    const db = this._getDb();

    const projRows = db.prepare(`
      SELECT p.*, r.name AS skill_name, r.display_name
      FROM resource_projections p
      JOIN resources r ON r.id = p.resource_id
      WHERE r.type = 'skill'
    `).all();
    const projByAgentSkill = new Map();
    for (const row of projRows) {
      projByAgentSkill.set(`${row.agent_id}:${row.skill_name}`, row);
    }

    const buildItems = (agentId, keyMap) => {
      const items = [];
      for (const [mapKey, scanItem] of keyMap) {
        const skillKey = scanItem.name;
        const resource = managedByName.get(skillKey);
        const projRow = projByAgentSkill.get(`${agentId}:${skillKey}`);
        let source = 'client';
        let resourceId = null;
        // 展示统一用 skill name，不改写原始文件
        let displayName = skillKey;
        let projectionType = null;
        const projectRoot = scanItem.projectRoot || null;
        const customScanRoot = scanItem.customScanRoot || null;
        const itemKey = mapKey;

        if (projRow) {
          resourceId = projRow.resource_id;
          displayName = skillKey;
          projectionType = projRow.projection_type;
          source = projectionType === 'scan' ? 'tb_scanned' : 'tb_sync';
        } else if (resource) {
          source = 'tb_scanned';
          resourceId = resource.id;
          displayName = skillKey;
        }

        const descBase = scanItem.description
          || (source === 'client' ? '客户端自配 Skill' : (resource?.description || displayName));
        let description = descBase;
        if (projectRoot) description = `${descBase} · 项目 ${path.basename(projectRoot)}`;
        else if (customScanRoot) description = `${descBase} · ${customScanRoot}`;

        items.push({
          itemKey,
          skillKey,
          clientKey: skillKey,
          scanKey: scanItem.scanKey,
          displayName,
          resourceId,
          managed: !!resource || source !== 'client',
          source,
          projectionType,
          isSymlink: scanItem.isSymlink,
          skillDir: scanItem.skillDir,
          skillPath: scanItem.skillPath,
          projectRoot,
          customScanRoot,
          scope: scanItem.scope || (scanItem.customScanRoot ? 'custom' : 'global'),
          description,
        });
      }
      items.sort((a, b) => a.displayName.localeCompare(b.displayName, 'zh-CN'));
      return items;
    };

    const agents = Object.entries(AGENT_RESOURCE_TARGETS).map(([agentId, target]) => {
      const skillRoot = target.getSkillRoot();
      const items = buildItems(agentId, scanIndex[agentId] || new Map());
      return {
        id: agentId,
        label: target.label,
        path: skillRoot,
        exists: fs.existsSync(skillRoot),
        syncEnabled: true,
        count: items.length,
        items,
      };
    });

    // 公共目录（.agents / .tokenbank）与扫描面板默认行对齐，附带技能数
    const { EXTRA_SKILL_ROOTS } = require('./resource-skill-scanner');
    for (const extra of EXTRA_SKILL_ROOTS) {
      const skillRoot = extra.getSkillRoot();
      const items = buildItems(extra.agentId, scanIndex[extra.agentId] || new Map());
      agents.push({
        id: extra.agentId,
        label: extra.label,
        path: skillRoot,
        exists: fs.existsSync(skillRoot),
        syncEnabled: false,
        count: items.length,
        items,
      });
    }

    if (scanOptions.customDirs?.length && scanIndex.custom?.size) {
      const items = buildItems('custom', scanIndex.custom);
      agents.unshift({
        id: 'custom',
        label: '用户添加的目录',
        path: scanOptions.customDirs.join(' · ') || '—',
        exists: true,
        syncEnabled: false,
        count: items.length,
        items,
      });
    }

    return agents;
  }

  /** 将 Agent 上的自配 Skill 纳管到 Token Bank */
  importFromAgent({ agentId, skillKey, clientKey, scanKey, projectRoot }) {
    this.init();
    const key = String(skillKey || clientKey || '').trim();
    if (!agentId || !key) throw new Error('缺少 agentId 或 skillKey');
    if (scanKey) return this.importDiscoveredSkill({ scanKey });
    if (projectRoot) {
      const { projectRootToken } = require('./resource-skill-scanner');
      return this.importDiscoveredSkill({
        scanKey: `${agentId}::project::${projectRootToken(projectRoot)}::${key}`,
      });
    }
    return this.importDiscoveredSkill({ scanKey: `${agentId}::${key}` });
  }

  /**
   * 从指定 Agent 移除此 Skill（不影响 TB 纳管及其他 Agent）
   * @param {boolean} [external] 客户端自配 Skill
   */
  removeFromAgent({ resourceId, agentId, skillKey, clientKey, external = false }) {
    this.init();
    const key = String(skillKey || clientKey || '').trim();
    if (!agentId || !key) throw new Error('缺少 agentId 或 skillKey');

    removeRawAgentSkill(agentId, key, { ignoreMissing: external });

    const resolvedId = resourceId || this._findByTypeName('skill', key)?.id;
    if (resolvedId && !external) {
      try {
        const row = this._getDb().prepare(
          'SELECT id FROM resource_projections WHERE resource_id = ? AND agent_id = ?',
        ).get(resolvedId, agentId);
        if (row) this.unproject({ resourceId: resolvedId, agentId });
      } catch {}
    } else if (resolvedId) {
      try { this.unproject({ resourceId: resolvedId, agentId }); } catch {}
    }

    return { success: true, resource: resolvedId ? this.getResource(resolvedId) : null };
  }

  /** 从本机文件或 Skill 目录导入资源（不复制 Skill 目录，仅登记权威路径） */
  importFromPath({ sourcePath, type: forcedType } = {}) {
    this.init();
    const src = path.resolve(String(sourcePath || '').trim());
    if (!src || !fs.existsSync(src)) throw new Error('路径不存在');

    const st = fs.lstatSync(src);
    if (st.isDirectory()) {
      return this._importSkillDirectory(src, forcedType);
    }
    if (!st.isFile()) throw new Error('请选择文件或 Skill 目录');

    return this._importTextFile(src, forcedType);
  }

  _importSkillDirectory(dir, forcedType) {
    if (forcedType && forcedType !== 'skill') {
      throw new Error('目录导入仅适用于 Skill');
    }

    const { parseSkillFrontmatter, extractSkillDescription } = require('./resource-skill-scanner');
    const skillMd = ['SKILL.md', 'skill.md'].map(f => path.join(dir, f)).find(p => fs.existsSync(p));
    if (!skillMd) throw new Error('目录中未找到 SKILL.md');

    const content = fs.readFileSync(skillMd, 'utf8');
    const fm = parseSkillFrontmatter(content);
    const name = String(fm.name || path.basename(dir)).trim();
    if (!name) throw new Error('无法确定 Skill 名称');

    const existing = this._findByTypeName('skill', name);
    if (existing) {
      return { success: true, resource: this.getResource(existing.id), alreadyInstalled: true };
    }

    const authorityPath = path.resolve(dir);
    const tags = fm.tags ? String(fm.tags).split(/[,\s]+/).filter(Boolean) : [];
    const result = this.saveResource({
      type: 'skill',
      name,
      display_name: name,
      description: extractSkillDescription(content, fm),
      content,
      source: 'imported',
      metadata: {
        tags,
        authorityPath,
        scannedFrom: authorityPath,
        importedFrom: authorityPath,
      },
    });
    this._persistSkillAuthority(result.resource.id, result.resource, { authorityPath });
    return {
      ...result,
      alreadyInstalled: false,
      hint: '已导入 Skill 目录，权威位置保留在原路径；可在「已纳管」页投射到其他 Agent。',
    };
  }

  _importTextFile(filePath, forcedType) {
    const { parseSkillFrontmatter } = require('./resource-skill-scanner');
    const content = fs.readFileSync(filePath, 'utf8');
    const fm = parseSkillFrontmatter(content);
    const baseName = path.basename(filePath, path.extname(filePath));
    const isSkillMd = /^skill\.md$/i.test(path.basename(filePath));

    let type = forcedType || 'prompt';
    if (!forcedType && content.trimStart().startsWith('{')) {
      try {
        const obj = JSON.parse(content);
        if (obj.soul || obj.system_prompt || obj.systemPrompt) type = 'assistant';
        else if (isSkillMd || obj.name) type = 'skill';
      } catch {
        // ignore
      }
    } else if (!forcedType && (isSkillMd || (fm.name && content.trimStart().startsWith('---')))) {
      type = 'skill';
    }

    const name = String(fm.name || baseName).trim().replace(/[^a-zA-Z0-9_-]/g, '-');
    if (!name) throw new Error('无法确定资产名称');

    const existing = this._findByTypeName(type, name);
    if (existing) {
      return { success: true, resource: this.getResource(existing.id), alreadyInstalled: true };
    }

    const metadata = {
      tags: fm.tags ? String(fm.tags).split(/[,\s]+/).filter(Boolean) : [],
      importedFrom: filePath,
    };

    if (type === 'skill' && isSkillMd) {
      const authorityPath = path.resolve(path.dirname(filePath));
      metadata.authorityPath = authorityPath;
      metadata.scannedFrom = authorityPath;
    }

    const result = this.saveResource({
      type,
      name,
      display_name: type === 'skill' ? name : (fm.name || baseName || name),
      description: extractResourceDescription(type, content, {
        description: fm.description || '',
        name,
        fm,
      }),
      content,
      source: 'imported',
      metadata,
    });

    if (type === 'skill' && metadata.authorityPath) {
      this._persistSkillAuthority(result.resource.id, result.resource, {
        authorityPath: metadata.authorityPath,
      });
    }

    return {
      ...result,
      alreadyInstalled: false,
      hint: type === 'skill'
        ? '已导入 Skill 文件；可在「已纳管」页投射到其他 Agent。'
        : '已导入到 Token Bank。',
    };
  }

  /**
   * 扫描闲置资源（默认 60 天无命中）：Skill + 智能体
   * 智能体以 use_count/last_used_at 为准；Skill 仍走会话调用扫描
   * @param {{ days?: number }} options
   */
  listIdleSkills(options = {}) {
    this.init();
    // 打开清理面板前尽量同步一次 Skill 调用入库
    try {
      const { syncSkillUsage } = require('./session-skill-usage');
      syncSkillUsage(localStats);
    } catch (e) {
      console.warn('[resource-manager] syncSkillUsage:', e.message);
    }
    const { listIdleSkills } = require('./resource-skill-cleanup');
    const { classifyLifecycle, isLifecycleExempt } = require('./resource-hit-or-exit');
    const skills = this.listResources({ type: 'skill' });
    const result = listIdleSkills(skills, options);
    const days = Math.max(1, Number(result.days) || 60);
    const now = Number(result.scannedAt) || Date.now();
    const MS_DAY = 24 * 60 * 60 * 1000;

    // 智能体：启用后长期 0 命中也进清理候选（冷藏=撤投射，不删库）
    // 内置智能体不参与评估
    const assistants = this.listResources({ type: 'assistant' });
    let assistantEvalCount = 0;
    for (const a of assistants) {
      if (isLifecycleExempt(a)) continue;
      assistantEvalCount += 1;
      const life = classifyLifecycle(a, now);
      if (life.layer === 'exempt') continue;
      if (life.useCount > 0) continue;
      if (life.projectionCount === 0 && life.layer === 'shelf') {
        // 从未启用：按纳管天数算闲置
        const ageDays = Math.floor((now - (Number(a.created_at) || now)) / MS_DAY);
        if (ageDays < days) continue;
      } else if (life.ageMs < days * MS_DAY) {
        continue;
      }
      result.items.push({
        id: a.id,
        name: a.name,
        display_name: a.display_name || a.name,
        description: a.description || '',
        type: 'assistant',
        authorityPath: null,
        lastActivityAt: life.lastUsedAt || 0,
        lastActivitySource: life.lastUsedAt ? 'hit' : 'never',
        fileActivityAt: 0,
        idleDays: Math.floor(life.ageMs / MS_DAY) || days,
        projectionCount: life.projectionCount,
        cleanupMode: 'unproject', // 智能体只撤投射，不删资源
      });
    }
    result.items.sort((a, b) => a.lastActivityAt - b.lastActivityAt);
    result.totalManaged = skills.length + assistantEvalCount;
    return { success: true, ...result };
  }

  /**
   * 挖掘使用需求简报：从已纳管智能体的 session_trace 抽取用户对话,
   * 供发现智能体推测「是谁 / 追求什么目标」,再推荐资源。
   */
  mineDemand(options = {}) {
    this.init();
    // 先同步一次 Skill 调用入库，闲置判断更准
    try {
      const { syncSkillUsage } = require('./session-skill-usage');
      syncSkillUsage(localStats);
    } catch (e) {
      console.warn('[resource-manager] mineDemand syncSkillUsage:', e.message);
    }

    const { collectWorkSignals, buildDigest, DEFAULT_MAX_SESSIONS } = require('./skill-demand-miner');
    // 核心素材=用户与 Agent 的对话(trace),不是文件类型/命令统计
    const workSignals = collectWorkSignals({
      sinceDays: options.sinceDays ?? 30,
      maxSessions: options.maxSessions ?? DEFAULT_MAX_SESSIONS,
      apps: options.apps,
      managedAgentIds: options.managedAgentIds,
    });
    const digest = buildDigest(workSignals, options.digestOpts || {});

    // 已装资源(供发现智能体避免重复推荐);闲置技能(可提示替换)
    const installed = {
      skills: this.listResources({ type: 'skill' }).map(r => r.name),
      prompts: this.listResources({ type: 'prompt' }).map(r => r.name),
      assistants: this.listResources({ type: 'assistant' }).map(r => r.name),
    };
    let idle = [];
    try {
      const idleRes = this.listIdleSkills({ days: options.idleDays ?? 60 });
      const days = idleRes.days ?? 60;
      idle = (idleRes.items || []).filter(i => (i.idleDays || 0) >= days).map(i => i.name);
    } catch (e) {
      console.warn('[resource-manager] mineDemand idle:', e.message);
    }

    return {
      success: true,
      digest,
      installed,
      idle,
      sessions: digest.sessions,
      agents: digest.agents || [],
    };
  }

  /**
   * 一键清理闲置项：Skill 撤投射并删权威目录；智能体仅撤全部投射（冷藏，保留库内）
   * @param {string[]} resourceIds
   */
  cleanupSkills(resourceIds = []) {
    this.init();
    const ids = [...new Set((resourceIds || []).map(id => String(id || '').trim()).filter(Boolean))];
    const results = [];

    for (const resourceId of ids) {
      try {
        const resource = this.getResource(resourceId);
        if (!resource) {
          results.push({ id: resourceId, success: false, error: '资产不存在' });
          continue;
        }

        // 智能体：只撤投射，不删库（冷藏 / Hit-or-Exit）
        if (resource.type === 'assistant') {
          let removed = 0;
          for (const proj of resource.projections || []) {
            try {
              this.unproject({
                resourceId,
                agentId: proj.agentId,
                projectionId: proj.id,
              });
              removed += 1;
            } catch (e) {
              console.warn('[resource-manager] cleanup assistant unproject:', e.message);
            }
          }
          results.push({
            id: resourceId,
            name: resource.name,
            type: 'assistant',
            success: true,
            mode: 'unproject',
            removedProjections: removed,
          });
          continue;
        }

        if (resource.type !== 'skill') {
          results.push({ id: resourceId, success: false, error: '仅支持清理 Skill 或智能体' });
          continue;
        }

        const authorityDir = this._resolveSkillAuthorityDir(resource);
        // 清理前自动取消非权威投射，避免卸载被拦截
        for (const proj of resource.projections || []) {
          if (!this._isRemovableProjection(proj, authorityDir, resource.name)) continue;
          try {
            this.unproject({
              resourceId,
              agentId: proj.agentId,
              projectionId: proj.id,
            });
          } catch (e) {
            console.warn('[resource-manager] cleanup unproject:', e.message);
          }
        }

        const del = this.deleteResource(resourceId);
        results.push({
          id: resourceId,
          name: resource.name,
          type: 'skill',
          success: true,
          deletedFiles: del.deletedFiles || null,
        });
      } catch (e) {
        results.push({ id: resourceId, success: false, error: e.message });
      }
    }

    const cleaned = results.filter(r => r.success).length;
    return {
      success: results.every(r => r.success),
      cleaned,
      failed: results.length - cleaned,
      results,
    };
  }
}

module.exports = new ResourceManager();
module.exports.applyPromptArguments = applyPromptArguments;
