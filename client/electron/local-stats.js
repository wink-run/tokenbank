// client/electron/local-stats.js
// Per-device request statistics stored in SQLite.
// Call init(dbDir) once before record() or queryDashboard().
'use strict';

let db = null;
let _lastInitError = null;
let _insertStmt = null;
let _enrichByRequestIdStmt = null;
let _getImportStateStmt = null;
let _setImportStateStmt = null;
let _insertSkillCallStmt = null;
let _deleteSkillCallsByPathStmt = null;
let _insertToolCallStmt = null;
let _deleteToolCallsByPathStmt = null;

// 盘点费用口径：仅 api-key 计费 + provider 刊例价（无刊例价则为 0）
const { estimatePaygCost, estimateCost } = require('./pricing');
const { resolvePricingProviderId } = require('./billing-config');
const { filterRankableModels } = require('../shared/model-rank');

/** claude_models：客户端透明 mask 名，不计入模型排行 */
function maskedModelNames() {
  try {
    return new Set(require('./config-loader').claudeModels() || []);
  } catch {
    return new Set();
  }
}

function rankableModels(rows) {
  return filterRankableModels(rows, { maskedModels: maskedModelNames() });
}

/** 按 provider/model 聚合 token 后重算按量刊例价（不读库内 cost_usd，避免全局兜底价） */
function _queryPaygCostMaps(where, params) {
  const empty = { total: 0, byModel: {}, byProviderTier: {} };
  if (!db) return empty;
  try {
    const rows = db.prepare(
      `SELECT provider_id, tier, model,
        SUM(input_tokens) AS inTok, SUM(output_tokens) AS outTok,
        SUM(cache_create_tokens) AS cCreate, SUM(cache_read_tokens) AS cRead
       FROM requests WHERE ${where} AND billing_type = 'api-key'
       GROUP BY provider_id, tier, model`
    ).all(params);
    const byModel = {};
    const byProviderTier = {};
    let total = 0;
    for (const r of rows) {
      // free/p2p 不计按量刊例价（与 recordStats 落账口径一致）
      if (r.tier === 'free' || r.tier === 'p2p') continue;
      const c = estimatePaygCost(
        r.model, r.inTok || 0, r.outTok || 0, r.cCreate || 0, r.cRead || 0,
        resolvePricingProviderId(r.provider_id),
      );
      total += c;
      if (r.model) byModel[r.model] = (byModel[r.model] || 0) + c;
      if (r.provider_id != null) {
        const key = `${r.provider_id}|${r.tier || ''}`;
        byProviderTier[key] = (byProviderTier[key] || 0) + c;
      }
    }
    return { total, byModel, byProviderTier };
  } catch (e) {
    console.error('[local-stats] _queryPaygCostMaps failed:', e.message);
    return empty;
  }
}

/** 按 model + provider 聚合按量刊例价 */
function _queryPaygCostByModelProvider(where, params) {
  const byModelProvider = {};
  if (!db) return byModelProvider;
  try {
    const rows = db.prepare(
      `SELECT provider_id, tier, model,
        SUM(input_tokens) AS inTok, SUM(output_tokens) AS outTok,
        SUM(cache_create_tokens) AS cCreate, SUM(cache_read_tokens) AS cRead
       FROM requests WHERE ${where} AND billing_type = 'api-key' AND model IS NOT NULL AND provider_id IS NOT NULL
       GROUP BY provider_id, tier, model`
    ).all(params);
    for (const r of rows) {
      if (r.tier === 'free' || r.tier === 'p2p') continue;
      const c = estimatePaygCost(
        r.model, r.inTok || 0, r.outTok || 0, r.cCreate || 0, r.cRead || 0,
        resolvePricingProviderId(r.provider_id),
      );
      if (!byModelProvider[r.model]) byModelProvider[r.model] = {};
      byModelProvider[r.model][r.provider_id] = (byModelProvider[r.model][r.provider_id] || 0) + c;
    }
  } catch (e) {
    console.error('[local-stats] _queryPaygCostByModelProvider failed:', e.message);
  }
  return byModelProvider;
}

/** 按时间桶（hour / date）累加按量刊例价，与仪表盘费用口径一致 */
function _fillPaygCostForBuckets(buckets, since, bucketKey) {
  if (!db || !buckets.length) return;
  const groupCol = bucketKey === 'hour'
    ? "CAST(strftime('%H', ts, 'unixepoch', 'localtime') AS INTEGER)"
    : "date(ts, 'unixepoch', 'localtime')";
  try {
    const rows = db.prepare(
      `SELECT ${groupCol} AS bucket_key, provider_id, tier, model,
        SUM(input_tokens) AS inTok, SUM(output_tokens) AS outTok,
        SUM(cache_create_tokens) AS cCreate, SUM(cache_read_tokens) AS cRead
       FROM requests WHERE ts >= ? AND billing_type = 'api-key'
       GROUP BY bucket_key, provider_id, tier, model`
    ).all(since);
    const costByKey = {};
    for (const r of rows) {
      if (r.tier === 'free' || r.tier === 'p2p') continue;
      const k = bucketKey === 'hour' ? Number(r.bucket_key) : r.bucket_key;
      const c = estimatePaygCost(
        r.model, r.inTok || 0, r.outTok || 0, r.cCreate || 0, r.cRead || 0,
        resolvePricingProviderId(r.provider_id),
      );
      costByKey[k] = (costByKey[k] || 0) + c;
    }
    for (const b of buckets) {
      const k = bucketKey === 'hour' ? b.hour : b.date;
      b.cost_usd = costByKey[k] || 0;
    }
  } catch (e) {
    console.error('[local-stats] _fillPaygCostForBuckets failed:', e.message);
  }
}

// 注：展示用「token 总量」= input+output+cache_create+cache_read（与 cc-switch real_total 一致）。
// Claude 重度用 prompt-cache 时量都在 cache_read，只算 input+output 会显示成 0/极小，故求和必须含 cache_*。
// tokens 列仍存 input+output（历史兼容），但所有展示查询改为按四列实时求和。
//
// request_id：跨来源去重键。代理拦截用上游响应 id（Anthropic msg_xxx / OpenAI chatcmpl_xxx），
//   JSONL 导入用会话文件里的 message.id（Claude）或合成键（Codex/Gemini）。同一次调用若既走了
//   网关又落进会话文件，两边 request_id 相同 → 部分唯一索引 + INSERT OR IGNORE 保证只记一次。
// data_source：'proxy' = 网关实时拦截；'session-claude' / 'session-codex' / 'session-gemini' = 扫本地会话文件补录。
// status_code/error：非 2xx、异常、断流也落账，保证“不丢账”。
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS requests (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    ts                  INTEGER NOT NULL,
    api_key             TEXT,
    app_id              TEXT,
    model               TEXT,
    provider_id         TEXT,
    tier                TEXT,
    tokens              INTEGER DEFAULT 0,
    input_tokens        INTEGER DEFAULT 0,
    output_tokens       INTEGER DEFAULT 0,
    cache_create_tokens INTEGER DEFAULT 0,
    cache_read_tokens   INTEGER DEFAULT 0,
    request_id          TEXT,
    data_source         TEXT,
    session_id          TEXT,
    status_code         INTEGER,
    error               TEXT,
    is_streaming        INTEGER DEFAULT 0,
    latency_ms          INTEGER,
    first_token_ms      INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_ts      ON requests(ts);
  CREATE INDEX IF NOT EXISTS idx_api_key ON requests(api_key, ts);
  CREATE INDEX IF NOT EXISTS idx_model   ON requests(model, ts);

  -- 会话文件增量扫描状态：记录每个文件上次导入时的 mtime/size，未变更则跳过。
  CREATE TABLE IF NOT EXISTS import_state (
    path   TEXT PRIMARY KEY,
    mtime  INTEGER,
    size   INTEGER
  );

  -- 会话管理叠加层：收藏 / 标签 / 备注 / 归档（不碰 agent 原始 JSONL）。
  CREATE TABLE IF NOT EXISTS session_meta (
    agent_id   TEXT NOT NULL,
    session_id TEXT NOT NULL,
    favorite   INTEGER DEFAULT 0,
    tags       TEXT DEFAULT '',
    note       TEXT DEFAULT '',
    archived   INTEGER DEFAULT 0,
    updated_at INTEGER,
    PRIMARY KEY (agent_id, session_id)
  );
`;

// 必须在列迁移之后执行：旧库执行 SCHEMA 时 request_id 列还不存在，
// 此时建索引会报错。放到 MIGRATIONS 之后，列已补齐再建部分唯一索引。
// 部分唯一索引：request_id 为 NULL 的行（拿不到上游 id 时）互不冲突，照常插入。
const POST_MIGRATION = `
  CREATE UNIQUE INDEX IF NOT EXISTS idx_request_id ON requests(request_id) WHERE request_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_app_id ON requests(app_id, ts);
`;

// 已存在 DB 的列迁移（旧库缺这些列）。SQLite 不支持 ADD COLUMN IF NOT EXISTS，
// 已存在时抛 "duplicate column name"，吞掉即可。
const MIGRATIONS = [
  'ALTER TABLE requests ADD COLUMN input_tokens        INTEGER DEFAULT 0',
  'ALTER TABLE requests ADD COLUMN output_tokens       INTEGER DEFAULT 0',
  'ALTER TABLE requests ADD COLUMN cache_create_tokens INTEGER DEFAULT 0',
  'ALTER TABLE requests ADD COLUMN cache_read_tokens   INTEGER DEFAULT 0',
  'ALTER TABLE requests ADD COLUMN request_id          TEXT',
  'ALTER TABLE requests ADD COLUMN data_source         TEXT',
  'ALTER TABLE requests ADD COLUMN session_id          TEXT',
  'ALTER TABLE requests ADD COLUMN status_code         INTEGER',
  'ALTER TABLE requests ADD COLUMN error               TEXT',
  'ALTER TABLE requests ADD COLUMN is_streaming        INTEGER DEFAULT 0',
  'ALTER TABLE requests ADD COLUMN latency_ms          INTEGER',
  'ALTER TABLE requests ADD COLUMN first_token_ms      INTEGER',
  'ALTER TABLE requests ADD COLUMN app_id              TEXT',
  'ALTER TABLE requests ADD COLUMN cost_usd     REAL',
  'ALTER TABLE requests ADD COLUMN billing_type TEXT',
  // 客户端原本请求的模型（换模后与 model 不同），用于估算「帮你省了多少」
  'ALTER TABLE requests ADD COLUMN requested_model TEXT',
  // Agent 聚合系统扩展
  'ALTER TABLE requests ADD COLUMN agent_id TEXT',
  'ALTER TABLE requests ADD COLUMN mcp_server_id TEXT',
  'ALTER TABLE requests ADD COLUMN mcp_capability TEXT',
  // 武将/兵器点将命中记账
  'ALTER TABLE resources ADD COLUMN use_count INTEGER DEFAULT 0',
  'ALTER TABLE resources ADD COLUMN last_used_at INTEGER',
];

/** agent_task_steps 列迁移：必须在 AGENT_SCHEMA 建表之后执行，否则新库会 no such table 拖垮 init */
const AGENT_STEP_MIGRATIONS = [
  'ALTER TABLE agent_task_steps ADD COLUMN tool_use_id TEXT',
  'ALTER TABLE agent_task_steps ADD COLUMN is_error INTEGER DEFAULT 0',
];

// Agent 聚合系统表
const AGENT_SCHEMA = `
  CREATE TABLE IF NOT EXISTS agent_tasks (
    id                  TEXT PRIMARY KEY,
    agent_id            TEXT NOT NULL,
    prompt              TEXT NOT NULL,
    context             TEXT,
    status              TEXT NOT NULL,
    result              TEXT,
    error               TEXT,
    created_at          INTEGER NOT NULL,
    started_at          INTEGER,
    completed_at        INTEGER
  );

  CREATE TABLE IF NOT EXISTS agent_task_steps (
    id                  TEXT PRIMARY KEY,
    task_id             TEXT NOT NULL,
    step_number         INTEGER NOT NULL,
    step_type           TEXT,
    content             TEXT,
    tool_name           TEXT,
    tool_input          TEXT,
    tool_output         TEXT,
    tool_use_id         TEXT,
    is_error            INTEGER DEFAULT 0,
    status              TEXT,
    created_at          INTEGER NOT NULL,
    FOREIGN KEY (task_id) REFERENCES agent_tasks(id)
  );

  CREATE TABLE IF NOT EXISTS agent_modified_files (
    id                  TEXT PRIMARY KEY,
    task_id             TEXT NOT NULL,
    file_path           TEXT NOT NULL,
    operation           TEXT,
    diff                TEXT,
    created_at          INTEGER NOT NULL,
    FOREIGN KEY (task_id) REFERENCES agent_tasks(id)
  );

  CREATE INDEX IF NOT EXISTS idx_agent_tasks_agent_id ON agent_tasks(agent_id);
  CREATE INDEX IF NOT EXISTS idx_agent_tasks_status ON agent_tasks(status);
  CREATE INDEX IF NOT EXISTS idx_agent_task_steps_task_id ON agent_task_steps(task_id);
  CREATE INDEX IF NOT EXISTS idx_agent_modified_files_task_id ON agent_modified_files(task_id);
`;

// MCP 供给源表（Phase 2）
const MCP_SCHEMA = `
  CREATE TABLE IF NOT EXISTS mcp_servers (
    id                  TEXT PRIMARY KEY,
    name                TEXT NOT NULL UNIQUE,
    display_name        TEXT,
    type                TEXT NOT NULL DEFAULT 'stdio',
    command             TEXT,
    args                TEXT,
    url                 TEXT,
    env                 TEXT,
    builtin             INTEGER DEFAULT 0,
    status              TEXT DEFAULT 'active',
    metadata            TEXT,
    created_at          INTEGER,
    updated_at          INTEGER
  );

  CREATE TABLE IF NOT EXISTS mcp_profiles (
    id                  TEXT PRIMARY KEY,
    name                TEXT NOT NULL UNIQUE,
    display_name        TEXT,
    description         TEXT,
    rules               TEXT,
    created_at          INTEGER
  );

  CREATE TABLE IF NOT EXISTS mcp_profile_servers (
    profile_id          TEXT NOT NULL,
    server_id           TEXT NOT NULL,
    enabled             INTEGER DEFAULT 1,
    PRIMARY KEY (profile_id, server_id)
  );

  CREATE INDEX IF NOT EXISTS idx_mcp_servers_status ON mcp_servers(status);
  CREATE INDEX IF NOT EXISTS idx_mcp_profile_servers_profile ON mcp_profile_servers(profile_id);
`;

// 资源管理表（Prompt / Skill / Assistant / Template）
const RESOURCE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS resources (
    id                  TEXT PRIMARY KEY,
    type                TEXT NOT NULL,
    name                TEXT NOT NULL,
    display_name        TEXT,
    description         TEXT,
    content             TEXT,
    metadata            TEXT,
    source              TEXT DEFAULT 'local',
    source_url          TEXT,
    hash                TEXT,
    created_at          INTEGER,
    updated_at          INTEGER,
    UNIQUE(type, name)
  );

  CREATE TABLE IF NOT EXISTS resource_projections (
    id                  TEXT PRIMARY KEY,
    resource_id         TEXT NOT NULL,
    agent_id            TEXT NOT NULL,
    scope               TEXT NOT NULL DEFAULT 'global',
    projection_type     TEXT,
    target_path         TEXT,
    status              TEXT DEFAULT 'active',
    created_at          INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_resources_type ON resources(type);
  CREATE INDEX IF NOT EXISTS idx_resource_projections_resource ON resource_projections(resource_id);
  CREATE INDEX IF NOT EXISTS idx_resource_projections_agent ON resource_projections(agent_id);
`;

// Skill 调用明细（对齐 tokentelemetry skills_used，供 Trace / 闲置扫描）
const SKILL_CALLS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS skill_calls (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    ts           INTEGER NOT NULL,
    agent_id     TEXT NOT NULL,
    session_id   TEXT,
    skill_key    TEXT NOT NULL,
    skill_raw    TEXT,
    data_source  TEXT,
    source_path  TEXT,
    call_uid     TEXT NOT NULL UNIQUE
  );
  CREATE INDEX IF NOT EXISTS idx_skill_calls_key_ts ON skill_calls(skill_key, ts);
  CREATE INDEX IF NOT EXISTS idx_skill_calls_ts ON skill_calls(ts);
  CREATE INDEX IF NOT EXISTS idx_skill_calls_path ON skill_calls(source_path);
`;

// 工具调用明细（会话补录 + 游乐场步骤），供盘点页 Skill / 工具统计
const TOOL_CALLS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS tool_calls (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    ts           INTEGER NOT NULL,
    agent_id     TEXT NOT NULL,
    session_id   TEXT,
    tool_key     TEXT NOT NULL,
    tool_raw     TEXT,
    tool_kind    TEXT,
    mcp_server   TEXT,
    data_source  TEXT,
    source_path  TEXT,
    call_uid     TEXT NOT NULL UNIQUE
  );
  CREATE INDEX IF NOT EXISTS idx_tool_calls_key_ts ON tool_calls(tool_key, ts);
  CREATE INDEX IF NOT EXISTS idx_tool_calls_ts ON tool_calls(ts);
  CREATE INDEX IF NOT EXISTS idx_tool_calls_path ON tool_calls(source_path);
`;

/** @param {string} dbDir  Directory that will hold local-stats.db
 *  @param {{ force?: boolean }} [opts] force=true 时关闭已有连接并重新打开（测试隔离用）
 */
function init(dbDir, opts = {}) {
  if (opts.force && db) {
    try { db.close(); } catch { /* ignore */ }
    db = null;
    _insertStmt = null;
    _getImportStateStmt = null;
    _setImportStateStmt = null;
    _enrichByRequestIdStmt = null;
    _insertSkillCallStmt = null;
    _deleteSkillCallsByPathStmt = null;
    _insertToolCallStmt = null;
    _deleteToolCallsByPathStmt = null;
  }
  if (db) return db;
  _lastInitError = null;
  const fs       = require('fs');
  const path     = require('path');
  const Database = require('better-sqlite3');
  if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
  try {
    db = new Database(path.join(dbDir, 'local-stats.db'));
    db.pragma('journal_mode = WAL');  // safer concurrent reads
    db.pragma('busy_timeout = 5000'); // 主线程与扫描 worker 各开连接时等锁，避免 SQLITE_BUSY
    db.exec(SCHEMA);
    for (const sql of MIGRATIONS) {
      try { db.exec(sql); } catch (e) {
        // duplicate：旧库已有列；no such table：表尚未建（由后续 SCHEMA 创建）
        if (!/duplicate column name|no such table/i.test(e.message)) throw e;
      }
    }
    // Agent 聚合系统表初始化
    db.exec(AGENT_SCHEMA);
    for (const sql of AGENT_STEP_MIGRATIONS) {
      try { db.exec(sql); } catch (e) {
        if (!/duplicate column name|no such table/i.test(e.message)) throw e;
      }
    }
    db.exec(MCP_SCHEMA);
    db.exec(RESOURCE_SCHEMA);
    db.exec(SKILL_CALLS_SCHEMA);
    db.exec(TOOL_CALLS_SCHEMA);
    db.exec(POST_MIGRATION); // 列补齐后再建 request_id 唯一索引
    // INSERT OR IGNORE：命中 request_id 唯一索引时静默跳过（跨来源去重），不报错、不重复计。
    _insertStmt = db.prepare(
      'INSERT OR IGNORE INTO requests ' +
      '(ts, api_key, app_id, model, provider_id, tier, tokens, input_tokens, output_tokens, cache_create_tokens, cache_read_tokens, ' +
      ' request_id, data_source, session_id, status_code, error, is_streaming, latency_ms, first_token_ms, cost_usd, billing_type, requested_model) ' +
      'VALUES (?,?,?,?,?,?,?,?,?,?,?, ?,?,?,?,?,?,?,?,?,?,?)'
    );
    _getImportStateStmt = db.prepare('SELECT mtime, size FROM import_state WHERE path = ?');
    _setImportStateStmt = db.prepare(
      'INSERT INTO import_state (path, mtime, size) VALUES (?,?,?) ' +
      'ON CONFLICT(path) DO UPDATE SET mtime = excluded.mtime, size = excluded.size'
    );
    _enrichByRequestIdStmt = db.prepare(
      'UPDATE requests SET ' +
      'input_tokens = @inTok, output_tokens = @outTok, cache_create_tokens = @cCreate, cache_read_tokens = @cRead, ' +
      'tokens = @total, session_id = COALESCE(@session_id, session_id), model = COALESCE(@model, model), ' +
      'cost_usd = @cost_usd, billing_type = COALESCE(@billing_type, billing_type), ' +
      'data_source = COALESCE(@data_source, data_source) ' +
      'WHERE request_id = @request_id'
    );
    _insertSkillCallStmt = db.prepare(
      'INSERT OR IGNORE INTO skill_calls ' +
      '(ts, agent_id, session_id, skill_key, skill_raw, data_source, source_path, call_uid) ' +
      'VALUES (@ts, @agent_id, @session_id, @skill_key, @skill_raw, @data_source, @source_path, @call_uid)'
    );
    _deleteSkillCallsByPathStmt = db.prepare('DELETE FROM skill_calls WHERE source_path = ?');
    _insertToolCallStmt = db.prepare(
      'INSERT OR IGNORE INTO tool_calls ' +
      '(ts, agent_id, session_id, tool_key, tool_raw, tool_kind, mcp_server, data_source, source_path, call_uid) ' +
      'VALUES (@ts, @agent_id, @session_id, @tool_key, @tool_raw, @tool_kind, @mcp_server, @data_source, @source_path, @call_uid)'
    );
    _deleteToolCallsByPathStmt = db.prepare('DELETE FROM tool_calls WHERE source_path = ?');
    return db;
  } catch (e) {
    console.error('[local-stats] failed to open DB:', e.message);
    _lastInitError = e;
    try { db?.close(); } catch {}
    db = null;
    _insertStmt = null;
    return null;
  }
}

/** 懒初始化：Agent/MCP IPC 可能在 main 完成 init 前触发 */
function ensureReady(dbDir) {
  if (!db && dbDir) init(dbDir);
  return db;
}

/** 获取 DB 实例，未就绪时抛错（供 Agent/MCP/Resources 模块使用） */
function requireDb(dbDir) {
  ensureReady(dbDir);
  if (!db) {
    const detail = _lastInitError?.message ? `: ${_lastInitError.message}` : '';
    throw new Error(`Database not initialized${detail}`);
  }
  return db;
}

/** 单行 token 总量（含 cache） */
function _tokenTotal({ input_tokens, output_tokens, cache_create_tokens, cache_read_tokens, tokens } = {}) {
  if (tokens != null && tokens > 0) return tokens;
  return (input_tokens || 0) + (output_tokens || 0) + (cache_create_tokens || 0) + (cache_read_tokens || 0);
}

/**
 * 会话补录与网关 proxy 同 request_id 冲突时合并更新。
 * - token 更大：用会话侧覆盖用量
 * - 已有行为 proxy：即使 token 不大也改 data_source → session-*（shim/OAuth
 *   流量常无 app_id，不挂会话源则 Claude Code 等应用明细永远为 0）
 * 保留 proxy 写入的 app_id / api_key。
 */
function _tryEnrichFromSession(requestId, row) {
  if (!db || !_enrichByRequestIdStmt || !requestId) return false;
  try {
    const ex = db.prepare(
      'SELECT input_tokens, output_tokens, cache_create_tokens, cache_read_tokens, tokens, ' +
      'cost_usd, billing_type, data_source FROM requests WHERE request_id = ?'
    ).get(requestId);
    if (!ex) return false;
    const existTot = _tokenTotal(ex);
    const newTot = (row.inTok || 0) + (row.outTok || 0) + (row.cCreate || 0) + (row.cRead || 0);
    const linkSource = !!(row.data_source
      && String(row.data_source).startsWith('session')
      && String(ex.data_source || '') === 'proxy');
    if (newTot <= existTot && !linkSource) return false;
    const useNew = newTot > existTot;
    _enrichByRequestIdStmt.run({
      request_id:          requestId,
      inTok:               useNew ? row.inTok : (ex.input_tokens || 0),
      outTok:              useNew ? row.outTok : (ex.output_tokens || 0),
      cCreate:             useNew ? row.cCreate : (ex.cache_create_tokens || 0),
      cRead:               useNew ? row.cRead : (ex.cache_read_tokens || 0),
      total:               useNew ? newTot : existTot,
      session_id:          row.session_id ?? null,
      model:               row.model ?? null,
      cost_usd:            useNew ? (row.cost_usd ?? null) : (ex.cost_usd ?? null),
      billing_type:        row.billing_type ?? ex.billing_type ?? null,
      data_source:         row.data_source ?? null,
    });
    return true;
  } catch (e) {
    console.error('[local-stats] enrich from session failed:', e.message);
    return false;
  }
}

/**
 * Returns true if a new row was inserted or an existing proxy row was enriched
 * from session import; false if deduped/skipped or on error.
 *
 * New optional fields:
 *   ts            unix seconds; defaults to now (session importer passes the message time)
 *   request_id    cross-source dedup key (upstream msg_/chatcmpl_ id, or synthesized)
 *   data_source   'proxy' | 'session-claude' | 'session-codex' | 'session-gemini'
 *   session_id, status_code, error, is_streaming, latency_ms, first_token_ms
 */
function record({ api_key, app_id, model, provider_id, tier, tokens,
                  input_tokens, output_tokens, cache_create_tokens, cache_read_tokens,
                  ts, request_id, data_source, session_id, status_code, error,
                  is_streaming, latency_ms, first_token_ms,
                  cost_usd, billing_type, requested_model } = {}) {
  if (!db || !_insertStmt) return false;
  try {
    const inTok   = input_tokens        || 0;
    const outTok  = output_tokens       || 0;
    const total   = (tokens != null) ? tokens : (inTok + outTok);
    const info = _insertStmt.run(
      (ts != null) ? ts : Math.floor(Date.now() / 1000),
      api_key     || null,
      app_id      || null,
      model       || null,
      provider_id || null,
      tier        || null,
      total       || 0,
      inTok,
      outTok,
      cache_create_tokens || 0,
      cache_read_tokens   || 0,
      request_id  || null,
      data_source || null,
      session_id  || null,
      (status_code != null) ? status_code : null,
      error       || null,
      is_streaming ? 1 : 0,
      (latency_ms     != null) ? latency_ms     : null,
      (first_token_ms != null) ? first_token_ms : null,
      (cost_usd       != null) ? cost_usd       : null,
      billing_type  || null,
      requested_model || null,
    );
    if (info.changes > 0) return true;
    // proxy 先写入占位行时，会话补录用同 message.id 合并更完整的 token
    if (request_id && data_source && String(data_source).startsWith('session')) {
      return _tryEnrichFromSession(request_id, {
        inTok, outTok, cCreate: cache_create_tokens || 0, cRead: cache_read_tokens || 0,
        session_id, model, cost_usd, billing_type, data_source,
      });
    }
    return false;
  } catch (e) {
    console.error('[local-stats] record failed:', e.message);
    return false;
  }
}

/** Read incremental-scan state for a session file. Returns {mtime, size} or null. */
function getImportState(filePath) {
  if (!db || !_getImportStateStmt) return null;
  try { return _getImportStateStmt.get(filePath) || null; }
  catch { return null; }
}

/** Persist incremental-scan state for a session file after importing it. */
function setImportState(filePath, mtime, size) {
  if (!db || !_setImportStateStmt) return;
  try { _setImportStateStmt.run(filePath, mtime, size); }
  catch (e) { console.error('[local-stats] setImportState failed:', e.message); }
}

/** 批量写入 Skill 调用（INSERT OR IGNORE by call_uid） */
function recordSkillCalls(calls = []) {
  if (!db || !_insertSkillCallStmt || !calls.length) return 0;
  let n = 0;
  const run = db.transaction((rows) => {
    for (const c of rows) {
      if (!c?.skill_key || !c?.call_uid) continue;
      try {
        const info = _insertSkillCallStmt.run({
          ts: Number(c.ts) || Date.now(),
          agent_id: c.agent_id || 'unknown',
          session_id: c.session_id || null,
          skill_key: c.skill_key,
          skill_raw: c.skill_raw || c.skill_key,
          data_source: c.data_source || null,
          source_path: c.source_path || null,
          call_uid: c.call_uid,
        });
        if (info.changes > 0) n++;
      } catch (e) {
        console.error('[local-stats] recordSkillCall failed:', e.message);
      }
    }
  });
  try { run(calls); } catch (e) { console.error('[local-stats] recordSkillCalls failed:', e.message); }
  return n;
}

function deleteSkillCallsBySourcePath(sourcePath) {
  if (!db || !_deleteSkillCallsByPathStmt || !sourcePath) return 0;
  try {
    const info = _deleteSkillCallsByPathStmt.run(sourcePath);
    return info.changes || 0;
  } catch (e) {
    console.error('[local-stats] deleteSkillCallsBySourcePath failed:', e.message);
    return 0;
  }
}

/**
 * skill_key → 最近调用时间戳(ms)
 * @param {{ sinceMs?: number }} [opts]
 */
function getSkillLastUsedMap(opts = {}) {
  const map = new Map();
  if (!db) return map;
  try {
    const sinceMs = Number(opts.sinceMs) || 0;
    const rows = sinceMs > 0
      ? db.prepare(
        'SELECT skill_key, MAX(ts) AS last_ts FROM skill_calls WHERE ts >= ? GROUP BY skill_key'
      ).all(sinceMs)
      : db.prepare(
        'SELECT skill_key, MAX(ts) AS last_ts FROM skill_calls GROUP BY skill_key'
      ).all();
    for (const r of rows) {
      if (r.skill_key) map.set(String(r.skill_key).toLowerCase(), Number(r.last_ts) || 0);
    }
  } catch (e) {
    console.error('[local-stats] getSkillLastUsedMap failed:', e.message);
  }
  return map;
}

/**
 * skill_key → { count, lastTs }（Hit-or-Exit 回写资源命中）
 */
function getSkillCallStatsMap() {
  const map = new Map();
  if (!db) return map;
  try {
    const rows = db.prepare(
      'SELECT skill_key, COUNT(*) AS n, MAX(ts) AS last_ts FROM skill_calls GROUP BY skill_key',
    ).all();
    for (const r of rows) {
      if (!r.skill_key) continue;
      map.set(String(r.skill_key).toLowerCase(), {
        count: Number(r.n) || 0,
        lastTs: Number(r.last_ts) || 0,
      });
    }
  } catch (e) {
    console.error('[local-stats] getSkillCallStatsMap failed:', e.message);
  }
  return map;
}

/** 批量写入工具调用（INSERT OR IGNORE by call_uid） */
function recordToolCalls(calls = []) {
  if (!db || !_insertToolCallStmt || !calls.length) return 0;
  let n = 0;
  const run = db.transaction((rows) => {
    for (const c of rows) {
      if (!c?.tool_key || !c?.call_uid) continue;
      try {
        const info = _insertToolCallStmt.run({
          ts: Number(c.ts) || Date.now(),
          agent_id: c.agent_id || 'unknown',
          session_id: c.session_id || null,
          tool_key: c.tool_key,
          tool_raw: c.tool_raw || c.tool_key,
          tool_kind: c.tool_kind || null,
          mcp_server: c.mcp_server || null,
          data_source: c.data_source || null,
          source_path: c.source_path || null,
          call_uid: c.call_uid,
        });
        if (info.changes > 0) n++;
      } catch (e) {
        console.error('[local-stats] recordToolCall failed:', e.message);
      }
    }
  });
  try { run(calls); } catch (e) { console.error('[local-stats] recordToolCalls failed:', e.message); }
  return n;
}

function deleteToolCallsBySourcePath(sourcePath) {
  if (!db || !_deleteToolCallsByPathStmt || !sourcePath) return 0;
  try {
    const info = _deleteToolCallsByPathStmt.run(sourcePath);
    return info.changes || 0;
  } catch (e) {
    console.error('[local-stats] deleteToolCallsBySourcePath failed:', e.message);
    return 0;
  }
}

/**
 * 盘点：Skill 调用排行
 * @param {{ days?: number, limit?: number }} [opts]
 */
function querySkillUsageStats(opts = {}) {
  const days = Math.max(1, Math.min(365, parseInt(opts.days, 10) || 1));
  const limit = Math.max(1, Math.min(100, parseInt(opts.limit, 10) || 20));
  const since = sinceMsForDays(days); // skill_calls.ts 为毫秒
  if (!db) return { total: 0, items: [] };
  try {
    const totalRow = db.prepare(
      'SELECT COUNT(*) AS n FROM skill_calls WHERE ts >= ?'
    ).get(since);
    const items = db.prepare(
      'SELECT skill_key AS key, COALESCE(MAX(skill_raw), skill_key) AS name, ' +
      'COUNT(*) AS calls, COUNT(DISTINCT agent_id) AS agents, MAX(ts) AS last_ts ' +
      'FROM skill_calls WHERE ts >= ? GROUP BY skill_key ' +
      'ORDER BY calls DESC, name ASC LIMIT ?'
    ).all(since, limit);
    return { total: Number(totalRow?.n) || 0, items };
  } catch (e) {
    console.error('[local-stats] querySkillUsageStats failed:', e.message);
    return { total: 0, items: [] };
  }
}

/** 从工具名解析 MCP server / tool（与 session-skill-usage.classifyToolName 对齐） */
function parseMcpToolName(rawName) {
  let raw = String(rawName || '').trim();
  if (!raw) return null;
  if (raw.startsWith('default_api:')) raw = raw.slice('default_api:'.length);
  let server = null;
  let tool = null;
  if (raw.startsWith('mcp__')) {
    const parts = raw.split('__');
    if (parts.length >= 3 && parts[1] && parts[2]) {
      server = parts[1];
      tool = parts.slice(2).join('__');
    }
  } else if (raw.startsWith('mcp_')) {
    const rest = raw.slice(4);
    const i = rest.indexOf('_');
    if (i > 0) {
      server = rest.slice(0, i);
      tool = rest.slice(i + 1);
    }
  }
  if (!server || !tool) return null;
  return { server, tool, key: `${server}::${String(tool).toLowerCase()}` };
}

/**
 * 盘点：MCP 调用统计（按 Server 汇总，附 Top 工具）
 * @param {{ days?: number, limit?: number, toolLimit?: number }} [opts]
 */
function queryMcpUsageStats(opts = {}) {
  const days = Math.max(1, Math.min(365, parseInt(opts.days, 10) || 1));
  const limit = Math.max(1, Math.min(100, parseInt(opts.limit, 10) || 20));
  const toolLimit = Math.max(1, Math.min(50, parseInt(opts.toolLimit, 10) || 8));
  const since = sinceMsForDays(days); // tool_calls / agent_task_steps 为毫秒
  if (!db) return { total: 0, servers: [], items: [] };

  try {
    // server → { key, name, calls, tools: Map }
    const servers = new Map();
    const bump = (server, tool, calls, lastTs) => {
      const sKey = String(server || '').trim();
      const tName = String(tool || '').trim();
      if (!sKey || !tName) return;
      const n = Number(calls) || 0;
      if (n <= 0) return;
      let row = servers.get(sKey);
      if (!row) {
        row = { key: sKey, name: sKey, calls: 0, last_ts: 0, tools: new Map() };
        servers.set(sKey, row);
      }
      row.calls += n;
      row.last_ts = Math.max(row.last_ts, Number(lastTs) || 0);
      const tKey = tName.toLowerCase();
      const prev = row.tools.get(tKey) || { key: tKey, name: tName, calls: 0 };
      prev.calls += n;
      if (tName !== tKey) prev.name = tName;
      row.tools.set(tKey, prev);
    };

    // tool_calls 表：kind=mcp 或带 mcp_server
    const fromTable = db.prepare(
      "SELECT mcp_server AS server, tool_raw AS tool, tool_key AS tool_key, " +
      'COUNT(*) AS calls, MAX(ts) AS last_ts FROM tool_calls ' +
      "WHERE ts >= ? AND (tool_kind = 'mcp' OR (mcp_server IS NOT NULL AND mcp_server != '')) " +
      'GROUP BY mcp_server, tool_key'
    ).all(since);
    for (const r of fromTable) {
      bump(r.server, r.tool || r.tool_key, r.calls, r.last_ts);
    }

    // 游乐场步骤里的 mcp__ / mcp_ 工具名
    try {
      const fromSteps = db.prepare(
        "SELECT tool_name AS name, COUNT(*) AS calls, MAX(created_at) AS last_ts " +
        "FROM agent_task_steps WHERE step_type = 'tool_call' AND tool_name IS NOT NULL " +
        "AND tool_name != '' AND created_at >= ? " +
        "AND (tool_name LIKE 'mcp__%' OR tool_name LIKE 'mcp_%' OR tool_name LIKE 'default_api:mcp%') " +
        'GROUP BY tool_name'
      ).all(since);
      for (const r of fromSteps) {
        const parsed = parseMcpToolName(r.name);
        if (parsed) bump(parsed.server, parsed.tool, r.calls, r.last_ts);
      }
    } catch { /* ignore */ }

    const serverList = [...servers.values()]
      .map(s => ({
        key: s.key,
        name: s.name,
        calls: s.calls,
        last_ts: s.last_ts,
        tools: [...s.tools.values()]
          .sort((a, b) => b.calls - a.calls || String(a.name).localeCompare(String(b.name)))
          .slice(0, toolLimit),
      }))
      .sort((a, b) => b.calls - a.calls || String(a.name).localeCompare(String(b.name)))
      .slice(0, limit);

    // 扁平 Top 工具（跨 server）
    const flat = [];
    for (const s of servers.values()) {
      for (const t of s.tools.values()) {
        flat.push({
          key: `${s.key}::${t.key}`,
          name: t.name,
          mcp_server: s.name,
          calls: t.calls,
          kind: 'mcp',
        });
      }
    }
    flat.sort((a, b) => b.calls - a.calls || String(a.name).localeCompare(String(b.name)));
    // 总数按全部 server 汇总（不受 limit 截断影响）
    const total = [...servers.values()].reduce((n, s) => n + s.calls, 0);

    return { total, servers: serverList, items: flat.slice(0, limit) };
  } catch (e) {
    console.error('[local-stats] queryMcpUsageStats failed:', e.message);
    return { total: 0, servers: [], items: [] };
  }
}

/**
 * 盘点：工具调用排行（会话补录 + 游乐场 agent_task_steps）
 * @param {{ days?: number, limit?: number }} [opts]
 */
function queryToolUsageStats(opts = {}) {
  const days = Math.max(1, Math.min(365, parseInt(opts.days, 10) || 1));
  const limit = Math.max(1, Math.min(100, parseInt(opts.limit, 10) || 20));
  const since = sinceMsForDays(days); // tool_calls / agent_task_steps 为毫秒
  if (!db) return { total: 0, items: [] };
  try {
    const counts = new Map(); // key → { key, name, calls, kind, mcp_server, last_ts }
    const bump = (row) => {
      const key = String(row.key || '').toLowerCase();
      if (!key) return;
      const prev = counts.get(key) || {
        key, name: row.name || key, calls: 0, kind: row.kind || null,
        mcp_server: row.mcp_server || null, last_ts: 0,
      };
      prev.calls += Number(row.calls) || 0;
      prev.last_ts = Math.max(prev.last_ts, Number(row.last_ts) || 0);
      if (!prev.name || prev.name === key) prev.name = row.name || prev.name;
      if (!prev.kind && row.kind) prev.kind = row.kind;
      if (!prev.mcp_server && row.mcp_server) prev.mcp_server = row.mcp_server;
      counts.set(key, prev);
    };

    const fromTable = db.prepare(
      'SELECT tool_key AS key, COALESCE(MAX(tool_raw), tool_key) AS name, ' +
      'COUNT(*) AS calls, MAX(tool_kind) AS kind, MAX(mcp_server) AS mcp_server, MAX(ts) AS last_ts ' +
      'FROM tool_calls WHERE ts >= ? GROUP BY tool_key'
    ).all(since);
    for (const r of fromTable) bump(r);

    // 游乐场执行步骤（未入库 tool_calls 时仍可统计）
    try {
      const fromSteps = db.prepare(
        "SELECT tool_name AS name, COUNT(*) AS calls, MAX(created_at) AS last_ts " +
        "FROM agent_task_steps WHERE step_type = 'tool_call' AND tool_name IS NOT NULL " +
        "AND tool_name != '' AND created_at >= ? GROUP BY tool_name"
      ).all(since);
      for (const r of fromSteps) {
        const mcp = parseMcpToolName(r.name);
        if (mcp) {
          bump({
            key: mcp.tool.toLowerCase(),
            name: mcp.tool,
            calls: r.calls,
            kind: 'mcp',
            mcp_server: mcp.server,
            last_ts: r.last_ts,
          });
        } else {
          bump({
            key: String(r.name).toLowerCase(),
            name: r.name,
            calls: r.calls,
            kind: 'builtin',
            mcp_server: null,
            last_ts: r.last_ts,
          });
        }
      }
    } catch { /* 表可能为空 */ }

    const all = [...counts.values()];
    const total = all.reduce((s, r) => s + r.calls, 0);
    const items = all
      .sort((a, b) => b.calls - a.calls || String(a.name).localeCompare(String(b.name)))
      .slice(0, limit);
    return { total, items };
  } catch (e) {
    console.error('[local-stats] queryToolUsageStats failed:', e.message);
    return { total: 0, items: [] };
  }
}

/** 不参与「模型排行」的 data_source（显式关闭 model_stats 的源） */
function dataSourcesWithoutModelStats() {
  try {
    return (require('./config-loader').sessionSources() || [])
      .filter(s => s.model_stats === false)
      .map(s => s.data_source)
      .filter(Boolean);
  } catch { return []; }
}

/** 供给源 id 及其 catalog 别名（acct-* 多实例仅自身） */
function collectProviderIdVariants(providerId) {
  const pid = String(providerId || '');
  if (!pid) return [];
  if (pid.startsWith('acct-')) return [pid];
  const ids = new Set([pid]);
  try {
    const bc = require('./billing-config');
    let changed = true;
    while (changed) {
      changed = false;
      for (const c of (bc.apiSubscriptionCatalog?.() || [])) {
        const plan = c.plan_provider_id && String(c.plan_provider_id);
        const sid = c.source_id && String(c.source_id);
        if (plan && sid && (ids.has(plan) || ids.has(sid))) {
          if (plan && !ids.has(plan)) { ids.add(plan); changed = true; }
          if (sid && !ids.has(sid)) { ids.add(sid); changed = true; }
        }
      }
      for (const p of (bc.paygProviderCatalog?.() || [])) {
        const canon = p.provider_id || p.id;
        const group = [...(canon ? [String(canon)] : []), ...(p.aliases || []).map(String)];
        if (group.some(x => ids.has(x))) {
          for (const x of group) {
            if (x && !ids.has(x)) { ids.add(x); changed = true; }
          }
        }
      }
    }
  } catch { /* billing-config 不可用时仅更新主 id */ }
  return [...ids];
}

/** 按新 tier 重算单行 cost_usd（与 local-gateway recordStats 一致） */
function recomputeRowCostUsd(row, tier) {
  if (tier === 'free' || tier === 'p2p') return 0;
  return estimateCost(
    row.model,
    row.input_tokens || 0,
    row.output_tokens || 0,
    row.cache_create_tokens || 0,
    row.cache_read_tokens || 0,
    resolvePricingProviderId(row.provider_id),
  );
}

/**
 * 用户切换供给源 free/paid 后，回溯更新历史请求的 tier 与费用口径。
 * 返回 { updated } 为受影响行数。
 */
function reassignProviderTier(providerId, tier) {
  if (!db || !providerId || !['free', 'paid', 'p2p'].includes(tier)) {
    return { updated: 0 };
  }
  const ids = collectProviderIdVariants(providerId);
  if (!ids.length) return { updated: 0 };
  const placeholders = ids.map(() => '?').join(',');
  try {
    const rows = db.prepare(
      `SELECT id, model, provider_id, input_tokens, output_tokens,
              cache_create_tokens, cache_read_tokens
       FROM requests WHERE provider_id IN (${placeholders})`
    ).all(...ids);
    // 表主键列名是 id（= rowid 别名）；better-sqlite3 返回 r.id，r.rowid 为 undefined
    // → WHERE rowid=? 匹配不到，必须按 id 更新
    const upd = db.prepare('UPDATE requests SET tier = ?, cost_usd = ? WHERE id = ?');
    const txn = db.transaction(() => {
      for (const r of rows) {
        upd.run(tier, recomputeRowCostUsd(r, tier), r.id);
      }
    });
    txn();
    return { updated: rows.length };
  } catch (e) {
    console.error('[local-stats] reassignProviderTier failed:', e.message);
    return { updated: 0, error: e.message };
  }
}

/** 将同一账户的 gateway_id / source_id / plan_provider_id 别名互相同步 */
function mirrorProviderLatencyAliases(out) {
  try {
    const bc = require('./billing-config');
    const pairs = [];
    for (const c of (bc.apiSubscriptionCatalog?.() || [])) {
      const plan = c.plan_provider_id;
      const sid = c.source_id;
      if (plan && sid) pairs.push([sid, plan], [plan, sid]);
    }
    for (const p of (bc.paygProviderCatalog?.() || [])) {
      const id = p.provider_id || p.id;
      for (const a of (p.aliases || [])) {
        if (id && a) pairs.push([a, id], [id, a]);
      }
    }
    for (const model of Object.keys(out)) {
      const pmap = out[model];
      for (const [from, to] of pairs) {
        if (!pmap[from]) continue;
        const src = pmap[from];
        const dst = pmap[to];
        if (!dst || (src.last_ts || 0) > (dst.last_ts || 0)) {
          pmap[to] = { ...src };
        }
      }
    }
  } catch { /* billing-config 不可用时跳过 */ }
  return out;
}

/** 各模型 × 供给源账户的首 token 延迟（个人源下拉展示用） */
function queryModelProviderLatency(since) {
  if (!db) return {};
  try {
    const avgRows = db.prepare(
      'SELECT model, provider_id, ' +
      'AVG(COALESCE(first_token_ms, latency_ms)) AS avg_ms, COUNT(*) AS calls, ' +
      'SUM(CASE WHEN status_code >= 200 AND status_code < 300 THEN 1 ELSE 0 END) AS success ' +
      'FROM requests WHERE ts >= ? AND model IS NOT NULL AND provider_id IS NOT NULL ' +
      "AND data_source = 'proxy' " +
      'AND status_code >= 200 AND status_code < 300 ' +
      'AND COALESCE(first_token_ms, latency_ms) IS NOT NULL ' +
      'AND COALESCE(first_token_ms, latency_ms) > 0 ' +
      'GROUP BY model, provider_id'
    ).all(since);

    // 最近一次请求含失败（404 等）：个人源展开要显示「失败」，不能只看有 TTFT 的成功行
    const lastRows = db.prepare(
      'SELECT r.model, r.provider_id, ' +
      'CASE WHEN r.status_code >= 200 AND r.status_code < 300 ' +
      '  THEN COALESCE(r.first_token_ms, r.latency_ms) ELSE NULL END AS last_ttft_ms, ' +
      'r.latency_ms AS last_latency_ms, r.ts AS last_ts, r.status_code AS last_status_code ' +
      'FROM requests r INNER JOIN (' +
      '  SELECT model, provider_id, MAX(ts) AS max_ts FROM requests ' +
      '  WHERE ts >= ? AND model IS NOT NULL AND provider_id IS NOT NULL ' +
      "  AND data_source = 'proxy' " +
      '  GROUP BY model, provider_id' +
      ') latest ON r.model = latest.model AND r.provider_id = latest.provider_id AND r.ts = latest.max_ts ' +
      'WHERE r.ts >= ? AND r.model IS NOT NULL AND r.provider_id IS NOT NULL ' +
      "AND r.data_source = 'proxy'"
    ).all(since, since);

    const out = {};
    for (const r of avgRows) {
      if (!out[r.model]) out[r.model] = {};
      out[r.model][r.provider_id] = {
        avg_ttft_ms: Math.round(r.avg_ms),
        calls: r.calls || 0,
        success: r.success || 0,
        last_ttft_ms: null,
        last_latency_ms: null,
        last_ts: 0,
        last_status_code: null,
      };
    }
    for (const r of lastRows) {
      if (!out[r.model]) out[r.model] = {};
      const ttft = Math.round(r.last_ttft_ms);
      const total = r.last_latency_ms > 0 ? Math.round(r.last_latency_ms) : null;
      const ts = r.last_ts || 0;
      const slot = out[r.model][r.provider_id];
      if (!slot) {
        out[r.model][r.provider_id] = {
          avg_ttft_ms: null, calls: 0, success: 0, last_ttft_ms: ttft, last_latency_ms: total, last_ts: ts,
          last_status_code: r.last_status_code ?? null,
        };
      } else if (!slot.last_ts || ts >= slot.last_ts) {
        slot.last_ttft_ms = ttft;
        slot.last_latency_ms = total;
        slot.last_ts = ts;
        slot.last_status_code = r.last_status_code ?? null;
      }
    }
    return mirrorProviderLatencyAliases(out);
  } catch (e) {
    console.error('[local-stats] queryModelProviderLatency failed:', e.message);
    return {};
  }
}

function queryDashboard(days = 1) {
  if (!db) return _empty();

  const DAY_S = 86400;
  const todaySince = todaySinceTs();
  // days=1 对齐「今日」口径（本地 0 点至今），与应用列表 apps:stats 一致；多日仍用滚动窗口
  const since = days === 1 ? todaySince : Math.floor(Date.now() / 1000) - days * DAY_S;

  // Total calls + tokens
  const tot = db.prepare(
    'SELECT COUNT(*) AS calls, SUM(input_tokens+output_tokens+cache_create_tokens+cache_read_tokens) AS tokens FROM requests WHERE ts >= ?'
  ).get(since);

  // Cost total for period
  const costRow = db.prepare(
    'SELECT SUM(cost_usd) AS total_cost FROM requests WHERE ts >= ?'
  ).get(since);

  // Agent/tool source breakdown by data_source
  const agentRows = db.prepare(
    "SELECT data_source, COUNT(*) AS calls, SUM(input_tokens+output_tokens+cache_create_tokens+cache_read_tokens) AS tokens FROM requests " +
    "WHERE ts >= ? AND data_source IS NOT NULL GROUP BY data_source ORDER BY calls DESC"
  ).all(since);

  // Tier breakdown
  const tierRows = db.prepare(
    "SELECT tier, COUNT(*) AS calls FROM requests WHERE ts >= ? GROUP BY tier"
  ).all(since);
  const tiers = { free: 0, p2p: 0, paid: 0 };
  for (const r of tierRows) if (r.tier in tiers) tiers[r.tier] = r.calls;

  // 今日：按小时聚合（请求 + Token + 费用）
  const hourly = queryHourlyTrend(todaySince);

  // 7/30 天：按日历日聚合
  const daily = days > 1 ? queryDailyTrend(days) : [];

  // Model ranking（排除 Cursor 等无 model 的会话源，避免 Read/Shell 等工具名误入）
  const excludeModelDs = dataSourcesWithoutModelStats();
  let modelSql =
    'SELECT model, COUNT(*) AS calls, SUM(input_tokens+output_tokens+cache_create_tokens+cache_read_tokens) AS tokens FROM requests ' +
    'WHERE ts >= ? AND model IS NOT NULL';
  if (excludeModelDs.length) {
    modelSql += ` AND (data_source IS NULL OR data_source NOT IN (${excludeModelDs.map(() => '?').join(',')}))`;
  }
  modelSql += ' GROUP BY model ORDER BY calls DESC';
  const models = rankableModels(db.prepare(modelSql).all(since, ...excludeModelDs));

  // 各模型经网关的 provider 用量（API / 订阅转 API 摊薄用）
  const modelProvSql =
    'SELECT model, provider_id, COUNT(*) AS calls, ' +
    'SUM(input_tokens+output_tokens+cache_create_tokens+cache_read_tokens) AS tokens ' +
    'FROM requests WHERE ts >= ? AND model IS NOT NULL AND data_source = \'proxy\' AND provider_id IS NOT NULL ' +
    'GROUP BY model, provider_id';
  const modelProvRows = db.prepare(modelProvSql).all(since);
  const modelProviders = {};
  for (const r of modelProvRows) {
    if (!modelProviders[r.model]) modelProviders[r.model] = {};
    modelProviders[r.model][r.provider_id] = { calls: r.calls || 0, tokens: r.tokens || 0 };
  }

  // Models that have ANY proxy request → 网关; others → 直连
  const modelGwSql =
    "SELECT DISTINCT model FROM requests WHERE ts >= ? AND model IS NOT NULL AND data_source = 'proxy'";
  const modelGwSet = new Set(db.prepare(modelGwSql).all(since).map(r => r.model));

  // 按量刊例价：仅 api-key + provider 有配置刊例价才计入
  let paygWhere = 'ts >= ?';
  const paygParams = { since };
  let paygModelWhere = 'ts >= ? AND model IS NOT NULL';
  const paygModelParams = [since];
  if (excludeModelDs.length) {
    const dsClause = ` AND (data_source IS NULL OR data_source NOT IN (${excludeModelDs.map(() => '?').join(',')}))`;
    paygModelWhere += dsClause;
    paygModelParams.push(...excludeModelDs);
  }
  const paygAll = _queryPaygCostMaps('ts >= @since', paygParams);
  const paygModels = _queryPaygCostMaps(paygModelWhere, paygModelParams);
  const paygModelProvider = _queryPaygCostByModelProvider(paygModelWhere, paygModelParams);

  // Per-key stats
  const keys = db.prepare(
    'SELECT api_key, COUNT(*) AS calls, SUM(input_tokens+output_tokens+cache_create_tokens+cache_read_tokens) AS tokens FROM requests ' +
    'WHERE ts >= ? AND api_key IS NOT NULL GROUP BY api_key ORDER BY calls DESC'
  ).all(since);

  // 平均延迟（首 Token 优先）：含 proxy 实时 + session 补录
  const latRow = db.prepare(
    'SELECT AVG(COALESCE(first_token_ms, latency_ms)) AS avg_ms FROM requests ' +
    'WHERE ts >= ? AND COALESCE(first_token_ms, latency_ms) IS NOT NULL AND COALESCE(first_token_ms, latency_ms) > 0'
  ).get(since);

  // Per-provider with tier + 按量费用（仅 provider 刊例价）
  const providers = db.prepare(
    'SELECT provider_id, tier, COUNT(*) AS calls, ' +
    'SUM(input_tokens+output_tokens+cache_create_tokens+cache_read_tokens) AS tokens ' +
    'FROM requests ' +
    'WHERE ts >= ? AND provider_id IS NOT NULL GROUP BY provider_id, tier ORDER BY calls DESC'
  ).all(since);

  return {
    total_calls:  tot.calls  || 0,
    total_tokens: tot.tokens || 0,
    total_cost:    costRow.total_cost || 0,
    agent_sources: agentRows.map(r => ({ source: r.data_source, calls: r.calls, tokens: r.tokens || 0 })),
    tiers,
    hourly,
    daily,
    models:    models.map(r => {
      const provMap = { ...(modelProviders[r.model] || {}) };
      const paygByProv = paygModelProvider[r.model] || {};
      for (const pid of Object.keys(provMap)) {
        provMap[pid] = { ...provMap[pid], cost_usd: paygByProv[pid] || 0 };
      }
      for (const pid of Object.keys(paygByProv)) {
        if (!provMap[pid]) provMap[pid] = { calls: 0, tokens: 0, cost_usd: paygByProv[pid] };
      }
      const providerIds = Object.keys(provMap).sort(
        (a, b) => (provMap[b].calls || 0) - (provMap[a].calls || 0),
      );
      return {
        model: r.model,
        calls: r.calls,
        tokens: r.tokens || 0,
        cost_usd: paygModels.byModel[r.model] || 0,
        tier: modelGwSet.has(r.model) ? 'proxy' : null,
        provider_id: providerIds[0] || null,
        provider_ids: providerIds,
        providers: provMap,
      };
    }),
    keys:      keys.map(r => ({ api_key: r.api_key, calls: r.calls, tokens: r.tokens || 0 })),
    providers: providers.map(r => ({
      id: r.provider_id, tier: r.tier, calls: r.calls, tokens: r.tokens || 0,
      cost_usd: paygAll.byProviderTier[`${r.provider_id}|${r.tier || ''}`] || 0,
    })),
    payg_usage_cost: paygAll.total,
    avg_latency_ms: latRow?.avg_ms ? Math.round(latRow.avg_ms) : null,
    model_provider_latency: queryModelProviderLatency(since),
  };
}

function _empty() {
  return {
    total_calls: 0, total_tokens: 0, total_cost: 0,
    tiers: { free: 0, p2p: 0, paid: 0 },
    hourly: queryHourlyTrend(todaySinceTs()),
    daily: [],
    models: [], keys: [], providers: [], agent_sources: [],
    payg_usage_cost: 0,
    avg_latency_ms: null,
    model_provider_latency: {},
  };
}

/**
 * 单个应用的用量明细（合并 proxy 实时 + session-* 会话补录，靠 request_id 已在写入时去重）。
 * 归属规则（与 queryByApp 一致，三路 OR、互不重复计）：
 *   - app_id 命中（新数据，最准）
 *   - 旧数据按 api_key 兜底（app_id 为空）
 *   - shim 应用「不走网关、直连官方」的部分按 data_source（session-claude/codex/gemini）
 * 返回：总计 / 来源拆分(网关 vs 会话) / 按模型 / 按会话(session_id) / 最近明细。
 */
function queryAppDetail({ appId, apiKey, dataSource, dataSources, days = 30, limit = 50, includeSessionImport = true } = {}) {
  const empty = { total: { calls: 0, tokens: 0, inTok: 0, outTok: 0, cached: 0, lastTs: null, totalCost: 0 }, bySource: [], byModel: [], sessions: [], recent: [] };
  const match = _appMatchParts({ appId, apiKey, dataSource, dataSources, includeSessionImport });
  if (!db || !match) return empty;
  // days=1 对齐本地 0 点（与 queryTodaySummary / queryDashboard 一致），其余用滚动窗口
  const since = days === 1 ? todaySinceTs() : Math.floor(Date.now() / 1000) - days * 86400;
  const where = `${match.where} AND ts >= @since`;
  const p = { ...match.params, since };
  try {
    const total = db.prepare(
      `SELECT COUNT(*) AS calls, SUM(input_tokens+output_tokens+cache_create_tokens+cache_read_tokens) AS tokens, ` +
      `SUM(input_tokens) AS inTok, SUM(output_tokens) AS outTok, SUM(cache_read_tokens) AS cached, MAX(ts) AS lastTs, ` +
      `SUM(cost_usd) AS totalCost FROM requests WHERE ${where}`
    ).get(p);
    const bySource = db.prepare(
      `SELECT CASE WHEN data_source='proxy' THEN 'proxy' ELSE 'session' END AS src, ` +
      `COUNT(*) AS calls, SUM(input_tokens+output_tokens+cache_create_tokens+cache_read_tokens) AS tokens FROM requests WHERE ${where} GROUP BY src`
    ).all(p);
    const byModel = db.prepare(
      `SELECT model, COUNT(*) AS calls, SUM(input_tokens+output_tokens+cache_create_tokens+cache_read_tokens) AS tokens FROM requests ` +
      `WHERE ${where} AND model IS NOT NULL AND model != '' ` +
      `AND (input_tokens+output_tokens+cache_create_tokens+cache_read_tokens) > 0 ` +
      `GROUP BY model ORDER BY calls DESC`
    ).all(p);
    const sessions = db.prepare(
      `SELECT session_id, COUNT(*) AS calls, SUM(input_tokens+output_tokens+cache_create_tokens+cache_read_tokens) AS tokens, ` +
      `MIN(ts) AS firstTs, MAX(ts) AS lastTs FROM requests ` +
      `WHERE ${where} AND session_id IS NOT NULL GROUP BY session_id ORDER BY lastTs DESC LIMIT @lim`
    ).all({ ...p, lim: limit });
    const recent = db.prepare(
      `SELECT ts, model, input_tokens AS inTok, output_tokens AS outTok, cache_read_tokens AS cached, ` +
      `(input_tokens+output_tokens+cache_create_tokens+cache_read_tokens) AS tokens, ` +
      `data_source AS source, status_code, session_id, provider_id, cost_usd, billing_type, latency_ms, first_token_ms, request_id FROM requests ` +
      `WHERE ${where} ORDER BY ts DESC LIMIT @lim`
    ).all({ ...p, lim: limit });
    return {
      total: { calls: total.calls || 0, tokens: total.tokens || 0, inTok: total.inTok || 0, outTok: total.outTok || 0, cached: total.cached || 0, lastTs: total.lastTs || null, totalCost: total.totalCost || 0 },
      bySource: bySource.map(r => ({ source: r.src, calls: r.calls, tokens: r.tokens || 0 })),
      byModel: rankableModels(byModel).map(r => ({ model: r.model, calls: r.calls, tokens: r.tokens || 0 })),
      sessions: sessions.map(r => ({ session_id: r.session_id, calls: r.calls, tokens: r.tokens || 0, firstTs: r.firstTs, lastTs: r.lastTs })),
      recent: recent.map(r => ({ ts: r.ts, model: r.model, inTok: r.inTok || 0, outTok: r.outTok || 0, cached: r.cached || 0, tokens: r.tokens || 0, source: r.source, status_code: r.status_code, session_id: r.session_id, provider_id: r.provider_id, cost_usd: r.cost_usd || 0, billing_type: r.billing_type || null, latency_ms: r.latency_ms || null, first_token_ms: r.first_token_ms || null, request_id: r.request_id || null })),
    };
  } catch (e) { console.error('[local-stats] queryAppDetail failed:', e.message); return empty; }
}

/** 单会话 DB 汇总（Trace 顶栏 Token / 持续时间 / 费用补全） */
function querySessionDetail(sessionId, { hookOnly = false } = {}) {
  if (!db || !sessionId) return null;
  try {
    const hookClause = hookOnly ? " AND request_id LIKE 'cursor-hook:%'" : '';
    const row = db.prepare(
      `SELECT COUNT(*) AS calls, SUM(input_tokens) AS inTok, SUM(output_tokens) AS outTok, ` +
      `SUM(cache_read_tokens) AS cached, MIN(ts) AS firstTs, MAX(ts) AS lastTs ` +
      `FROM requests WHERE session_id = @sid${hookClause}`
    ).get({ sid: sessionId });
    if (!row) return null;
    const costRows = db.prepare(
      `SELECT model, provider_id, SUM(input_tokens) AS inTok, SUM(output_tokens) AS outTok, ` +
      `SUM(cache_create_tokens) AS cCreate, SUM(cache_read_tokens) AS cRead, SUM(cost_usd) AS storedCost ` +
      `FROM requests WHERE session_id = @sid${hookClause} GROUP BY model, provider_id`
    ).all({ sid: sessionId });
    let cost_usd = 0;
    for (const r of costRows) cost_usd += _sessionCostPart(r);
    return { ...row, cost_usd };
  } catch (e) {
    console.error('[local-stats] querySessionDetail failed:', e.message);
    return null;
  }
}

/** 按 session_id + model 聚合 token 估算费用（库内 cost_usd 为 0 时用刊例价重算） */
function _sessionCostPart(row) {
  const stored = row.storedCost || 0;
  if (stored > 0) return stored;
  return estimateCost(
    row.model,
    row.inTok || 0,
    row.outTok || 0,
    row.cCreate || 0,
    row.cRead || 0,
    resolvePricingProviderId(row.provider_id),
  );
}

/** 全库按 session_id 聚合用量与费用（供会话列表合并 DB 统计） */
function querySessionStatsMap() {
  if (!db) return {};
  try {
    const agg = db.prepare(
      `SELECT session_id, COUNT(*) AS calls, ` +
      `SUM(input_tokens) AS inTok, SUM(output_tokens) AS outTok, ` +
      `SUM(input_tokens+output_tokens+cache_create_tokens+cache_read_tokens) AS tokens, ` +
      `MAX(ts) AS lastTs FROM requests WHERE session_id IS NOT NULL GROUP BY session_id`
    ).all();
    const costRows = db.prepare(
      `SELECT session_id, model, provider_id, ` +
      `SUM(input_tokens) AS inTok, SUM(output_tokens) AS outTok, ` +
      `SUM(cache_create_tokens) AS cCreate, SUM(cache_read_tokens) AS cRead, ` +
      `SUM(cost_usd) AS storedCost ` +
      `FROM requests WHERE session_id IS NOT NULL ` +
      `GROUP BY session_id, model, provider_id`
    ).all();
    const costBySid = {};
    for (const r of costRows) {
      if (!r.session_id) continue;
      costBySid[r.session_id] = (costBySid[r.session_id] || 0) + _sessionCostPart(r);
    }
    const out = {};
    for (const r of agg) {
      if (!r.session_id) continue;
      out[r.session_id] = {
        calls: r.calls || 0,
        inTok: r.inTok || 0,
        outTok: r.outTok || 0,
        tokens: r.tokens || 0,
        lastTs: r.lastTs || null,
        cost_usd: costBySid[r.session_id] || 0,
      };
    }
    return out;
  } catch (e) {
    console.error('[local-stats] querySessionStatsMap failed:', e.message);
    return {};
  }
}

function close() {
  if (db) {
    db.close();
    db = null;
    _insertStmt = null;
    _getImportStateStmt = null;
    _setImportStateStmt = null;
    _enrichByRequestIdStmt = null;
    _insertSkillCallStmt = null;
    _deleteSkillCallsByPathStmt = null;
    _insertToolCallStmt = null;
    _deleteToolCallsByPathStmt = null;
  }
}

/** 按 api_key 查单个应用的统计（api-key 类 app）。*/
function queryByApiKey(apiKey) {
  if (!db || !apiKey) return { calls: 0, tokens: 0, lastTs: null };
  try {
    const r = db.prepare(
      'SELECT COUNT(*) AS calls, SUM(input_tokens+output_tokens+cache_create_tokens+cache_read_tokens) AS tokens, MAX(ts) AS lastTs ' +
      'FROM requests WHERE api_key = ?'
    ).get(apiKey);
    return { calls: r.calls || 0, tokens: r.tokens || 0, lastTs: r.lastTs || null };
  } catch { return { calls: 0, tokens: 0, lastTs: null }; }
}

/**
 * 按稳定的 app_id 查单个应用的统计（api-key 类 app）。
 * 统计跟着应用走，不受 api_key 变化 / 取消重新纳管影响（与 shim 用 data_source 同理）。
 * 兼容旧数据：旧行没有 app_id（NULL），用 api_key 兜底匹配（且避免与新行重复计）。
 * dataSource 可选：并入该应用的会话补录用量（如 Claude Desktop 的 Cowork/Code 本地用量
 * = session-claude-desktop）。三路 OR 互斥、SQL 一行只计一次，不会重复计。
 */
function queryByApp(appId, apiKey, dataSource, dataSources) {
  const match = _appMatchParts({ appId, apiKey, dataSource, dataSources });
  if (!db || !match) return { calls: 0, tokens: 0, lastTs: null };
  try {
    const r = db.prepare(
      'SELECT COUNT(*) AS calls, SUM(input_tokens+output_tokens+cache_create_tokens+cache_read_tokens) AS tokens, MAX(ts) AS lastTs ' +
      `FROM requests WHERE ${match.where}`
    ).get(match.params);
    return { calls: r.calls || 0, tokens: r.tokens || 0, lastTs: r.lastTs || null };
  } catch { return { calls: 0, tokens: 0, lastTs: null }; }
}

/** 本地时区当天 0 点（unix 秒） */
function todaySinceTs() {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  return Math.floor(midnight.getTime() / 1000);
}

/** 与 queryDashboard 一致的时间窗口起点（秒，对齐 requests.ts） */
function sinceTsForDays(days) {
  const d = Math.max(1, parseInt(days, 10) || 1);
  return d === 1 ? todaySinceTs() : Math.floor(Date.now() / 1000) - d * 86400;
}

/**
 * skill_calls / tool_calls / agent_task_steps 写入的是毫秒时间戳，
 * 查询窗口需换算，否则「今日」会把全历史都算进去（虚高）。
 */
function sinceMsForDays(days) {
  return sinceTsForDays(days) * 1000;
}

/**
 * 网关实际路由模型的 input 刊例价加权（$ / input token）。
 * 压缩日志里的 model 是客户端名（如 claude-opus），费用应以此处真实模型为准。
 */
function queryGatewayInputCostRate(sinceTs) {
  const empty = { totalInputTokens: 0, totalInputCostUsd: 0, byModel: {} };
  if (!db) return empty;
  try {
    const rows = db.prepare(
      'SELECT model, provider_id, SUM(input_tokens) AS inTok FROM requests ' +
      'WHERE ts >= ? AND data_source = \'proxy\' AND model IS NOT NULL AND input_tokens > 0 ' +
      'GROUP BY model, provider_id'
    ).all(sinceTs);
    let totalInputTokens = 0;
    let totalInputCostUsd = 0;
    const byModel = {};
    for (const r of rows) {
      const inTok = r.inTok || 0;
      if (!inTok) continue;
      const pid = resolvePricingProviderId(r.provider_id);
      // 压缩省的是 input token，仅按 input 侧计费
      let inputCost = estimatePaygCost(r.model, inTok, 0, 0, 0, pid);
      if (inputCost <= 0) inputCost = estimateCost(r.model, inTok, 0, 0, 0, pid);
      totalInputTokens += inTok;
      totalInputCostUsd += inputCost;
      if (!byModel[r.model]) byModel[r.model] = { inputTokens: 0, inputCostUsd: 0 };
      byModel[r.model].inputTokens += inTok;
      byModel[r.model].inputCostUsd += inputCost;
    }
    return { totalInputTokens, totalInputCostUsd, byModel };
  } catch (e) {
    console.error('[local-stats] queryGatewayInputCostRate failed:', e.message);
    return empty;
  }
}

/** 今日按小时趋势 → [{ hour, calls, tokens, cost_usd, isNow }] */
function queryHourlyTrend(since) {
  if (!db) return Array.from({ length: 24 }, (_, hour) => ({ hour, calls: 0, tokens: 0, cost_usd: 0, isNow: false }));
  const nowH = new Date().getHours();
  const buckets = Array.from({ length: 24 }, (_, hour) => ({
    hour, calls: 0, tokens: 0, cost_usd: 0, isNow: hour === nowH,
  }));
  const rows = db.prepare(
    "SELECT CAST(strftime('%H', ts, 'unixepoch', 'localtime') AS INTEGER) AS h, " +
    'COUNT(*) AS calls, ' +
    'SUM(input_tokens+output_tokens+cache_create_tokens+cache_read_tokens) AS tokens ' +
    'FROM requests WHERE ts >= ? GROUP BY h'
  ).all(since);
  for (const r of rows) {
    if (r.h >= 0 && r.h < 24) {
      buckets[r.h].calls = r.calls;
      buckets[r.h].tokens = r.tokens || 0;
    }
  }
  _fillPaygCostForBuckets(buckets, since, 'hour');
  return buckets;
}

/** 近 N 天每日趋势（本地日历日）→ [{ date, calls, tokens, cost_usd, isToday }] */
function queryDailyTrend(numDays) {
  if (!db || numDays < 2) return [];
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (numDays - 1));
  const since = Math.floor(start.getTime() / 1000);

  const rows = db.prepare(
    "SELECT date(ts, 'unixepoch', 'localtime') AS d, COUNT(*) AS calls, " +
    'SUM(input_tokens+output_tokens+cache_create_tokens+cache_read_tokens) AS tokens ' +
    'FROM requests WHERE ts >= ? GROUP BY d'
  ).all(since);
  const byDay = Object.fromEntries(rows.map(r => [r.d, { calls: r.calls, tokens: r.tokens || 0 }]));

  const todayKey = new Date().toLocaleDateString('sv-SE');
  const buckets = [];
  for (let i = numDays - 1; i >= 0; i--) {
    const dt = new Date();
    dt.setHours(0, 0, 0, 0);
    dt.setDate(dt.getDate() - i);
    const key = dt.toLocaleDateString('sv-SE');
    const row = byDay[key] || { calls: 0, tokens: 0 };
    buckets.push({
      date: key,
      calls: row.calls || 0,
      tokens: row.tokens || 0,
      cost_usd: 0,
      isToday: key === todayKey,
    });
  }
  _fillPaygCostForBuckets(buckets, since, 'date');
  return buckets;
}

/** 今日 Token 汇总（上行 input / 下行 output），供托盘与状态栏轻量查询 */
function queryTodaySummary() {
  const empty = { inTok: 0, outTok: 0, totalTokens: 0, calls: 0 };
  if (!db) return empty;
  try {
    const since = todaySinceTs();
    const r = db.prepare(
      'SELECT COUNT(*) AS calls, SUM(input_tokens) AS inTok, SUM(output_tokens) AS outTok, ' +
      'SUM(input_tokens+output_tokens+cache_create_tokens+cache_read_tokens) AS totalTokens ' +
      'FROM requests WHERE ts >= ?'
    ).get(since);
    return {
      inTok: r.inTok || 0,
      outTok: r.outTok || 0,
      totalTokens: r.totalTokens || 0,
      calls: r.calls || 0,
    };
  } catch (e) {
    console.error('[local-stats] queryTodaySummary failed:', e.message);
    return empty;
  }
}

/** 归一化 dataSource / dataSources → 去重后的非空数组 */
function _normDataSources(dataSource, dataSources) {
  if (Array.isArray(dataSources) && dataSources.length) {
    return [...new Set(dataSources.filter(Boolean))];
  }
  return dataSource ? [dataSource] : [];
}

/** 是否有 app_id / api_key / data_source 任一归属条件 */
function _appMatchHasCriteria({ appId, apiKey, dataSource, dataSources } = {}) {
  return !!(appId || apiKey || _normDataSources(dataSource, dataSources).length);
}

/**
 * 应用归属 WHERE + 绑定参数。
 * linked_data_sources 可含 session-claude + session-claude-desktop 等，须全部 OR 进查询。
 */
function _appMatchParts({ appId, apiKey, dataSource, dataSources, includeSessionImport = true } = {}) {
  const dsList = _normDataSources(dataSource, dataSources);
  if (!appId && !apiKey && !dsList.length) return null;

  const parts = [
    '(@appId IS NOT NULL AND app_id = @appId)',
    '(@apiKey IS NOT NULL AND app_id IS NULL AND api_key = @apiKey)',
  ];
  const params = { appId: appId || null, apiKey: apiKey || null };
  if (dsList.length) {
    const ph = dsList.map((d, i) => {
      params[`ds${i}`] = d;
      return `@ds${i}`;
    }).join(',');
    parts.push(`data_source IN (${ph})`);
  }
  let where = '(' + parts.join(' OR ') + ')';
  if (!includeSessionImport) where += " AND data_source = 'proxy'";
  return { where, params };
}

/** @deprecated 使用 _appMatchParts */
function _appMatchWhere(includeSessionImport = true) {
  return '(' +
    '(@appId IS NOT NULL AND app_id = @appId) OR ' +
    '(@apiKey IS NOT NULL AND app_id IS NULL AND api_key = @apiKey) OR ' +
    '(@dataSource IS NOT NULL AND data_source = @dataSource)' +
    ')' + (includeSessionImport ? '' : " AND data_source = 'proxy'");
}

/** 时间窗内各 provider_id 的调用活跃度（托盘供给源排序/过滤用） */
function queryProviderActivity(days = 3) {
  if (!db) return [];
  const since = sinceTsForDays(days);
  try {
    return db.prepare(
      'SELECT provider_id AS providerId, COUNT(*) AS calls, ' +
      'SUM(input_tokens+output_tokens+cache_create_tokens+cache_read_tokens) AS tokens, ' +
      'MAX(ts) AS lastTs FROM requests ' +
      'WHERE ts >= ? AND provider_id IS NOT NULL AND provider_id != \'\' ' +
      'GROUP BY provider_id ORDER BY calls DESC'
    ).all(since).map((r) => ({
      providerId: String(r.providerId || ''),
      calls: r.calls || 0,
      tokens: r.tokens || 0,
      lastTs: r.lastTs || null,
    })).filter((r) => r.providerId && r.calls > 0);
  } catch (e) {
    console.error('[local-stats] queryProviderActivity failed:', e.message);
    return [];
  }
}

/** 时间窗口内单个应用用量（与 queryAppDetail / apps:stats 归属规则一致） */
function queryAppStatsInPeriod({ appId, apiKey, dataSource, dataSources, days = 30, since: sinceTs, includeSessionImport = true } = {}) {
  const empty = {
    calls: 0, tokens: 0, cost: 0, lastTs: null,
    proxyCalls: 0, sessionCalls: 0, proxyTokens: 0, sessionTokens: 0,
    providers: {},
  };
  const match = _appMatchParts({ appId, apiKey, dataSource, dataSources, includeSessionImport });
  if (!db || !match) return empty;
  // 和盘点总数同一个口径：1 天 = 本地 0 点至今，多天 = 滚动窗口。否则「今天」的应用用量会多出昨天的
  const since = sinceTs != null ? sinceTs : sinceTsForDays(days);
  const where = `${match.where} AND ts >= @since`;
  const p = { ...match.params, since };
  try {
    const total = db.prepare(
      `SELECT COUNT(*) AS calls, SUM(input_tokens+output_tokens+cache_create_tokens+cache_read_tokens) AS tokens, ` +
      `MAX(ts) AS lastTs FROM requests WHERE ${where}`
    ).get(p);
    const paygCost = _queryPaygCostMaps(`${where}`, p).total;
    const bySource = db.prepare(
      `SELECT CASE WHEN data_source='proxy' THEN 'proxy' ELSE 'session' END AS src, ` +
      `COUNT(*) AS calls, SUM(input_tokens+output_tokens+cache_create_tokens+cache_read_tokens) AS tokens ` +
      `FROM requests WHERE ${where} GROUP BY src`
    ).all(p);
    const proxy = bySource.find(r => r.src === 'proxy') || {};
    const session = bySource.find(r => r.src === 'session') || {};
    const byProvider = db.prepare(
      `SELECT provider_id, COUNT(*) AS calls, ` +
      `SUM(input_tokens+output_tokens+cache_create_tokens+cache_read_tokens) AS tokens ` +
      `FROM requests WHERE ${where} AND data_source = 'proxy' AND provider_id IS NOT NULL GROUP BY provider_id`
    ).all(p);
    const providers = {};
    for (const r of byProvider) {
      providers[r.provider_id] = { calls: r.calls || 0, tokens: r.tokens || 0 };
    }
    return {
      calls: total.calls || 0,
      tokens: total.tokens || 0,
      cost: paygCost,
      lastTs: total.lastTs || null,
      proxyCalls: proxy.calls || 0,
      sessionCalls: session.calls || 0,
      proxyTokens: proxy.tokens || 0,
      sessionTokens: session.tokens || 0,
      providers,
    };
  } catch (e) {
    console.error('[local-stats] queryAppStatsInPeriod failed:', e.message);
    return empty;
  }
}

/** 当天（本地 0 点至今）请求/Token；lastTs 为历史最近使用时间（不限当天） */
function queryAppStatsToday({ appId, apiKey, dataSource, dataSources, includeSessionImport = true } = {}) {
  const today = queryAppStatsInPeriod({ appId, apiKey, dataSource, dataSources, since: todaySinceTs(), includeSessionImport });
  let lastTs = null;
  let models = [];
  const match = _appMatchParts({ appId, apiKey, dataSource, dataSources, includeSessionImport });
  if (db && match) {
    try {
      const r = db.prepare(`SELECT MAX(ts) AS lastTs FROM requests WHERE ${match.where}`).get(match.params);
      lastTs = r.lastTs || null;
      models = db.prepare(`SELECT DISTINCT model FROM requests WHERE ${match.where} AND ts >= @since AND data_source = 'proxy' AND model IS NOT NULL`)
        .all({ ...match.params, since: todaySinceTs() }).map(x => x.model);
    } catch { /* ignore */ }
  }
  // cost / providers / models：应用列表「今天怎样」显示花费；据今天用过的来源和模型判断要不要提示（Key 失效等，
  // 网关已经换到别的来源时，记录里是最后成功的来源，所以还要按模型对）
  return { calls: today.calls, tokens: today.tokens, lastTs, cost: today.cost || 0, providers: Object.keys(today.providers || {}), models };
}

/** 按 data_source 查单个工具的统计（shim 类 app 用 session-claude / session-codex 等）。*/
function queryByDataSource(dataSource) {
  if (!db || !dataSource) return { calls: 0, tokens: 0, lastTs: null };
  try {
    const r = db.prepare(
      'SELECT COUNT(*) AS calls, SUM(input_tokens+output_tokens+cache_create_tokens+cache_read_tokens) AS tokens, MAX(ts) AS lastTs ' +
      'FROM requests WHERE data_source = ?'
    ).get(dataSource);
    return { calls: r.calls || 0, tokens: r.tokens || 0, lastTs: r.lastTs || null };
  } catch { return { calls: 0, tokens: 0, lastTs: null }; }
}

// 清 import_state 让 session-import 重扫，不删 requests（proxy 行保留，靠 enrich 合并 token）
function resetImportState(pathLike) {
  if (!db || !pathLike) return false;
  try {
    db.prepare('DELETE FROM import_state WHERE path LIKE ?').run(pathLike);
    return true;
  } catch (e) {
    console.error('[local-stats] resetImportState failed:', e.message);
    return false;
  }
}

// 一次性迁移用：删除指定 data_source 的会话记录 + 清掉匹配文件的导入状态，
// 让 session-import 重扫这些文件、按新规则（entrypoint）重新归属。proxy 实时记录不受影响。
// 返回 true=已执行；false=库未就绪或失败。
function resetSessionData(dataSources, pathLike) {
  if (!db) return false;
  try {
    if (Array.isArray(dataSources) && dataSources.length) {
      const ph = dataSources.map(() => '?').join(',');
      db.prepare(`DELETE FROM requests WHERE data_source IN (${ph})`).run(...dataSources);
    }
    if (pathLike) db.prepare('DELETE FROM import_state WHERE path LIKE ?').run(pathLike);
    return true;
  } catch (e) {
    console.error('[local-stats] resetSessionData failed:', e.message);
    return false;
  }
}

/** 列出所有会话叠加层元数据（供聚合 left-join）。 */
function listSessionMeta() {
  if (!db) return [];
  try {
    return db.prepare(
      'SELECT agent_id, session_id, favorite, tags, note, archived FROM session_meta'
    ).all();
  } catch (e) {
    console.error('[local-stats] listSessionMeta failed:', e.message);
    return [];
  }
}

/** 读取单条会话元数据。 */
function getSessionMeta(agent_id, session_id) {
  if (!db) return null;
  try {
    return db.prepare(
      'SELECT agent_id, session_id, favorite, tags, note, archived FROM session_meta WHERE agent_id = ? AND session_id = ?'
    ).get(agent_id, session_id) || null;
  } catch (e) {
    console.error('[local-stats] getSessionMeta failed:', e.message);
    return null;
  }
}

/** 删除 transcript 补录产生的 0 token 行（hook 纳管后清理历史脏数据） */
function deleteZeroTokenSessionRows({ dataSource, requestIdLike } = {}) {
  if (!db || !dataSource || !requestIdLike) return 0;
  try {
    const r = db.prepare(
      'DELETE FROM requests WHERE data_source = ? AND request_id LIKE ? ' +
      'AND input_tokens = 0 AND output_tokens = 0 AND cache_read_tokens = 0 AND cache_create_tokens = 0'
    ).run(dataSource, requestIdLike);
    return r.changes || 0;
  } catch (e) {
    console.error('[local-stats] deleteZeroTokenSessionRows failed:', e.message);
    return 0;
  }
}

/** Upsert 会话元数据；仅写入传入的字段，其余沿用旧值。返回合并后的行。 */
function setSessionMeta({ agent_id, session_id, favorite, tags, note, archived } = {}) {
  if (!db || !agent_id || !session_id) return null;
  try {
    const prev = getSessionMeta(agent_id, session_id) || {};
    const next = {
      favorite: favorite != null ? (favorite ? 1 : 0) : (prev.favorite || 0),
      tags:     tags != null ? (Array.isArray(tags) ? tags.join(',') : String(tags)) : (prev.tags || ''),
      note:     note != null ? String(note) : (prev.note || ''),
      archived: archived != null ? (archived ? 1 : 0) : (prev.archived || 0),
    };
    db.prepare(
      'INSERT INTO session_meta (agent_id, session_id, favorite, tags, note, archived, updated_at) ' +
      'VALUES (?,?,?,?,?,?,?) ' +
      'ON CONFLICT(agent_id, session_id) DO UPDATE SET ' +
      'favorite=excluded.favorite, tags=excluded.tags, note=excluded.note, ' +
      'archived=excluded.archived, updated_at=excluded.updated_at'
    ).run(agent_id, session_id, next.favorite, next.tags, next.note, next.archived, Date.now());
    return getSessionMeta(agent_id, session_id);
  } catch (e) {
    console.error('[local-stats] setSessionMeta failed:', e.message);
    return null;
  }
}

module.exports = {
  init, record, queryDashboard, queryTodaySummary, queryByApiKey, queryByApp, queryByDataSource,
  queryAppDetail, queryAppStatsInPeriod, queryAppStatsToday, querySessionDetail, querySessionStatsMap,
  getImportState, setImportState, resetSessionData, resetImportState, deleteZeroTokenSessionRows, close,
  listSessionMeta, getSessionMeta, setSessionMeta,
  recordSkillCalls, deleteSkillCallsBySourcePath, getSkillLastUsedMap, getSkillCallStatsMap,
  recordToolCalls, deleteToolCallsBySourcePath,
  querySkillUsageStats, queryToolUsageStats, queryMcpUsageStats,
  todaySinceTs, sinceTsForDays, sinceMsForDays, queryGatewayInputCostRate, queryModelProviderLatency,
  queryProviderActivity,
  reassignProviderTier, collectProviderIdVariants,
  getDb: () => db,  // Agent 聚合系统使用
  ensureReady,
  requireDb,
};
