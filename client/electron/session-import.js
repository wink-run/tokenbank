// client/electron/session-import.js
// YAML 驱动的会话用量解释器：补录「不走本网关、直连官方」的用量。
//
// 解析规则全部来自 config-loader 的 session_sources（见 tokenbank.default.yaml）。
// 新增一个工具的会话统计 = 加一段 YAML（声明式：路径/glob/字段映射/去重键），
// 不用改这里的代码。仅两类过程式逻辑由内置开关处理：
//   - accumulate：token_count 事件携带「累计」用量 → 取相邻增量（Codex）。
//   - meta：JSONL 里的元信息行更新运行中的 model / session_id（Codex）。
//
// 去重：每条记录带 request_id，写库走 INSERT OR IGNORE。Claude 用 message.id
// （= 走网关时上游响应 id），所以「走过网关 + 又落进会话文件」的同一次调用只记一次；
// Codex/Gemini 用合成键，保证重复扫描同一文件不会重复计。
//
// 增量：用 local-stats 的 import_state 表记录每个文件的 mtime/size，未变更则跳过。
'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { estimateCost } = require('./pricing');
const { resolvePricingProviderId } = require('./billing-config');
const { iterFileLines, iterZstdJsonlLines, countJsonlLines, MAX_JSONL_FILE_BYTES, STREAM_THRESHOLD_BYTES } = require('./jsonl-lines');

// 大文件兜底：启动时 run() 同步扫描所有会话文件，单个文件 readFileSync 一次性载入会撑爆内存。
// 曾有用户的 Codex rollout JSONL 达 ~1GB，0.5.4 启动首屏前就 OOM 崩溃。
//   - 超过硬上限：直接跳过并 markDone（宁可漏这一份，也不让整个应用起不来）。
//   - 超过流式阈值：逐行流式读取，避免 readFileSync + split('\n') 的双份整文件拷贝。
const MAX_IMPORT_FILE_BYTES = MAX_JSONL_FILE_BYTES;

// 各 Agent 默认计费类型：优先读 session_sources.billing_type（来自 handler/session-scans）
function resolveBillingType(src) {
  return src.billing_type || 'api-key';
}

/** 会话补录行的 cost_usd / billing_type（与网关 recordStats 一致） */
function recordExtras(src, model, inTok, outTok, cCreate, cRead) {
  return {
    cost_usd:     estimateCost(model, inTok, outTok, cCreate, cRead, resolvePricingProviderId(src.provider_id)),
    billing_type: resolveBillingType(src),
  };
}

/**
 * 从会话记录解析延迟（毫秒）。来源因 Agent 而异：
 * - OpenCode：time.completed - time.created（YAML latency_from）
 * - Codex：jsonl 扫描在 ctx 注入 task_complete 的 duration_ms / time_to_first_token_ms
 * - Claude/Gemini/Cursor 等：会话文件通常不含 API 延迟，返回空
 */
function resolveTiming(rec, src, ctx) {
  if (ctx.latency_ms != null || ctx.first_token_ms != null) {
    return {
      latency_ms:     ctx.latency_ms     != null ? num(ctx.latency_ms)     : null,
      first_token_ms: ctx.first_token_ms != null ? num(ctx.first_token_ms) : null,
    };
  }
  const lf = src.latency_from;
  if (lf) {
    const start = getPath(rec, lf.start);
    const end   = getPath(rec, lf.end);
    if (Number.isFinite(+start) && Number.isFinite(+end) && +end >= +start) {
      const ms = Math.round(+end - +start);
      return { latency_ms: ms, first_token_ms: lf.first_token ? ms : null };
    }
  }
  const f = src.fields || {};
  const latency_ms     = f.latency_ms     ? num(getPath(rec, f.latency_ms))     : null;
  const first_token_ms = f.first_token_ms ? num(getPath(rec, f.first_token_ms)) : null;
  if (latency_ms || first_token_ms) {
    return {
      latency_ms:     latency_ms     || null,
      first_token_ms: first_token_ms || null,
    };
  }
  return {};
}

// ── 通用辅助 ────────────────────────────────────────────────────────────────

function expandHome(p) {
  if (typeof p !== 'string') return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

// 递归列出 dir 下满足 matchFn(relPath) 的文件（relPath 用 / 分隔、相对 root）。
function walk(root, matchFn) {
  const out = [];
  function rec(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      try {
        if (ent.isDirectory()) rec(full);
        else if (ent.isFile()) {
          const rel = path.relative(root, full).split(path.sep).join('/');
          if (matchFn(rel)) out.push(full);
        }
      } catch { /* 跳过坏链接/权限问题 */ }
    }
  }
  rec(root);
  return out;
}

// glob → 正则：** 跨目录、* 单段（不含 /）。
function globToRe(glob) {
  let re = '';
  const g = String(glob).replace(/\\/g, '/');
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') { re += '.*'; i++; if (g[i + 1] === '/') i++; }
      else re += '[^/]*';
    } else if ('.+?^${}()|[]\\'.includes(c)) re += '\\' + c;
    else re += c;
  }
  return new RegExp('^' + re + '$');
}

function unchanged(localStats, filePath, st) {
  const prev = localStats.getImportState(filePath);
  return !!prev && prev.mtime === Math.floor(st.mtimeMs) && prev.size === st.size;
}
function markDone(localStats, filePath, st) {
  localStats.setImportState(filePath, Math.floor(st.mtimeMs), st.size);
}

function tsSeconds(isoOrMsOrSec) {
  if (isoOrMsOrSec == null) return Math.floor(Date.now() / 1000);
  if (typeof isoOrMsOrSec === 'number') {
    const n = isoOrMsOrSec;
    // 毫秒（13 位）→ 秒；已是 Unix 秒（10 位，≥1e9）则不再除 1000
    if (n >= 1e12) return Math.floor(n / 1000);
    if (n >= 1e9) return Math.floor(n);
    return Math.floor(n);
  }
  const ms = Date.parse(isoOrMsOrSec);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : Math.floor(Date.now() / 1000);
}

function eachJsonlLine(filePath, fn) {
  let text;
  try { text = fs.readFileSync(filePath, 'utf8'); } catch { return; }
  let idx = 0;
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    let obj;
    try { obj = JSON.parse(s); } catch { continue; }
    fn(obj, idx++);
  }
}

// 取 dot-path 值；pathOrList 为数组时按序取第一个「已定义」的。
function getPath(obj, pathOrList) {
  if (pathOrList == null) return undefined;
  const list = Array.isArray(pathOrList) ? pathOrList : [pathOrList];
  for (const p of list) {
    if (p == null) continue;
    const parts = String(p).split('.');
    let cur = obj, ok = true;
    for (const k of parts) {
      if (cur != null && typeof cur === 'object' && k in cur) cur = cur[k];
      else { ok = false; break; }
    }
    if (ok && cur !== undefined) return cur;
  }
  return undefined;
}
const num = (v) => (Number.isFinite(+v) ? +v : 0);
const isEmpty = (v) => v === undefined || v === null || v === '';

// record_filter / meta.filter 匹配。支持 { field, equals } / { field, in:[...] }，
// in 配合 allow_missing:true 时「字段缺省」也算命中。
function matchFilter(obj, f) {
  if (!f) return true;
  // any: 多条件 OR（如 Pi 的 assistant 消息和独立 usage 行）
  if (Array.isArray(f.any)) return f.any.some(sub => matchFilter(obj, sub));
  // all: 多条件 AND（如 Kimi usage.record + usageScope=turn）
  if (Array.isArray(f.all)) return f.all.every(sub => matchFilter(obj, sub));
  const v = getPath(obj, f.field);
  if ('equals' in f) return v === f.equals;
  if ('not_equals' in f) return v !== f.not_equals;
  if ('in' in f) {
    if (f.allow_missing && isEmpty(v)) return true;
    return Array.isArray(f.in) && f.in.includes(v);
  }
  if ('present' in f) return !isEmpty(v);
  return true;
}

/** jsonl 会话 id：filename / path_re（捕获组 1，如 session_xxx） */
function resolveJsonlSessionId(src, file) {
  const mode = src.session_id_from;
  if (mode === 'filename') {
    return path.basename(file).replace(/\.[^.]+$/, '');
  }
  if (mode === 'path_re' && src.session_id_path_re) {
    try {
      const m = String(file).replace(/\\/g, '/').match(new RegExp(src.session_id_path_re));
      if (m) return m[1] || m[0];
    } catch { /* 无效正则则忽略 */ }
  }
  return undefined;
}

// 模板 request_id：{session_id} {index} {seq}，其余 {x} 从当前记录按 dot-path 取。
function fillTemplate(tpl, ctx, rec) {
  return String(tpl).replace(/\{([^}]+)\}/g, (_, key) => {
    if (key === 'session_id') return ctx.session_id != null ? String(ctx.session_id) : '';
    if (key === 'index') return String(ctx.index);
    if (key === 'seq')   return String(ctx.seq);
    const v = getPath(rec, key);
    return v != null ? String(v) : '';
  });
}

/** 按 data_source_map 规则解析 entrypoint → data_source */
function resolveDataSourceFromMap(dsm, entrypoint, fallback) {
  if (!dsm) return fallback;
  const ev = entrypoint;
  if (ev != null && dsm.map && (ev in dsm.map)) return dsm.map[ev];
  if (ev != null && dsm.prefix_map) {
    // 最长前缀优先（claude-desktop-3p 先于 claude-desktop）
    const prefixes = Object.keys(dsm.prefix_map).sort((a, b) => b.length - a.length);
    for (const prefix of prefixes) {
      if (String(ev).startsWith(prefix)) return dsm.prefix_map[prefix];
    }
  }
  return dsm.default || fallback;
}

/** Claude 会话 entrypoint → data_source（与 session-import 路由一致） */
function claudeDataSourceForEntrypoint(entrypoint) {
  let src;
  try { src = (require('./config-loader').sessionSources() || []).find(s => s.id === 'claude'); } catch {}
  return resolveDataSourceFromMap(src?.data_source_map, entrypoint, src?.data_source || 'session-claude');
}

// ── 单条记录的构建与写入（jsonl/json 共用）────────────────────────────────────
// rec=当前对象，ctx={ model, session_id, seq, index, prev } ，doc=整文件级回退源（json）。
// 返回 true=写入了一行新数据。
function emitRecord(localStats, src, rec, ctx, doc, dataSourceOverride = null) {
  // 用户关闭「用量导入」时仅扫描 trace，不写 local-stats
  if (src.session_usage_import === false) return false;
  const f = src.fields || {};

  // 必需字段
  for (const need of (src.require_fields || [])) {
    if (getPath(rec, need) === undefined) return false;
  }

  // token 数：accumulate（累计→增量）或直接取字段
  let inTok, outTok, cCreate = 0, cRead;
  if (src.accumulate) {
    const a = src.accumulate;
    const vi = getPath(rec, a.input), vo = getPath(rec, a.output), vc = getPath(rec, a.cached);
    if (vi === undefined && vo === undefined && vc === undefined) return false;  // 无累计用量 → 不动 prev、跳过
    const cur = { input: num(vi), output: num(vo), cached: num(vc) };
    inTok = Math.max(0, cur.input  - ctx.prev.input);
    outTok = Math.max(0, cur.output - ctx.prev.output);
    cRead = Math.max(0, cur.cached - ctx.prev.cached);
    ctx.prev = cur;
  } else {
    inTok  = num(getPath(rec, f.input_tokens));
    outTok = num(getPath(rec, f.output_tokens));
    if (f.output_extra) outTok += num(getPath(rec, f.output_extra));   // 如 OpenCode 的 reasoning 并入输出
    cCreate = num(getPath(rec, f.cache_create_tokens));
    cRead  = num(getPath(rec, f.cache_read_tokens));
  }
  if (src.skip_if_zero && inTok === 0 && outTok === 0 && cCreate === 0 && cRead === 0) return false;

  // model / session_id / ts（逐级回退：当前对象 → 运行上下文 → 整文件级）
  let model = f.model ? getPath(rec, f.model) : undefined;
  if (model === undefined) model = ctx.model;
  if (model === undefined && src.doc_fallback) model = getPath(doc, src.doc_fallback.model);

  let session_id = f.session_id ? getPath(rec, f.session_id) : undefined;
  if (session_id === undefined) session_id = ctx.session_id;

  let tsv = f.ts ? getPath(rec, f.ts) : undefined;
  if (tsv === undefined && src.doc_fallback) tsv = getPath(doc, src.doc_fallback.ts);

  if (tsv === undefined && ctx.estimated_ts_ms != null) tsv = ctx.estimated_ts_ms;

  // 无 model 时不把工具标签写入 model 字段（避免 Grep/Read 等误入模型排行）
  // record_label assistant_tools 仅用于会话明细展示，见 session-browser.enrichRecentDetail
  // request_id：模板 or 字段路径
  ctx.session_id = session_id;
  let request_id;
  if (typeof src.request_id === 'string' && src.request_id.includes('{')) {
    request_id = fillTemplate(src.request_id, ctx, rec);
  } else if (src.request_id) {
    request_id = getPath(rec, src.request_id);
  }
  if (src.require_request_id && isEmpty(request_id)) return false;

  // 跳过网关内部占位 model（Desktop 经 3p 转发时偶现）
  if (model === '<synthetic>') return false;

  // 按记录字段(如 entrypoint)路由 data_source；与 proxy 同 request_id 时 INSERT OR IGNORE 去重
  let dataSource = src.data_source;
  const dsm = src.data_source_map;
  if (dsm && dsm.field) {
    const ev = getPath(rec, dsm.field);
    if (ev != null && Array.isArray(dsm.skip) && dsm.skip.includes(ev)) return false;
    dataSource = resolveDataSourceFromMap(dsm, ev, src.data_source);
  }
  // 多账号：非默认 CONFIG_DIR 的会话用账号专属 data_source（如 'session-claude:claude-work'），
  // 使每个实例只匹配自己账号的会话、不与其它账号重复计数（skip 判定仍按上面的 map 生效）。
  if (dataSourceOverride) dataSource = dataSourceOverride;

  const timing = resolveTiming(rec, src, ctx);
  const ok = localStats.record({
    ts:                  tsSeconds(tsv),
    api_key:             null,
    model:               model != null ? model : null,
    provider_id:         src.provider_id || null,
    tier:                src.tier || 'paid',
    input_tokens:        inTok,
    output_tokens:       outTok,
    cache_create_tokens: cCreate,
    cache_read_tokens:   cRead,
    request_id:          request_id != null ? request_id : null,
    data_source:         dataSource,
    session_id:          session_id != null ? session_id : null,
    status_code:         200,
    is_streaming:        false,
    latency_ms:          timing.latency_ms     ?? null,
    first_token_ms:      timing.first_token_ms ?? null,
    ...recordExtras(src, model, inTok, outTok, cCreate, cRead),
  });
  if (ok) ctx.seq++;   // 仅写入成功才推进 seq（与旧逻辑一致）
  return ok;
}

// ── SQLite 源（如 OpenCode：~/.local/share/opencode/opencode.db）──────────────
// query 取行；json_column 那列是 JSON，解析后套用 fields/filter；行内其它标量列
// 并入记录对象（供 session_id/message_id 等字段与 request_id 模板引用）。
function importSqliteSource(localStats, src) {
  const dbPath = expandHome(src.db || '');
  let st; try { st = fs.statSync(dbPath); } catch { return { source: src.id, imported: 0, skipped: 0, files_scanned: 0 }; }
  // WAL 模式：新提交先落 -wal，主库 mtime 不变 → 取 db / -wal / -shm 的最大 mtime。
  let mtimeMs = st.mtimeMs;
  for (const ext of ['-wal', '-shm']) { try { mtimeMs = Math.max(mtimeMs, fs.statSync(dbPath + ext).mtimeMs); } catch {} }
  const synthSt = { mtimeMs, size: 0 };
  if (unchanged(localStats, dbPath, synthSt)) return { source: src.id, imported: 0, skipped: 0, files_scanned: 1 };

  let odb;
  try { odb = new (require('better-sqlite3'))(dbPath, { readonly: true, fileMustExist: true }); }
  catch (e) { return { source: src.id, imported: 0, skipped: 0, files_scanned: 1, error: e.message }; }

  let imported = 0;
  try {
    const rows = odb.prepare(src.query).all();
    const ctx = { model: undefined, session_id: undefined, seq: 0, index: 0, prev: { input: 0, output: 0, cached: 0 } };
    rows.forEach((row, idx) => {
      let rec;
      if (src.json_column) { try { rec = JSON.parse(row[src.json_column] || 'null'); } catch { return; } }
      else rec = row;
      if (rec == null || typeof rec !== 'object') return;
      // 把行里非 JSON 的标量列并进记录（不覆盖 JSON 已有键）
      for (const [k, v] of Object.entries(row)) { if (k !== src.json_column && !(k in rec)) rec[k] = v; }
      if (!matchFilter(rec, src.record_filter)) return;
      ctx.index = idx;
      if (emitRecord(localStats, src, rec, ctx, null)) imported++;
    });
  } catch (e) {
    try { odb.close(); } catch {}
    return { source: src.id, imported, skipped: 0, files_scanned: 1, error: e.message };
  }
  try { odb.close(); } catch {}
  markDone(localStats, dbPath, synthSt);
  return { source: src.id, imported, skipped: 0, files_scanned: 1 };
}

// ── Copilot CLI events.jsonl（copilot-events format）─────────────────────────
// 每个会话目录 (<sessId>/events.jsonl) 对应一次会话；token 优先取 session.shutdown
// 里的 modelMetrics，否则累加 assistant.message 事件里的 usage。
// request_id = "copilot:<sessId>:<model>" 保证跨扫描去重。
function importCopilotEventsSource(localStats, src) {
  const root  = expandHome(src.root || '');
  const re    = globToRe(src.glob || '*/events.jsonl');
  const files = root ? walk(root, rel => re.test(rel)) : [];
  let imported = 0, skipped = 0, files_scanned = 0;

  for (const file of files) {
    let st; try { st = fs.statSync(file); } catch { continue; }
    if (unchanged(localStats, file, st)) { skipped++; continue; }
    files_scanned++;

    const sessionId = path.basename(path.dirname(file));
    const events = [];
    eachJsonlLine(file, e => events.push(e));

    // Session start timestamp
    const startEvt = events.find(e => e.type === 'session.start');
    const ts = startEvt ? tsSeconds(startEvt.startTs || startEvt.ts || startEvt.timestamp) : Math.floor(st.mtimeMs / 1000);

    // Prefer session.shutdown modelMetrics (most accurate)
    const shutdownEvt = events.find(e => e.type === 'session.shutdown');
    const modelMetrics = shutdownEvt?.modelMetrics || shutdownEvt?.model_metrics || null;

    const records = {};  // modelName → { inTok, outTok }

    if (modelMetrics && typeof modelMetrics === 'object') {
      for (const [modelName, m] of Object.entries(modelMetrics)) {
        const inTok  = num(m.inputTokens  ?? m.input_tokens  ?? 0);
        const outTok = num(m.outputTokens ?? m.output_tokens ?? 0);
        if (inTok > 0 || outTok > 0) records[modelName] = { inTok, outTok };
      }
    }

    // Fall back to summing assistant.message usage when no shutdown metrics
    if (Object.keys(records).length === 0) {
      for (const e of events) {
        if (e.type !== 'assistant.message') continue;
        const model = e.model || 'github-copilot';
        if (!records[model]) records[model] = { inTok: 0, outTok: 0 };
        const u = e.usage || e.tokenUsage || {};
        records[model].inTok  += num(u.inputTokens  ?? u.input_tokens  ?? 0);
        records[model].outTok += num(u.outputTokens ?? u.output_tokens ?? 0);
      }
    }

    for (const [modelName, { inTok, outTok }] of Object.entries(records)) {
      if (inTok === 0 && outTok === 0) continue;
      const ok = localStats.record({
        ts,
        api_key:             null,
        model:               modelName,
        provider_id:         src.provider_id || null,
        tier:                src.tier || 'paid',
        input_tokens:        inTok,
        output_tokens:       outTok,
        cache_create_tokens: 0,
        cache_read_tokens:   0,
        request_id:          `copilot:${sessionId}:${modelName}`,
        data_source:         src.data_source,
        session_id:          sessionId,
        status_code:         200,
        is_streaming:        false,
        ...recordExtras(src, modelName, inTok, outTok, 0, 0),
      });
      if (ok) imported++;
    }

    markDone(localStats, file, st);
  }
  return { source: src.id || src.data_source, imported, skipped, files_scanned };
}

// ── Grok Build：~/.grok/sessions/<cwd>/<uuid>/summary.json + signals.json ───
function importGrokSessionsSource(localStats, src) {
  const root = expandHome(src.root || '~/.grok/sessions');
  const re   = globToRe('**/summary.json');
  const files = root ? walk(root, rel => re.test(rel)) : [];
  let imported = 0, skipped = 0, files_scanned = 0;

  for (const summaryPath of files) {
    let st; try { st = fs.statSync(summaryPath); } catch { continue; }
    if (unchanged(localStats, summaryPath, st)) { skipped++; continue; }
    files_scanned++;

    const sessDir   = path.dirname(summaryPath);
    const sessionId = path.basename(sessDir);
    let summary = {};
    try { summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8')); }
    catch { markDone(localStats, summaryPath, st); continue; }

    // Grok 无 prompt/completion 拆分：优先 signals.contextTokensUsed
    let totalTok = 0;
    try {
      const sig = JSON.parse(fs.readFileSync(path.join(sessDir, 'signals.json'), 'utf8'));
      const ctx = sig.contextTokensUsed;
      if (Number.isFinite(+ctx) && +ctx > 0) totalTok = +ctx;
    } catch {}

    if (src.skip_if_zero && totalTok === 0) { markDone(localStats, summaryPath, st); continue; }

    const model = summary.current_model_id || summary.currentModelId || 'grok-build';
    const tsRaw = summary.updated_at || summary.updatedAt || summary.created_at || summary.createdAt;
    const ok = localStats.record({
      ts:                  tsSeconds(tsRaw),
      api_key:             null,
      model,
      provider_id:         src.provider_id || null,
      tier:                src.tier || 'paid',
      input_tokens:        0,
      output_tokens:       totalTok,
      cache_create_tokens: 0,
      cache_read_tokens:   0,
      request_id:          `grok:${sessionId}`,
      data_source:         src.data_source,
      session_id:          sessionId,
      status_code:         200,
      is_streaming:        false,
      ...recordExtras(src, model, 0, totalTok, 0, 0),
    });
    if (ok) imported++;
    markDone(localStats, summaryPath, st);
  }
  return { source: src.id || src.data_source, imported, skipped, files_scanned };
}

// ── Trae Work：从 ~/.tokenbank/trae-sessions/usage.jsonl 导入（session-sync 写入）────
function importTraeWorkExportSource(localStats, src) {
  const exportRoot = expandHome(src.export_root || '~/.tokenbank/trae-sessions');
  const glob = src.export_glob || 'usage.jsonl';
  const re = globToRe(glob);
  const files = exportRoot ? walk(exportRoot, rel => re.test(rel)) : [];
  let imported = 0, skipped = 0, files_scanned = 0;

  for (const file of files) {
    let st;
    try { st = fs.statSync(file); } catch { continue; }
    if (unchanged(localStats, file, st)) { skipped++; continue; }
    files_scanned++;
    const ctx = { model: undefined, session_id: undefined, seq: 0, index: 0, prev: { input: 0, output: 0, cached: 0 } };
    eachJsonlLine(file, (rec, idx) => {
      ctx.index = idx;
      if (rec.session_id) ctx.session_id = rec.session_id;
      if (rec.message?.model || rec.model) ctx.model = rec.message?.model || rec.model;
      if (!matchFilter(rec, src.record_filter)) return;
      if (emitRecord(localStats, src, rec, ctx, file)) imported++;
    });
    markDone(localStats, file, st);
  }
  return { source: src.id || src.data_source, imported, skipped, files_scanned };
}

// ── 单个 source 的扫描 ────────────────────────────────────────────────────────
// 多账号会话补录：claude/codex 的会话 root 若在 ~/.claude 或 ~/.codex 下，枚举同级 CONFIG_DIR
// (~/.claude-work 等)、各拼回原 root 的子路径 → 扫所有账号的会话（而非只默认目录）。非默认账号
// 给账号专属 dataSourceOverride，使每个实例只匹配自己的会话、不重复计数。其余源单 root、无 override。
function resolveScanRoots(src) {
  const root = expandHome(src.root || '');
  if (!root) return [];
  try {
    const cli = require('./cli-instances');
    const home = os.homedir();
    for (const base of ['.claude', '.codex']) {
      const prefix = path.join(home, base);
      if (root === prefix || root.startsWith(prefix + path.sep)) {
        const sub = root.slice(prefix.length);
        return cli.enumConfigDirs(base, null, home).map(dir => ({
          root: dir + sub,
          dataSourceOverride: path.resolve(dir) === path.resolve(prefix) ? null
            : cli.cliSessionDataSource(src.data_source, dir, base, home),
        }));
      }
    }
  } catch { /* cli-instances 不可用 → 回退单 root */ }
  // Pi / OmO / Prime：环境变量或旧版 senpi 目录把会话根从 YAML 默认值改掉
  try {
    const piCfg = require('./pi-config');
    const profile = piCfg.profileForEntity(src.id)
      || (src.data_source === 'session-pi' ? piCfg.profileForEntity('pi') : null);
    const root = profile && piCfg.sessionRootOverride(profile);
    if (root) return [{ root, dataSourceOverride: null }];
  } catch { /* pi-config 不可用 → 用 YAML 里的 root */ }
  return [{ root, dataSourceOverride: null }];
}

function importSource(localStats, src) {
  // 用户关闭 trace 分析时不扫描会话文件
  if (src.session_trace === false) {
    return { source: src.id || src.data_source, imported: 0, skipped: 0, files_scanned: 0 };
  }
  if (src.format === 'trae-work-export') return importTraeWorkExportSource(localStats, src);
  if (src.format === 'sqlite')         return importSqliteSource(localStats, src);
  if (src.format === 'copilot-events') return importCopilotEventsSource(localStats, src);
  if (src.format === 'grok-session')   return importGrokSessionsSource(localStats, src);
  const re   = globToRe(src.glob || '**/*');
  let imported = 0, skipped = 0, files_scanned = 0;

  for (const { root, dataSourceOverride } of resolveScanRoots(src)) {   // 多账号：逐个 CONFIG_DIR
  const files = root ? walk(root, rel => re.test(rel)) : [];
  for (const file of files) {
    let st; try { st = fs.statSync(file); } catch { continue; }
    // 已处理且文件未变 → 跳过（历史 session 不反复导入；有写入会改 mtime/size）
    if (unchanged(localStats, file, st)) { skipped++; continue; }
    files_scanned++;

    // 极端兜底：单文件超硬上限直接跳过。宁可漏这一份，也绝不让启动时 OOM 崩溃。
    if (st.size > MAX_IMPORT_FILE_BYTES) {
      console.warn(`[session-import] 跳过超大会话文件 ${(st.size / 1048576) | 0}MB: ${file}`);
      markDone(localStats, file, st);
      continue;
    }

    if ((src.format || 'jsonl') === 'json') {
      let doc;
      try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); }
      catch { markDone(localStats, file, st); continue; }
      // doc_skip：整文件级跳过（如 Antigravity 排除 kind=main 的 Gemini CLI 会话）
      if (src.doc_skip && matchFilter(doc, src.doc_skip)) {
        markDone(localStats, file, st);
        continue;
      }
      const baseId = path.basename(file).replace(/\.[^.]+$/, '');
      const session_id = getPath(doc, src.doc_session_id) || baseId;
      const arr = getPath(doc, src.iterate);
      const items = Array.isArray(arr) ? arr : [];
      const ctx = { model: undefined, session_id, seq: 0, index: 0, prev: { input: 0, output: 0, cached: 0 } };
      items.forEach((item, idx) => {
        if (!matchFilter(item, src.record_filter)) return;
        let rec = item;
        // item_json_field：某字段本身是 JSON 字符串（如 WorkBuddy span.toolOutput = [OpenAI 响应]），解析后并入；
        // 解析结果若是数组（响应包在单元素数组里），取第一个对象元素。
        if (src.item_json_field) {
          try {
            let parsed = JSON.parse(getPath(item, src.item_json_field) || 'null');
            if (Array.isArray(parsed)) parsed = parsed.find(x => x && typeof x === 'object') || null;
            if (parsed && typeof parsed === 'object') rec = { ...item, ...parsed };
          } catch { /* 解析失败保持原 item */ }
        }
        ctx.index = idx;
        ctx.session_id = session_id;   // json 每条都用整文件级 session
        if (emitRecord(localStats, src, rec, ctx, doc, dataSourceOverride)) imported++;
      });
      // 扫过即 markDone：无用量/暂写不出的历史文件也不反复重扫
      markDone(localStats, file, st);
    } else {
      // jsonl / jsonl-zstd：逐行；维护运行上下文（meta 行更新 model/session_id；accumulate 累计 prev）。
      // 大文件走流式（iterFileLines），避免 readFileSync + split 的双份整文件内存拷贝。
      // jsonl-zstd（DSH 拼接帧）不能按 utf8 读，统一走解压迭代器。
      const isZstd = (src.format || '') === 'jsonl-zstd';
      const streaming = !isZstd && st.size > STREAM_THRESHOLD_BYTES;
      let lines, lineCount;
      if (isZstd) {
        try { lines = iterZstdJsonlLines(file); }
        catch { markDone(localStats, file, st); continue; }
        lineCount = Math.max(1, Math.floor(st.size / 200));
      } else if (streaming) {
        try { lineCount = countJsonlLines(file); }
        catch { markDone(localStats, file, st); continue; }
        lines = iterFileLines(file);
      } else {
        let rawText;
        try { rawText = fs.readFileSync(file, 'utf8'); } catch { markDone(localStats, file, st); continue; }
        lines = rawText.split('\n');
        lineCount = 0;
        for (const l of lines) if (l.trim()) lineCount++;
      }
      const fileT0 = st.birthtimeMs;
      const fileSpan = Math.max(st.mtimeMs - st.birthtimeMs, lineCount * 500);
      const ctx = {
        model: undefined,
        session_id: resolveJsonlSessionId(src, file),
        seq: 0, index: 0, prev: { input: 0, output: 0, cached: 0 },
      };
      let lineIdx = 0;
      for (const raw of lines) {
        const s = raw.trim();
        if (!s) continue;   // 空行不计入 lineIdx（与旧 filter(Boolean) 语义一致）
        let e;
        try { e = JSON.parse(s); } catch { lineIdx++; continue; }
        ctx.index = lineIdx;
        ctx.estimated_ts_ms = fileT0 + (lineIdx / Math.max(lineCount, 1)) * fileSpan;
        lineIdx++;
        // meta 行：更新上下文，不产记录
        let consumed = false;
        for (const m of (src.meta || [])) {
          if (matchFilter(e, m.filter)) {
            if (m.set) for (const [k, p] of Object.entries(m.set)) {
              const v = getPath(e, p);
              if (v !== undefined) ctx[k] = v;
            }
            consumed = true;
            break;
          }
        }
        if (consumed) continue;
        // defer_emit：token 行需等 turn 结束再写入（见 session-scans.yaml defer_emit）
        if (src.defer_emit) {
          const pl = e.payload || {};
          if (e.type === 'event_msg' && pl.type === 'task_complete') {
            ctx.latency_ms     = pl.duration_ms != null ? num(pl.duration_ms) : null;
            ctx.first_token_ms = pl.time_to_first_token_ms != null ? num(pl.time_to_first_token_ms) : null;
            if (ctx._deferEmit) {
              if (emitRecord(localStats, src, ctx._deferEmit, ctx, null, dataSourceOverride)) imported++;
              ctx._deferEmit = null;
            }
            ctx.latency_ms = undefined;
            ctx.first_token_ms = undefined;
            continue;
          }
        }
        if (!matchFilter(e, src.record_filter)) continue;
        if (src.defer_emit) {
          ctx._deferEmit = e;
          continue;
        }
        if (emitRecord(localStats, src, e, ctx, null, dataSourceOverride)) imported++;
      }
      if (src.defer_emit && ctx._deferEmit) {
        if (emitRecord(localStats, src, ctx._deferEmit, ctx, null, dataSourceOverride)) imported++;
        ctx._deferEmit = null;
      }
      markDone(localStats, file, st);
    }
  }
  }
  return { source: src.id || src.data_source, imported, skipped, files_scanned };
}

// ── 入口 ────────────────────────────────────────────────────────────────────

// 扫描 config-loader.session_sources 配置的所有来源并补录到 local-stats。
// opts.skip：data_source 集合（Set 或数组）——命中的源不扫（取消纳管的应用 → 停止统计其日志）。
function run(localStats, opts = {}) {
  if (!localStats || typeof localStats.record !== 'function') {
    return { ok: false, error: 'local-stats not ready', imported: 0, sources: [] };
  }
  const skip = opts.skip instanceof Set ? opts.skip : new Set(opts.skip || []);
  let defs = [];
  try { defs = require('./config-loader').sessionSources() || []; } catch {}
  const sources = [];
  for (const src of defs) {
    // 取消纳管的应用：跳过其会话源（不再产生新统计；历史数据保留）。
    if (src && src.data_source && skip.has(src.data_source)) continue;
    try { sources.push(importSource(localStats, src)); }
    catch (e) { sources.push({ source: src && src.id, imported: 0, error: e.message }); }
  }
  const imported = sources.reduce((s, r) => s + (r.imported || 0), 0);
  // 始终输出摘要，便于确认 session-import 是否在跑（imported=0 时此前无日志）
  console.log('[session-import]', JSON.stringify({
    imported,
    skip: [...skip],
    sources: sources.map(s => ({
      source: s.source,
      imported: s.imported || 0,
      unchanged: s.skipped || 0,  // import_state 未变 → 跳过扫描
      scanned: s.files_scanned || 0,
      error: s.error,
    })),
  }));
  return { ok: true, imported, sources };
}

module.exports = { run, importSource, emitRecord, matchFilter, getPath, recordExtras, resolveTiming, resolveBillingType, resolveDataSourceFromMap, claudeDataSourceForEntrypoint, tsSeconds, iterFileLines, countJsonlLines, MAX_IMPORT_FILE_BYTES, STREAM_THRESHOLD_BYTES };
