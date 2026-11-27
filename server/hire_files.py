"""云端转发的雇佣文件：不再把整份文件塞进任务消息（base64），改放 COS，消息里只带引用。

- 发出方（雇佣方的输入、出租方的产出）先要一个上传地址，直接传到 COS，再在任务里带 {cos_key, name, mime, size}
- 本服务转发给对方前，核对对象确实在、没超上限，再换成下载地址（预签名，7 天内有效）
- 对象私有，路径是随机的；按前缀 7 天后自动删除
- 没配 COS 时上传地址要不到，发出方照旧带 base64（单个文件小得多的老上限）
"""

from __future__ import annotations

import re
import secrets

import cos_media

PREFIX = "agent-media/hire/"
# 单个文件上限
HIRE_FILE_MAX_BYTES = 500 * 1024 * 1024
_KEY_RE = re.compile(r"^agent-media/hire/[A-Za-z0-9_-]{16,64}/[A-Za-z0-9._-]{1,120}$")


class CosUnavailable(Exception):
    """没配 COS，调用方回退到 base64。"""


def _safe_name(name: str) -> str:
    base = str(name or "file").replace("\\", "/").split("/")[-1]
    stem, dot, ext = base.rpartition(".")
    if not dot:
        stem, ext = base, ""
    ext = re.sub(r"[^A-Za-z0-9]", "", ext).lower()[:8]
    stem = re.sub(r"[^A-Za-z0-9._-]", "_", stem).strip("._")[:80] or "file"
    return f"{stem}.{ext}" if ext else stem


def _mime(raw) -> str:
    mime = str(raw or "application/octet-stream").split(";")[0].strip()[:80]
    return mime if "/" in mime else "application/octet-stream"


def new_upload(name: str, size, mime: str, *, presign=None) -> dict:
    """发一个上传地址。超上限抛 ValueError；没配 COS 抛 CosUnavailable。"""
    try:
        n = int(size)
    except (TypeError, ValueError):
        raise ValueError("size required") from None
    if n <= 0:
        raise ValueError("size required")
    if n > HIRE_FILE_MAX_BYTES:
        raise ValueError(f"file too large (max {HIRE_FILE_MAX_BYTES // 1048576}MB)")
    put = presign or (cos_media.presign_put if cos_media.enabled() else None)
    if put is None:
        raise CosUnavailable()
    content_type = _mime(mime)
    key = f"{PREFIX}{secrets.token_urlsafe(18)}/{_safe_name(name)}"
    url = put(key, content_type)
    if not url:
        raise CosUnavailable()
    return {
        "cos_key": key,
        "upload_url": url,
        "method": "PUT",
        "headers": {"Content-Type": content_type},
        "max_bytes": HIRE_FILE_MAX_BYTES,
    }


def is_ref(item) -> bool:
    return isinstance(item, dict) and bool(item.get("cos_key")) and not item.get("dataUrl")


def resolve_ref(item: dict, *, size_of=None, presign_get=None) -> dict:
    """引用 → 给对方的下载项 {name, mime, size, url}。对象不在、超上限、key 不对都抛 ValueError。"""
    key = str(item.get("cos_key") or "").strip()
    if not _KEY_RE.match(key):
        raise ValueError("invalid file reference")
    size_fn = size_of or cos_media.object_size
    get_fn = presign_get or cos_media.presign_get
    size = size_fn(key)
    if size is None:
        raise ValueError("file not uploaded")
    if size > HIRE_FILE_MAX_BYTES:
        raise ValueError("file too large")
    url = get_fn(key)
    if not url:
        raise ValueError("file link unavailable")
    name = str(item.get("name") or key.rsplit("/", 1)[-1]).replace("\\", "/").split("/")[-1][:120] or "file"
    out = {"name": name, "mime": _mime(item.get("mime")), "size": int(size), "url": url}
    sha = str(item.get("sha256") or "").strip().lower()
    if re.fullmatch(r"[0-9a-f]{64}", sha):
        out["sha256"] = sha
    return out


def resolve_refs(items: list, **kw) -> list:
    """任务里的 images / files：引用换成下载项，base64 原样留着。"""
    out = []
    for item in items or []:
        out.append(resolve_ref(item, **kw) if is_ref(item) else item)
    return out
