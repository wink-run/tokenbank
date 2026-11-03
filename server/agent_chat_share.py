"""网页对话分享：只保留别人能看的正文和中转成品，丢掉本机大附件。"""

from __future__ import annotations

import re

SHARE_MAX_MSGS = 40
SHARE_MAX_CHARS = 1_200_000
_MEDIA_URL = re.compile(
    r"^(?:https?://\S+)?/media/agent/[A-Za-z0-9_-]+/[^/?#\s]+$",
    re.I,
)


def _http_url(value) -> str:
    raw = str(value or "").strip()
    if len(raw) > 2000:
        return ""
    if raw.startswith("/media/agent/") or raw.startswith("https://") or raw.startswith("http://"):
        return raw
    return ""


def normalize_share_messages(raw) -> list:
    """校验分享正文。空对话或超限返回空列表，由调用方决定怎么拒绝。"""
    if not isinstance(raw, list):
        return []
    out = []
    for item in raw[-SHARE_MAX_MSGS:]:
        if not isinstance(item, dict):
            continue
        role = item.get("role")
        if role not in ("user", "assistant"):
            continue
        msg = {"role": role, "content": str(item.get("content") or "")[:80_000]}
        if role == "assistant" and isinstance(item.get("parts"), list):
            parts = []
            for part in item["parts"][:80]:
                if not isinstance(part, dict):
                    continue
                kind = part.get("type")
                if kind in ("text", "thinking"):
                    text = str(part.get("text") or "")[:80_000]
                    if text.strip():
                        parts.append({"type": kind, "text": text})
                elif kind == "tool":
                    parts.append({
                        "type": "tool",
                        "name": str(part.get("name") or "tool")[:80],
                        "detail": str(part.get("detail") or "")[:4000],
                        "done": bool(part.get("done")),
                    })
            if parts:
                msg["parts"] = parts
            arts = []
            for file in (item.get("artifacts") or [])[:4]:
                if not isinstance(file, dict):
                    continue
                url = str(file.get("url") or "").strip()
                if not _MEDIA_URL.match(url):
                    continue
                arts.append({
                    "name": str(file.get("name") or "file").replace("\\", "/").split("/")[-1][:120] or "file",
                    "mime": str(file.get("mime") or "")[:80],
                    "kind": "image" if file.get("kind") == "image" else "file",
                    "url": url,
                })
            if arts:
                msg["artifacts"] = arts
        if role == "user":
            files = []
            for file in (item.get("files") or [])[:4]:
                if isinstance(file, dict) and str(file.get("name") or "").strip():
                    files.append({"name": str(file["name"]).replace("\\", "/").split("/")[-1][:120]})
            if files:
                msg["files"] = files
            images = []
            for src in (item.get("images") or [])[:4]:
                url = _http_url(src)
                if url:
                    images.append(url)
            if images:
                msg["images"] = images
        started = item.get("startedAt")
        finished = item.get("finishedAt")
        if isinstance(started, (int, float)) and started > 0:
            msg["startedAt"] = int(started)
        if isinstance(finished, (int, float)) and finished > 0:
            msg["finishedAt"] = int(finished)
        if msg["content"].strip() or msg.get("parts") or msg.get("artifacts") or msg.get("images") or msg.get("files"):
            out.append(msg)
    return out
