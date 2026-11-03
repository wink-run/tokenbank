"""远程智能体成品：落到本服务，正文里的本机路径换成中转地址。"""

from __future__ import annotations

import base64
import os
import re
import time
from pathlib import Path

AGENT_MEDIA_DIR = Path(__file__).resolve().parent / "data" / "agent_media"
# 中转成品默认留 3 天，可用 AGENT_MEDIA_TTL_DAYS 覆盖
_DEFAULT_TTL_DAYS = 3
_ARTIFACT_MAX = 4
_ARTIFACT_MAX_CHARS = 64_000_000
# 短视频常见几 MB 到二十多 MB；太小的上限会把成片留在出租方本机
_ARTIFACT_MAX_BYTES = 32 * 1024 * 1024

# 绝对路径，结尾必须是成品文件名。不改正文里单独出现的文件名。
# 盘符前不能再是字母，否则 https:// 里的 s:/ 会被当成路径再拼一次。
_PATH_PREFIX = r"(?:~/|/(?:Users|home|tmp|var|opt|private|Volumes)|(?<![A-Za-z])[A-Za-z]:[\\/])"


def agent_media_ttl_sec() -> float:
    raw = os.getenv("AGENT_MEDIA_TTL_DAYS", str(_DEFAULT_TTL_DAYS)).strip() or str(_DEFAULT_TTL_DAYS)
    try:
        days = float(raw)
    except ValueError:
        days = float(_DEFAULT_TTL_DAYS)
    if days <= 0:
        days = float(_DEFAULT_TTL_DAYS)
    return days * 86400


def drop_if_expired(path: Path, *, now: float | None = None, ttl_sec: float | None = None) -> bool:
    """文件超过保留期就删掉。删掉了返回 True。"""
    ttl = agent_media_ttl_sec() if ttl_sec is None else ttl_sec
    moment = time.time() if now is None else now
    try:
        if path.is_symlink() or not path.is_file():
            return False
        if path.stat().st_mtime >= moment - ttl:
            return False
        path.unlink()
    except OSError:
        return False
    parent = path.parent
    try:
        if parent.is_dir() and not any(parent.iterdir()):
            parent.rmdir()
    except OSError:
        pass
    return True


def cleanup_agent_media(media_dir: Path | None = None, *, now: float | None = None, ttl_sec: float | None = None) -> int:
    """清掉超过保留期的成品。只删目录里的普通文件，默认 3 天。"""
    root = Path(media_dir) if media_dir is not None else AGENT_MEDIA_DIR
    if not root.is_dir():
        return 0
    removed = 0
    try:
        entries = list(root.iterdir())
    except OSError:
        return 0
    for task_dir in entries:
        if task_dir.is_symlink() or not task_dir.is_dir():
            continue
        try:
            files = [p for p in task_dir.iterdir() if p.is_file() and not p.is_symlink()]
        except OSError:
            continue
        for item in files:
            if drop_if_expired(item, now=now, ttl_sec=ttl_sec):
                removed += 1
    return removed


def public_origin() -> str:
    return os.getenv("PUBLIC_BASE_URL", "https://tokenbank.wink.run").strip().rstrip("/")


def _safe_task(task_id: str) -> str:
    safe = re.sub(r"[^A-Za-z0-9_-]", "", str(task_id or ""))[:80]
    return safe


def _safe_name(name: str) -> str:
    """磁盘文件名只留 ASCII。中文名不能被剥成 svg/png，否则浏览器不按图片打开。"""
    base = str(name or "file").replace("\\", "/").split("/")[-1]
    stem, dot, ext = base.rpartition(".")
    if not dot:
        stem, ext = base, ""
    ext_clean = re.sub(r"[^A-Za-z0-9]", "", ext).lower()[:8]
    stem_clean = re.sub(r"[^A-Za-z0-9._-]", "_", stem).strip("._")[:80]
    if not stem_clean:
        stem_clean = "file"
    if ext_clean:
        return f"{stem_clean}.{ext_clean}"[:120]
    return stem_clean[:120] or "file"


def media_type_for_name(name: str) -> str | None:
    """按扩展名给出类型。没有点号的 svg/png 也认，兼容已经落盘的旧地址。"""
    base = str(name or "").rsplit("/", 1)[-1].lower()
    ext = base.rsplit(".", 1)[-1] if "." in base else base
    return {
        "png": "image/png",
        "jpg": "image/jpeg",
        "jpeg": "image/jpeg",
        "gif": "image/gif",
        "webp": "image/webp",
        "svg": "image/svg+xml",
        "pdf": "application/pdf",
        "txt": "text/plain",
        "md": "text/markdown",
        "json": "application/json",
        "csv": "text/csv",
        "html": "text/html",
        "zip": "application/zip",
        "mp3": "audio/mpeg",
        "wav": "audio/wav",
        "m4a": "audio/mp4",
        "mp4": "video/mp4",
        "m4v": "video/x-m4v",
        "webm": "video/webm",
        "mov": "video/quicktime",
        "mkv": "video/x-matroska",
        "srt": "text/plain",
        "vtt": "text/vtt",
    }.get(ext)


def _decode_data_url(url: str) -> bytes | None:
    header, sep, body = str(url or "").partition(",")
    if not sep or not header.startswith("data:") or not header.endswith(";base64"):
        return None
    try:
        raw = base64.b64decode(body, validate=False)
    except Exception:
        return None
    if not raw or len(raw) > _ARTIFACT_MAX_BYTES:
        return None
    return raw


def publish_agent_artifacts(
    task_id: str,
    raw,
    *,
    media_dir: Path | None = None,
    origin: str | None = None,
) -> list:
    """校验并落盘。返回项含 url；local 只给改写正文用，不要发给调用方。"""
    out = []
    if not isinstance(raw, list):
        return out
    safe_task = _safe_task(task_id)
    if not safe_task:
        return out
    root = Path(media_dir) if media_dir is not None else AGENT_MEDIA_DIR
    host = (origin if origin is not None else public_origin()).rstrip("/")
    cleanup_agent_media(root)
    total = 0
    used = set()
    for item in raw:
        if len(out) >= _ARTIFACT_MAX:
            break
        if not isinstance(item, dict):
            continue
        data_url = str(item.get("dataUrl") or "").strip()
        if len(data_url) > _ARTIFACT_MAX_CHARS or total + len(data_url) > _ARTIFACT_MAX_CHARS:
            continue
        blob = _decode_data_url(data_url)
        if blob is None:
            continue
        raw_name = str(item.get("name") or "file").replace("\\", "/").split("/")[-1][:120] or "file"
        name = _safe_name(raw_name)
        stem, dot, ext = name.rpartition(".")
        if not dot:
            stem, ext = name, ""
        candidate = name
        n = 2
        while candidate in used:
            suffix = f"-{n}"
            candidate = (f"{stem}{suffix}.{ext}" if ext else f"{stem}{suffix}")[:120]
            n += 1
        used.add(candidate)
        dest_dir = root / safe_task
        try:
            dest_dir.mkdir(parents=True, exist_ok=True)
            (dest_dir / candidate).write_bytes(blob)
        except OSError:
            continue
        mime = str(item.get("mime") or "application/octet-stream").split(";")[0].strip()[:80]
        if "/" not in mime:
            mime = "application/octet-stream"
        kind = "image" if mime.startswith("image/") and "svg" not in mime else "file"
        local = str(item.get("localPath") or "").strip()
        out.append({
            # 展示和路径匹配用原文件名；地址里用安全名
            "name": raw_name,
            "mime": mime,
            "kind": kind,
            "url": f"{host}/media/agent/{safe_task}/{candidate}",
            "dataUrl": data_url,
            "local": local,
        })
        total += len(data_url)
    return out


def rewrite_artifact_paths(text: str, artifacts: list) -> str:
    """把正文中的出租方绝对路径换成已发布的中转地址。"""
    out = str(text or "")
    for art in artifacts or []:
        if not isinstance(art, dict):
            continue
        url = str(art.get("url") or "")
        name = str(art.get("name") or "")
        if not url or not name:
            continue
        local = str(art.get("local") or "")
        if local:
            out = out.replace(local, url)
            # 正文里常写工作目录下的相对路径，如 outputs/成片.mp4，不单留文件名
            parts = [p for p in local.replace("\\", "/").split("/") if p]
            for i in range(1, len(parts) - 1):
                rel = "/".join(parts[i:])
                if rel:
                    out = out.replace(rel, url)
        pat = re.compile(_PATH_PREFIX + r"[^\s`'\"<>|]*?" + re.escape(name))
        out = pat.sub(url, out)
        # 至少带一层目录，避免把单独出现的文件名换成地址。已换成的中转地址不再改。
        rel_pat = re.compile(
            r"(?<![:/\w])(?:\.{1,2}[\\/])?(?:[^\s`'\"<>|\\/]+[\\/])+" + re.escape(name)
        )

        def _keep_url(match: re.Match, repl: str = url) -> str:
            raw = match.group(0)
            if "://" in raw or "/media/agent/" in raw:
                return raw
            return repl

        out = rel_pat.sub(_keep_url, out)
    return out


_LOCAL_PATH_RE = re.compile(_PATH_PREFIX + r"[^\s`'\"<>|]+")


def redact_remaining_local_paths(text: str) -> str:
    """没能换成中转地址的绝对路径只留文件名。"""
    def _base(match: re.Match) -> str:
        raw = match.group(0).replace("\\", "/").rstrip("/")
        name = raw.split("/")[-1]
        return name or match.group(0)

    return _LOCAL_PATH_RE.sub(_base, str(text or ""))


def public_artifacts(artifacts: list) -> list:
    """去掉本机路径后再发给调用方。"""
    view = []
    for art in artifacts or []:
        if not isinstance(art, dict) or not art.get("url"):
            continue
        # 只给中转地址。data URL 留在服务端落盘，避免再把大包塞进给调用方的响应
        view.append({
            "name": art.get("name"),
            "mime": art.get("mime"),
            "kind": art.get("kind"),
            "url": art.get("url"),
        })
    return view
