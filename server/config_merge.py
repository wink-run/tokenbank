"""将 DB 中的 config.apps 与 static/defaults/apps.default.yaml 合并，补全新增字段。"""

from __future__ import annotations

from pathlib import Path

import yaml

_DEFAULTS_DIR = Path(__file__).resolve().parent / "static" / "defaults"
_APPS_DEFAULT = _DEFAULTS_DIR / "apps.default.yaml"
_REPO_ROOT = Path(__file__).resolve().parent.parent
_CLIENT_DEFAULT = _REPO_ROOT / "client" / "electron" / "config" / "tokenbank.default.yaml"

# 旧 config.apps / config.sources 中的计费四段（仅 DB 迁移用）
_BILLING_KEYS = ("subscription_apps", "api_subscription_apps", "subscription_plans", "payg_providers")


def _default_apps_doc() -> dict:
    if not _APPS_DEFAULT.is_file():
        return {}
    return yaml.safe_load(_APPS_DEFAULT.read_text(encoding="utf-8")) or {}


def _default_sources_doc() -> dict:
    """旧四段不再从仓库 yaml 回填。"""
    return {}


def merge_subscription_apps(current: list | None, defaults: list | None) -> list:
    """按 source_id 合并订阅应用目录，补全 subscription_to_api / plan_provider_id 等字段。"""
    def_list = list(defaults or [])
    cur_list = list(current or [])
    def_by = {a["source_id"]: dict(a) for a in def_list if a.get("source_id")}

    if not cur_list:
        return def_list

    out: list[dict] = []
    for app in cur_list:
        if not isinstance(app, dict):
            continue
        sid = app.get("source_id")
        if not sid:
            out.append(app)
            continue
        base = def_by.get(sid) or {}
        merged = {**base, **app}
        if app.get("subscription_to_api") is None and "subscription_to_api" in base:
            merged["subscription_to_api"] = base["subscription_to_api"]
        if app.get("plan_provider_id") is None and base.get("plan_provider_id") is not None:
            merged["plan_provider_id"] = base["plan_provider_id"]
        out.append(merged)
    return out


def _default_session_sources() -> list:
    """内置 session_sources 扫描规则（客户端 tokenbank.default.yaml）。"""
    if not _CLIENT_DEFAULT.is_file():
        return []
    doc = yaml.safe_load(_CLIENT_DEFAULT.read_text(encoding="utf-8")) or {}
    return list(doc.get("session_sources") or [])


def merge_session_sources(current: list | None, defaults: list | None) -> list:
    """按 id 合并 session_sources：云端可编辑字段覆盖，扫描规则保留内置默认。"""
    def_list = list(defaults or [])
    cur_list = list(current or [])
    def_by = {s["id"]: dict(s) for s in def_list if isinstance(s, dict) and s.get("id")}

    if not cur_list:
        return def_list

    out: list[dict] = []
    for src in cur_list:
        if not isinstance(src, dict) or not src.get("id"):
            continue
        base = def_by.get(src["id"]) or {}
        merged = {**base, **src}
        # direct_only: false 须覆盖内置 default 的 true
        if "direct_only" in src:
            merged["direct_only"] = bool(src["direct_only"])
        out.append(merged)

    # 追加内置有、云端未列出的会话源（扫描规则仍需要）
    seen = {s.get("id") for s in out}
    for s in def_list:
        if s.get("id") and s["id"] not in seen:
            out.append(s)
    return out


def merge_apps_doc(current: dict | None) -> dict:
    """应用下发：仅基础设施 + app_entities（计费段已统一到 config.providers）。"""
    if not isinstance(current, dict):
        return {}
    out = {k: v for k, v in current.items() if k not in _BILLING_KEYS}
    defaults = _default_apps_doc()
    for key in ("gateway", "mitm", "claude_models"):
        if not out.get(key) and defaults.get(key) is not None:
            out[key] = defaults[key]
    # 仅保留新格式字段；剥离过时的 tools / api_key_apps / session_sources
    for stale in ("tools", "api_key_apps", "session_sources", "entities"):
        out.pop(stale, None)
    if not out.get("app_entities"):
        try:
            import app_catalog as ac
            entities = ac.import_from_defaults().get("entities") or []
            if entities:
                out = ac.compile_apps_doc({"version": out.get("version") or 1, "entities": entities})
        except Exception:
            pass
    # 结构身份冲突（proxy.mode）以目录为准：旧快照 cli env 注入 → api_key config-file 过渡后，
    # 旧 mode 会把应用编成另一类目标、探测路径全变。仅 mode 冲突时刷新整段 proxy，其余保留。
    try:
        import app_handlers as ah
        hmap = ah.handlers_map()
        handlers = out.get("handlers")
        if isinstance(handlers, dict):
            changed = False
            for hid, stored in list(handlers.items()):
                if not isinstance(stored, dict):
                    continue
                base_h = hmap.get(hid) or {}
                base_mode = (base_h.get("proxy") or {}).get("mode")
                stored_mode = (stored.get("proxy") or {}).get("mode")
                if base_mode and stored_mode and stored_mode != base_mode and base_h.get("proxy"):
                    merged = dict(stored)
                    merged["proxy"] = base_h["proxy"]
                    handlers[hid] = merged
                    changed = True
            if changed:
                out["handlers"] = handlers
    except Exception:
        pass
    return out


def merge_api_subscription_apps(current: list | None, defaults: list | None) -> list:
    """API 订阅目录：已发布列表为准，仅用内置默认补全缺字段。"""
    def_list = list(defaults or [])
    cur_list = list(current or [])
    def_by = {a["source_id"]: dict(a) for a in def_list if a.get("source_id")}

    if not cur_list:
        return def_list

    out: list[dict] = []
    for app in cur_list:
        if not isinstance(app, dict):
            continue
        sid = app.get("source_id")
        if not sid:
            out.append(app)
            continue
        base = def_by.get(sid) or {}
        merged = {**base, **app}
        if app.get("plan_provider_id") is None and base.get("plan_provider_id") is not None:
            merged["plan_provider_id"] = base["plan_provider_id"]
        out.append(merged)
    return out


def merge_apps_yaml_text(content: str) -> str:
    """将 YAML 文本与内置默认合并后重新序列化；空文本回退为默认 app_entities 全集。"""
    text = (content or "").strip()
    if not text:
        import app_catalog as ac
        compiled = ac.compile_apps_doc(ac.import_from_defaults())
        return yaml.dump(
            compiled,
            allow_unicode=True,
            sort_keys=False,
            default_flow_style=False,
        ).rstrip()
    parsed = yaml.safe_load(text) or {}
    merged = merge_apps_doc(parsed)
    return yaml.dump(
        merged,
        allow_unicode=True,
        sort_keys=False,
        default_flow_style=False,
    ).rstrip()


def merge_sources_doc(current: dict | None) -> dict:
    """[deprecated] 只保留库里已有的旧四段，不再用仓库 yaml 补。"""
    if not isinstance(current, dict):
        current = {}
    defaults = _default_sources_doc()
    out = dict(current)
    if defaults.get("subscription_apps") or out.get("subscription_apps"):
        out["subscription_apps"] = merge_subscription_apps(
            out.get("subscription_apps"),
            defaults.get("subscription_apps"),
        )
    if defaults.get("api_subscription_apps") or out.get("api_subscription_apps"):
        out["api_subscription_apps"] = merge_api_subscription_apps(
            out.get("api_subscription_apps"),
            defaults.get("api_subscription_apps"),
        )
    for key in ("subscription_plans", "payg_providers"):
        if not out.get(key) and defaults.get(key):
            out[key] = defaults[key]
    return out


def merge_providers_doc(current: dict | None) -> dict:
    """只整理库里的 providers.registry，不读仓库 yaml。"""
    from provider_registry import sync_catalog_models_pricing

    if not isinstance(current, dict):
        current = {}
    out = dict(current)
    if not out.get("version"):
        out["version"] = 1
    if not isinstance(out.get("billing_sources"), list):
        out["billing_sources"] = []
    # 下发前对齐 models / pricing，修复历史漂移
    providers = out.get("providers")
    if isinstance(providers, list):
        synced: list = []
        for p in providers:
            if not isinstance(p, dict) or not p.get("id"):
                synced.append(p)
                continue
            models, pricing = sync_catalog_models_pricing(p.get("models"), p.get("pricing"))
            synced.append({**p, "models": models, "pricing": pricing})
        out["providers"] = synced
    return out


def merge_providers_yaml_text(content: str) -> str:
    """把库里的 providers.registry 文本规范化后下发，不并入仓库 yaml。"""
    text = (content or "").strip()
    parsed = yaml.safe_load(text) if text else {}
    if not isinstance(parsed, dict):
        parsed = {}
    merged = merge_providers_doc(parsed)
    return yaml.dump(
        merged,
        allow_unicode=True,
        sort_keys=False,
        default_flow_style=False,
    ).rstrip()


def merge_sources_yaml_text(content: str) -> str:
    """[deprecated] 由 config.providers 编译旧四段 YAML；请改用 merge_providers_yaml_text。"""
    text = (content or "").strip()
    if text:
        parsed = yaml.safe_load(text) or {}
        if isinstance(parsed, dict) and any(parsed.get(k) for k in _BILLING_KEYS):
            merged = merge_sources_doc(parsed)
            return yaml.dump(
                merged,
                allow_unicode=True,
                sort_keys=False,
                default_flow_style=False,
            ).rstrip()
    # 无有效旧内容：从 providers.registry 默认编译
    defaults = _default_sources_doc()
    if defaults:
        doc = {"version": 1, **defaults}
        return yaml.dump(
            doc,
            allow_unicode=True,
            sort_keys=False,
            default_flow_style=False,
        ).rstrip()
    return "version: 1\nsubscription_apps: []\napi_subscription_apps: []\nsubscription_plans: {}\npayg_providers: []\n"
