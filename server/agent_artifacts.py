"""远程智能体成品：落到本服务，正文里的本机路径换成中转地址。"""

from __future__ import annotations

import base64
import os
import re
import time
import unicodedata
from pathlib import Path

AGENT_MEDIA_DIR = Path(__file__).resolve().parent / "data" / "agent_media"
# 中转成品默认留 3 天，可用 AGENT_MEDIA_TTL_DAYS 覆盖
_DEFAULT_TTL_DAYS = 3
# 一批图常见十几张。上限太小会把后面的文件留在出租方磁盘上，正文里就只剩本机文件名。
_ARTIFACT_MAX = 16
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


# 文件名两侧。斜杠也算，避免把已经写进中转地址里的文件名再换一次。
_NAME_EDGE = r"[0-9A-Za-z\u4e00-\u9fff._/\-]"


def _dir_tokens(local: str) -> tuple[set, set]:
    """成品所在目录。带斜杠的可整段替换；只有文件夹名的只拿掉代码块里的那一处。"""
    raw = str(local or "").replace("\\", "/").rstrip("/")
    parts = [p for p in raw.split("/") if p and p not in (".", "..")]
    paths: set[str] = set()
    names: set[str] = set()
    if len(parts) < 2:
        return paths, names
    parent = raw.rsplit("/", 1)[0]
    if parent:
        paths.add(parent)
    for i in range(len(parts) - 1):
        rel = "/".join(parts[i:-1])
        if "/" in rel:
            paths.add(rel)
    names.add(parts[-2])
    return paths, names


def _nfc(text: str) -> str:
    return unicodedata.normalize("NFC", str(text or ""))


def _replace_filename_token(text: str, name: str, url: str) -> str:
    """单独出现的成品文件名也换成中转地址。雇佣方打不开出租方磁盘上的文件名。"""
    pat = re.compile(r"(?<!" + _NAME_EDGE + r")" + re.escape(_nfc(name)) + r"(?!" + _NAME_EDGE + r")")
    return pat.sub(url, _nfc(text))


def _strip_local_dirs(text: str, paths: set, names: set) -> str:
    """目录不是可打开的地址。绝对路径和代码块里的文件夹名都去掉。"""
    out = text
    for path in sorted(paths, key=len, reverse=True):
        if path:
            out = out.replace(path, "")

    def _is_dir(body: str) -> bool:
        token = body.strip().strip("`").replace("\\", "/").rstrip("/")
        return bool(token) and (token in names or token in paths)

    def _fence(match: re.Match) -> str:
        return "" if _is_dir(match.group(1)) else match.group(0)

    def _inline(match: re.Match) -> str:
        return "" if _is_dir(match.group(1)) else match.group(0)

    out = re.sub(r"```[^\n]*\n(.*?)```", _fence, out, flags=re.S)
    out = re.sub(r"`([^`\n]+)`", _inline, out)
    out = re.sub(r"```[^\n]*\n\s*```", "", out)
    return out


def rewrite_artifact_paths(text: str, artifacts: list) -> str:
    """把正文中的出租方路径换成已发布的中转地址。远程雇佣不能留下本机路径。"""
    out = _nfc(text)
    dir_paths: set[str] = set()
    dir_names: set[str] = set()
    named = []
    for art in artifacts or []:
        if not isinstance(art, dict):
            continue
        url = str(art.get("url") or "")
        name = _nfc(art.get("name") or "")
        if not url or not name:
            continue
        local = _nfc(art.get("local") or "")
        if local:
            out = out.replace(local, url)
            # 正文里常写工作目录下的相对路径，如 outputs/成片.mp4
            parts = [p for p in local.replace("\\", "/").split("/") if p]
            for i in range(1, len(parts) - 1):
                rel = "/".join(parts[i:])
                if rel:
                    out = out.replace(rel, url)
            paths, names = _dir_tokens(local)
            dir_paths.update(paths)
            dir_names.update(names)
        pat = re.compile(_PATH_PREFIX + r"[^\s`'\"<>|]*?" + re.escape(name))
        out = pat.sub(url, out)
        # 至少带一层目录。已经换成的中转地址不再改。
        rel_pat = re.compile(
            r"(?<![:/\w])(?:\.{1,2}[\\/])?(?:[^\s`'\"<>|\\/]+[\\/])+" + re.escape(name)
        )

        def _keep_url(match: re.Match, repl: str = url) -> str:
            raw = match.group(0)
            if "://" in raw or "/media/agent/" in raw:
                return raw
            return repl

        out = rel_pat.sub(_keep_url, out)
        named.append((name, url))
    for name, url in named:
        out = _replace_filename_token(out, name, url)
    if dir_paths or dir_names:
        out = _strip_local_dirs(out, dir_paths, dir_names)
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
