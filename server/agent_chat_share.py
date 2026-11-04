"""网页对话分享：只保留别人能看的正文和中转成品，丢掉本机大附件。"""

from __future__ import annotations

import re

SHARE_MAX_MSGS = 40
SHARE_MAX_CHARS = 1_200_000
# 抢到发言权却一直没开任务，很快让出来；任务跑起来后给一轮足够长的时间
TURN_IDLE_SEC = 30
TURN_MAX_SEC = 20 * 60
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
            for file in (item.get("artifacts") or [])[:8]:
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
        if role == "user":
            author = str(item.get("author") or "").strip()[:40]
            if author:
                msg["author"] = author
        started = item.get("startedAt")
        finished = item.get("finishedAt")
        spoken = item.get("at")
        if isinstance(started, (int, float)) and started > 0:
            msg["startedAt"] = int(started)
        if isinstance(finished, (int, float)) and finished > 0:
            msg["finishedAt"] = int(finished)
        if isinstance(spoken, (int, float)) and spoken > 0:
            msg["at"] = int(spoken)
        if msg["content"].strip() or msg.get("parts") or msg.get("artifacts") or msg.get("images") or msg.get("files"):
            out.append(msg)
    return out


def share_turn_expired(started_at, task_id, now=None) -> bool:
    """这轮发言是否已经作废。没人收尾时，别人才能重新抢。"""
    if started_at is None:
        return True
    current = now
    if current is None:
        from datetime import datetime, timezone
        current = datetime.now(timezone.utc)
    if getattr(started_at, "tzinfo", None) and getattr(current, "tzinfo", None) is None:
        from datetime import timezone
        current = current.replace(tzinfo=timezone.utc)
    if getattr(current, "tzinfo", None) and getattr(started_at, "tzinfo", None) is None:
        from datetime import timezone
        started_at = started_at.replace(tzinfo=timezone.utc)
    try:
        age = (current - started_at).total_seconds()
    except Exception:
        return False
    if age < 0:
        return False
    if not str(task_id or "").strip() and age > TURN_IDLE_SEC:
        return True
    return age > TURN_MAX_SEC


def share_author_label(nickname, email) -> str:
    """列表上显示的人。有昵称用昵称，否则用邮箱前缀。"""
    nick = str(nickname or "").strip()
    if nick:
        return nick[:40]
    mail = str(email or "").strip()
    if "@" in mail:
        return mail.split("@", 1)[0][:40]
    return ""


def _spoken_at(msg, index: int) -> int:
    for key in ("at", "startedAt", "finishedAt"):
        value = msg.get(key)
        if isinstance(value, (int, float)) and value > 0:
            return int(value)
    return index


def _same_turn(old, new) -> bool:
    if old.get("role") != new.get("role"):
        return False
    if str(old.get("content") or "").strip() != str(new.get("content") or "").strip():
        return False
    old_author = old.get("author") or ""
    new_author = new.get("author") or ""
    if old_author and new_author and old_author != new_author:
        return False
    old_at = _spoken_at(old, 0)
    new_at = _spoken_at(new, 0)
    # 同一句隔了几秒以上，就当成另一次发言
    if old_at and new_at and abs(old_at - new_at) > 2000:
        return False
    return True


def append_share_turns(existing, incoming) -> list:
    """把后来的人接上的发言补进同一条分享，已有的句子不重复。"""
    merged = normalize_share_messages(existing)
    for msg in normalize_share_messages(incoming):
        if any(_same_turn(old, msg) for old in merged):
            continue
        merged.append(msg)
    ordered = list(enumerate(merged))
    ordered.sort(key=lambda item: (_spoken_at(item[1], item[0]), item[0]))
    return [msg for _, msg in ordered][-SHARE_MAX_MSGS:]


def share_preview(messages) -> str:
    """用第一句用户话当对话摘要。"""
    if not isinstance(messages, list):
        return ""
    for item in messages:
        if not isinstance(item, dict) or item.get("role") != "user":
            continue
        text = " ".join(str(item.get("content") or "").split())
        if text:
            return text[:42]
    return ""
