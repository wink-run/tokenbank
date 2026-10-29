"""供给源配置表 — 只从 DB config.providers 加载，不读仓库 yaml。"""

from __future__ import annotations

import json

import yaml

CONFIG_KEY = "config.providers"

TIERS = ("free", "p2p", "paid")
# 客户端须预置对应 adapter；不含已移除的 BFL / fal / stability / elevenlabs / deepgram 等
HANDLERS = ("local", "openai", "anthropic", "gemini", "p2p", "agnes-image", "jimeng-api")
API_FORMATS = ("openai", "anthropic", "gemini")


def parse_registry_content(content: str) -> dict:
    """解析 DB 中的 YAML/JSON 文本。空或损坏时返回空目录，不读仓库文件。"""
    text = (content or "").strip()
    if not text:
        return {"version": 1, "providers": [], "billing_sources": []}
    try:
        parsed = yaml.safe_load(text)
        if isinstance(parsed, dict):
            return parsed
    except yaml.YAMLError:
        pass
    try:
        parsed = json.loads(text)
        if isinstance(parsed, dict):
            return parsed
    except json.JSONDecodeError:
        pass
    return {"version": 1, "providers": [], "billing_sources": []}


async def load_registry_doc() -> dict:
    import database as db
    from config_merge import merge_providers_doc

    content = await db.get_config(CONFIG_KEY, "")
    return merge_providers_doc(parse_registry_content(content))


def load_registry_doc_sync() -> dict:
    # 同步路径没有 DB 连接，不能再回退仓库 yaml
    return {"version": 1, "providers": [], "billing_sources": []}


def list_providers(doc: dict | None = None) -> list[dict]:
    if doc is None:
        doc = load_registry_doc_sync()
    raw = doc.get("providers") if isinstance(doc, dict) else None
    return list(raw) if isinstance(raw, list) else []


def _model_names(models) -> list[str]:
    out: list[str] = []
    for m in models or []:
        if isinstance(m, str) and m.strip():
            out.append(m.strip())
        elif isinstance(m, dict):
            name = str(m.get("name") or m.get("id") or m.get("model") or "").strip()
            if name:
                out.append(name)
    return out


_META_PRICING_KEYS = frozenset({"_excluded_models", "excluded_models"})


def _model_name_from_entry(m) -> tuple[str, str]:
    if isinstance(m, str) and m.strip():
        return m.strip(), "chat"
    if isinstance(m, dict):
        name = str(m.get("name") or m.get("id") or m.get("model") or "").strip()
        if name:
            typ = str(m.get("type") or m.get("modality") or "chat").strip().lower() or "chat"
            return name, typ
    return "", "chat"


def sync_catalog_models_pricing(raw_models, pricing: dict | None) -> tuple[list, dict]:
    """models 与 pricing 取并集对齐，避免 /api/catalog 列表与刊例价键不一致。"""
    pricing_out: dict = {}
    for k, v in (pricing or {}).items():
        kn = str(k or "").strip()
        if not kn or kn in _META_PRICING_KEYS:
            continue
        pricing_out[kn] = dict(v) if isinstance(v, dict) else {}

    models_out: list = []
    seen: set[str] = set()

    for m in raw_models or []:
        name, typ = _model_name_from_entry(m)
        if not name or name in seen or name in _META_PRICING_KEYS:
            continue
        seen.add(name)
        models_out.append({"name": name, "type": typ})
        pricing_out.setdefault(name, {})

    for name in list(pricing_out.keys()):
        if name in seen:
            continue
        seen.add(name)
        models_out.append({"name": name, "type": "chat"})

    return models_out, pricing_out


def to_catalog_entry(entry: dict) -> dict:
    """registry 条目 → GET /api/catalog 下发的 provider 对象（含 models / pricing）。"""
    handler = entry.get("handler") or "openai"
    raw_models = entry.get("models") if isinstance(entry.get("models"), list) else []
    raw_pricing = dict(entry.get("pricing") or {}) if isinstance(entry.get("pricing"), dict) else {}
    models, pricing = sync_catalog_models_pricing(raw_models, raw_pricing)
    cat = {
        "id": entry["id"],
        "type": entry.get("tier") or "paid",
        "enabled_default": bool(entry.get("enabled_default")),
        "base_url": entry.get("base_url") or "",
        "icon": entry.get("icon") or "🔧",
        "label": entry.get("label") or entry["id"],
        "hint": entry.get("hint") or "",
        "keyless": bool(entry.get("keyless")),
        "key_prefix": list(entry.get("key_prefix") or []),
        "signup_url": entry.get("signup_url") or "",
        "modalities": entry.get("modalities") if isinstance(entry.get("modalities"), dict) else {},
        "handler": handler,
        "api_format": entry.get("api_format") or "openai",
        "models": models,
        "pricing": pricing,
    }
    if entry.get("payg"):
        cat["payg"] = True
    if entry.get("oauth"):
        cat["oauth"] = entry["oauth"]
    return cat


def catalog_from_doc(doc: dict) -> list[dict]:
    return [to_catalog_entry(p) for p in list_providers(doc) if p.get("id")]


async def catalog_providers() -> list[dict]:
    doc = await load_registry_doc()
    return catalog_from_doc(doc)


def catalog_providers_sync() -> list[dict]:
    return catalog_from_doc(load_registry_doc_sync())


def payg_from_doc(doc: dict) -> list[dict]:
    out: list[dict] = []
    for p in list_providers(doc):
        if not p.get("id") or not p.get("payg"):
            continue
        out.append({
            "id": p["id"],
            "label": p.get("label") or p["id"],
            "icon": p.get("icon") or "🔧",
            "aliases": list(p.get("aliases") or []),
            "models": _model_names(p.get("models")),
            "pricing": dict(p.get("pricing") or {}),
        })
    return out


async def payg_providers() -> list[dict]:
    doc = await load_registry_doc()
    return payg_from_doc(doc)


def validate_provider(p: dict, *, require_id: bool = True) -> None:
    from fastapi import HTTPException

    if require_id and not str(p.get("id") or "").strip():
        raise HTTPException(status_code=400, detail="provider.id 不能为空")
    tier = p.get("tier") or "paid"
    if tier not in TIERS:
        raise HTTPException(status_code=400, detail=f"tier 必须是 {', '.join(TIERS)} 之一")
    handler = p.get("handler") or "openai"
    if handler not in HANDLERS:
        raise HTTPException(status_code=400, detail=f"handler 必须是 {', '.join(HANDLERS)} 之一")
    api_format = p.get("api_format") or "openai"
    if api_format not in API_FORMATS:
        raise HTTPException(status_code=400, detail=f"api_format 必须是 {', '.join(API_FORMATS)} 之一")


def normalize_provider(p: dict) -> dict:
    """表单提交 → 规范化 registry 条目。"""
    modalities = p.get("modalities") if isinstance(p.get("modalities"), dict) else {}
    models: list = []
    for m in p.get("models") or []:
        if isinstance(m, str) and m.strip():
            models.append(m.strip())
        elif isinstance(m, dict):
            name = str(m.get("name") or "").strip()
            if name:
                models.append({"name": name, "type": m.get("type") or "chat"})

    key_prefix: list[str] = []
    raw_prefix = p.get("key_prefix")
    if isinstance(raw_prefix, list):
        key_prefix = [str(x).strip() for x in raw_prefix if str(x).strip()]
    elif isinstance(raw_prefix, str) and raw_prefix.strip():
        key_prefix = [x.strip() for x in raw_prefix.split(",") if x.strip()]

    aliases: list[str] = []
    raw_aliases = p.get("aliases")
    if isinstance(raw_aliases, list):
        aliases = [str(x).strip() for x in raw_aliases if str(x).strip()]
    elif isinstance(raw_aliases, str) and raw_aliases.strip():
        aliases = [x.strip() for x in raw_aliases.split(",") if x.strip()]

    out = {
        "id": str(p.get("id") or "").strip(),
        "label": str(p.get("label") or p.get("id") or "").strip(),
        "icon": str(p.get("icon") or "🔧"),
        "tier": p.get("tier") or "paid",
        "hint": str(p.get("hint") or ""),
        "base_url": str(p.get("base_url") or ""),
        "modalities": {
            k: bool(v) for k, v in modalities.items()
            if k in ("language", "embedding", "image")
        },
        "models": models,
        "pricing": dict(p.get("pricing") or {}) if isinstance(p.get("pricing"), dict) else {},
        "handler": p.get("handler") or "openai",
        "api_format": p.get("api_format") or "openai",
        "payg": bool(p.get("payg")),
        "enabled_default": bool(p.get("enabled_default")),
        "keyless": bool(p.get("keyless")),
        "key_prefix": key_prefix,
        "signup_url": str(p.get("signup_url") or ""),
        "aliases": aliases,
    }
    oauth = p.get("oauth")
    if isinstance(oauth, dict) and oauth.get("provider"):
        out["oauth"] = {
            "provider": str(oauth["provider"]),
            "label": str(oauth.get("label") or oauth["provider"]),
        }
    # 保存时对齐 models / pricing，避免 registry 漂移
    synced_models, synced_pricing = sync_catalog_models_pricing(out["models"], out["pricing"])
    out["models"] = synced_models
    out["pricing"] = synced_pricing
    return out


def serialize_registry_doc(doc: dict) -> str:
    return yaml.dump(doc, allow_unicode=True, sort_keys=False, default_flow_style=False).rstrip() + "\n"
