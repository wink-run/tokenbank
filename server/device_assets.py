"""多设备资产清单：各端心跳里上报的 inventory.assets（只有类型、名字、来源、内容摘要，没有正文）。"""

import json

MAX_ASSETS_PER_DEVICE = 500
_KEYS = ("t", "n", "d", "h", "s", "v")


def _clean_asset(a) -> dict | None:
    if not isinstance(a, dict):
        return None
    t = str(a.get("t") or "").strip()
    n = str(a.get("n") or "").strip()
    if not t or not n:
        return None
    return {k: str(a.get(k) or "")[:300] for k in _KEYS}


def device_assets(row: dict) -> list[dict]:
    """从一行 devices（含 inventory_json）里取出资产清单；格式不对时返回空列表。"""
    raw = row.get("inventory_json") or "{}"
    try:
        inv = json.loads(raw) if isinstance(raw, str) else (raw or {})
    except (ValueError, TypeError):
        return []
    items = inv.get("assets") if isinstance(inv, dict) else None
    if not isinstance(items, list):
        return []
    out = []
    for a in items[:MAX_ASSETS_PER_DEVICE]:
        c = _clean_asset(a)
        if c:
            out.append(c)
    return out


def devices_with_assets(rows: list[dict]) -> list[dict]:
    """接口返回：每台设备的基本信息 + 资产清单。没上报过清单的设备 assets_reported=False。"""
    out = []
    for r in rows:
        raw = r.get("inventory_json") or "{}"
        try:
            inv = json.loads(raw) if isinstance(raw, str) else (raw or {})
        except (ValueError, TypeError):
            inv = {}
        out.append({
            "id": r.get("id"),
            "name": r.get("name") or "",
            "type": r.get("type") or "",
            "platform": r.get("platform") or "",
            "online": bool(r.get("online")),
            "last_seen": r.get("last_seen"),
            "assets_reported": isinstance(inv, dict) and isinstance(inv.get("assets"), list),
            "assets": device_assets(r),
        })
    return out
