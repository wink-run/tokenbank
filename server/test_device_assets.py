"""多设备资产清单：从 inventory_json 里取出并清洗。"""

import json

from device_assets import device_assets, devices_with_assets


def _row(inv, **kw):
    return {"id": "dev-1", "name": "MacBook", "type": "desktop", "platform": "macOS", "online": 1,
            "last_seen": "2026-11-09 10:00:00", "inventory_json": json.dumps(inv), **kw}


def test_extracts_and_cleans_assets():
    inv = {"1": {"total_calls": 3}, "assets": [
        {"t": "skill", "n": "git-commit", "h": "abc", "s": "catalog:git-commit-skill", "v": "1.0.0", "extra": "x"},
        {"t": "skill"},            # 没有名字：丢掉
        "not-a-dict",
    ]}
    out = device_assets(_row(inv))
    assert out == [{"t": "skill", "n": "git-commit", "d": "", "h": "abc", "s": "catalog:git-commit-skill", "v": "1.0.0"}]


def test_device_without_assets_or_bad_json():
    rows = [_row({"1": {}}), {"id": "dev-2", "inventory_json": "{bad"}]
    out = devices_with_assets(rows)
    assert out[0]["assets_reported"] is False and out[0]["assets"] == []
    assert out[0]["online"] is True and out[0]["name"] == "MacBook"
    assert out[1]["assets"] == [] and out[1]["assets_reported"] is False


def test_caps_asset_count():
    inv = {"assets": [{"t": "skill", "n": f"s{i}"} for i in range(800)]}
    assert len(device_assets(_row(inv))) == 500
