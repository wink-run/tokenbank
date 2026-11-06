"""设备名归一。不依赖数据库，方便判断一台 CLI 该不该复用已有 id。"""

from __future__ import annotations

import re

# 「桌面设备」「CLI」不是电脑名。两台机器都会报到这个名字，不能用来认设备。
_PLACEHOLDER_DEVICE_NAMES = frozenset({"cli", "桌面设备", "cli 设备"})


def is_placeholder_device_name(name: str) -> bool:
    raw = re.sub(r"\s·\sCLI\s:\d+$", "", (name or "").strip())
    raw = re.sub(r"\.local$", "", raw, flags=re.I).strip().casefold()
    return raw in _PLACEHOLDER_DEVICE_NAMES


def device_identity_key(name: str, platform: str) -> tuple[str, str] | None:
    """与个人页合并规则一致：展示名 + 系统，忽略版本和 CLI 端口后缀。"""
    raw = re.sub(r"\s·\sCLI\s:\d+$", "", (name or "").strip())
    raw = re.sub(r"\.local$", "", raw, flags=re.I).strip().casefold()
    plat = (platform or "").strip().casefold()
    if not raw:
        return None
    return (raw, plat)


def reuse_cli_device_id(owned_by_user: bool, same_cli_id: str | None, type_: str, name: str) -> str | None:
    """Docker / CLI 重建后会带一个库里没有的新 id。

    同一用户下名字和系统相同的 CLI 已有记录时，返回那条，避免一台容器堆出很多 device id。
    桌面版、以及「CLI 设备」这种占位名不复用，避免两台机器被并成一条。
    """
    if (type_ or "").strip() != "cli":
        return None
    if is_placeholder_device_name(name):
        return None
    if owned_by_user or not same_cli_id:
        return None
    return same_cli_id
