"""供给源目录 —— 通过 GET /api/catalog 下发给客户端。

数据源是数据库：管理页 config.billing_sources，发布后的 config.providers。
不读仓库里的 providers.registry.yaml。
"""

from provider_registry import (
    TIERS,
    catalog_from_doc,
    catalog_providers,
    catalog_providers_sync,
    load_registry_doc,
)


def _apply_admin_sources(doc: dict, sources: list[dict]) -> dict:
    """管理页个人源的模型/刊例价写进 catalog，和编辑页同一份。"""
    from billing_sources import compile_registry_providers, sort_sources

    compiled = {
        p["id"]: p
        for p in compile_registry_providers(sources)
        if isinstance(p, dict) and p.get("id")
    }
    providers = []
    seen: set[str] = set()
    for p in doc.get("providers") or []:
        if not isinstance(p, dict) or not p.get("id"):
            providers.append(p)
            continue
        seen.add(p["id"])
        inc = compiled.get(p["id"])
        if not inc:
            providers.append(p)
            continue
        providers.append({
            **p,
            "models": inc.get("models") or [],
            "pricing": inc.get("pricing") or {},
        })
    for pid, inc in compiled.items():
        if pid not in seen:
            providers.append(inc)
    out = dict(doc)
    out["providers"] = providers
    out["billing_sources"] = sort_sources(sources)
    return out


async def catalog_public_payload() -> dict:
    """registry providers + billing_sources 中的 APP/API 订阅源（个人源模板）。"""
    import database as db
    from billing_sources import CONFIG_KEY, normalize_source, sort_sources, load_sources_doc

    doc = await load_registry_doc()
    # 管理页「编辑个人源」读 config.billing_sources。有这份就以它为准，避免和 /api/catalog 各说各的。
    saved_sources = await db.get_config(CONFIG_KEY, "")
    if saved_sources.strip():
        admin = await load_sources_doc()
        admin_sources = [
            normalize_source(s)
            for s in (admin.get("sources") or [])
            if isinstance(s, dict) and (s.get("id") or s.get("source_id"))
        ]
        if admin_sources:
            doc = _apply_admin_sources(doc, admin_sources)
    billing_sources = sort_sources([
        normalize_source(s)
        for s in (doc.get("billing_sources") or [])
        if isinstance(s, dict) and (s.get("id") or s.get("source_id"))
    ])
    subscription_sources: list[dict] = []
    for raw in billing_sources:
        cat = raw.get("category")
        if cat not in ("app_sub", "api_sub"):
            continue
        sid = raw.get("source_id") or raw.get("id")
        if not sid:
            continue
        models = [
            {"name": m["id"], "type": m.get("modality") or "chat"}
            for m in (raw.get("models") or [])
            if isinstance(m, dict) and m.get("id")
        ]
        subscription_sources.append({
            "id": sid,
            "kind": cat,
            "label": raw.get("label") or sid,
            "icon": raw.get("icon") or "🔧",
            "agent_id": raw.get("agent_id") or "",
            "plan_provider_id": raw.get("plan_provider_id"),
            "subscription_to_api": bool(raw.get("subscription_to_api")),
            "base_url": raw.get("base_url") or "",
            "api_format": raw.get("api_format") or "openai",
            "models": models,
            "pricing": dict(raw.get("pricing") or {}),
            "plans": list(raw.get("plans") or []),
        })
    return {
        "tiers": list(TIERS),
        "providers": catalog_from_doc(doc),
        "subscription_sources": subscription_sources,
        # 完整个人源目录（与 admin 发布一致），供 CLI/Electron 直接写入 registry
        "billing_sources": billing_sources,
    }


# 同步兜底（import 时可用；HTTP 接口请用 await catalog_public_payload()）
PROVIDER_CATALOG = catalog_providers_sync()

__all__ = [
    "TIERS",
    "PROVIDER_CATALOG",
    "catalog_providers",
    "catalog_providers_sync",
    "catalog_public_payload",
]
