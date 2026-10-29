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
    """[deprecated] 从 providers.registry billing_sources 编译旧四段，供迁移/兼容。"""
    reg = _default_registry_doc()
    bs = reg.get("billing_sources") or []
    if not bs:
        return {}
    try:
        import billing_sources as bs_mod
        return bs_mod.compile_billing_sections(bs)
    except Exception:
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
    """[deprecated] 从 config.providers.billing_sources 编译旧四段；空则回退内置 registry。"""
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


def _default_registry_doc() -> dict:
    path = _DEFAULTS_DIR / "providers.registry.yaml"
    if not path.is_file():
        return {"version": 1, "providers": []}
    return yaml.safe_load(path.read_text(encoding="utf-8")) or {}


def _by_id(items) -> dict:
    out = {}
    for item in items or []:
        if isinstance(item, dict) and item.get("id"):
            out[item["id"]] = item
    return out


def overlay_catalog_models(current_list, default_list) -> tuple[list, bool]:
    """同 id 的 models/pricing 以内置默认为准，其余字段保留 DB。

    只在缺省时补模型会让目录改了、已有库仍停在旧列表，客户端也就拉不到新模型。
    """
    def_by = _by_id(default_list)
    out: list = []
    seen: set = set()
    changed = False
    for item in current_list or []:
        if not isinstance(item, dict) or not item.get("id"):
            out.append(item)
            continue
        seen.add(item["id"])
        default = def_by.get(item["id"])
        if not default:
            out.append(item)
            continue
        nxt = dict(item)
        for key in ("models", "pricing"):
            if key not in default:
                continue
            new_val = default.get(key) or ([] if key == "models" else {})
            if nxt.get(key) != new_val:
                nxt[key] = new_val
                changed = True
        out.append(nxt)
    for default in default_list or []:
        if isinstance(default, dict) and default.get("id") and default["id"] not in seen:
            out.append(default)
            seen.add(default["id"])
            changed = True
    return out, changed


def merge_providers_doc(current: dict | None) -> dict:
    """合并 providers.registry：同 id 的模型/刊例价跟内置默认走，缺段时再补 billing_sources。"""
    from provider_registry import sync_catalog_models_pricing

    if not isinstance(current, dict):
        current = {}
    defaults = _default_registry_doc()
    out = dict(current)
    if not out.get("version"):
        out["version"] = defaults.get("version") or 1
    providers, _ = overlay_catalog_models(out.get("providers"), defaults.get("providers"))
    out["providers"] = providers
    if not out.get("billing_sources"):
        if defaults.get("billing_sources"):
            out["billing_sources"] = defaults["billing_sources"]
        else:
            try:
                import billing_sources as bs
                out["billing_sources"] = bs.sort_sources(bs.import_from_legacy())
            except Exception:
                pass
    else:
        billing, _ = overlay_catalog_models(out.get("billing_sources"), defaults.get("billing_sources"))
        out["billing_sources"] = billing
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
    """providers.registry YAML 与内置默认合并；空文本回退默认文件。"""
    text = (content or "").strip()
    if not text:
        reg = _default_registry_doc()
        if reg:
            merged = merge_providers_doc(reg)
            return yaml.dump(
                merged,
                allow_unicode=True,
                sort_keys=False,
                default_flow_style=False,
            ).rstrip()
        return "version: 1\nproviders: []\n"
    parsed = yaml.safe_load(text) or {}
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
