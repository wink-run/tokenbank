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
            for file in (item.get("artifacts") or [])[:16]:
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
        duration = item.get("durationMs")
        if isinstance(duration, (int, float)) and duration > 0:
            msg["durationMs"] = int(duration)
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
    # 只认发言时间。完成时间是各端自己盖的，拿来排序会把同一句话排到不同位置
    value = msg.get("at") if isinstance(msg, dict) else None
    if isinstance(value, (int, float)) and value > 0:
        return int(value)
    return index


def _keep_reply_after_its_user(messages: list) -> None:
    """回复若比它前面那句用户消息还早，拉回到那句话之后。"""
    last_user_at = 0
    for msg in messages:
        if not isinstance(msg, dict):
            continue
        if msg.get("role") == "user":
            spoken = msg.get("at")
            if isinstance(spoken, (int, float)) and spoken > 0:
                last_user_at = int(spoken)
            continue
        if msg.get("role") != "assistant" or not last_user_at:
            continue
        spoken = msg.get("at")
        if not isinstance(spoken, (int, float)) or int(spoken) <= last_user_at:
            msg["at"] = last_user_at + 1


def _turn_sig(msg: dict) -> tuple:
    return (
        msg.get("role"),
        str(msg.get("content") or "").strip(),
        str(msg.get("author") or ""),
    )


def _same_user(a: dict | None, b: dict | None) -> bool:
    if not a or not b or a.get("role") != "user" or b.get("role") != "user":
        return False
    return _turn_sig(a) == _turn_sig(b)


def _last_user(messages: list) -> dict | None:
    for msg in reversed(messages or []):
        if isinstance(msg, dict) and msg.get("role") == "user":
            return msg
    return None


def _plain_reply_replaced_by(old: dict, new: dict) -> bool:
    """服务端先记下纯正文，页面随后带上工具分段。这是同一句，不是新的一条。"""
    if old.get("role") != "assistant" or new.get("role") != "assistant":
        return False
    # 只有「纯正文」被「带分段」换掉。两句都没有工具时仍是先后两轮
    return not old.get("parts") and bool(new.get("parts"))


def _suffix_overlap(merged: list, fresh: list) -> int:
    """incoming 开头有几句已经在云端末尾。重放同一轮时不再写一遍。"""
    limit = min(len(merged), len(fresh))
    best = 0
    for k in range(1, limit + 1):
        if [_turn_sig(m) for m in merged[-k:]] == [_turn_sig(m) for m in fresh[:k]]:
            best = k
    return best


def append_share_turns(existing, incoming, now_ms: int | None = None, user_at: int | None = None) -> list:
    """把后来的人接上的发言补进同一条分享。发言时间由云端写，不采用端上的时钟。"""
    import time

    merged = normalize_share_messages(existing)
    fresh = normalize_share_messages(incoming)
    overlap = _suffix_overlap(merged, fresh)
    for old, msg in zip(merged[-overlap:] if overlap else [], fresh[:overlap]):
        # 重放的同一句：只补耗时和工具分段，不改云端已经记下的发言时间
        for key in ("startedAt", "finishedAt", "durationMs"):
            if msg.get(key) and not old.get(key):
                old[key] = msg[key]
        if msg.get("parts") and not old.get("parts"):
            old["parts"] = msg["parts"]
        if msg.get("artifacts") and not old.get("artifacts"):
            old["artifacts"] = msg["artifacts"]
    pending = fresh[overlap:]
    # 纯正文在云端末尾，页面这次带来同一句用户消息和带工具的回复
    richer = None
    consumed = 0
    if (
        len(pending) >= 2
        and _plain_reply_replaced_by(merged[-1] if merged else {}, pending[1])
        and _same_user(_last_user(merged[:-1]) if merged else None, pending[0])
    ):
        richer = pending[1]
        consumed = 2
    elif (
        pending
        and merged
        and _plain_reply_replaced_by(merged[-1], pending[0])
        and _same_user(_last_user(merged[:-1]), _last_user(fresh[:overlap]))
    ):
        richer = pending[0]
        consumed = 1
    if richer is not None and merged:
        # 发言时间留云端那份，丢掉页面后来盖上的时钟
        if merged[-1].get("at"):
            richer["at"] = merged[-1]["at"]
        for key in ("startedAt", "finishedAt", "durationMs"):
            if merged[-1].get(key) and not richer.get(key):
                richer[key] = merged[-1][key]
        merged[-1] = richer
        pending = pending[consumed:]
    now = int(now_ms if now_ms is not None else time.time() * 1000)
    spoken_user = int(user_at) if isinstance(user_at, (int, float)) and user_at > 0 else 0
    for msg in pending:
        # 端上带来的 at 丢掉，改由云端盖时间
        msg.pop("at", None)
        if msg.get("role") == "user" and spoken_user:
            msg["at"] = spoken_user
        else:
            now = max(now, spoken_user + 1)
            msg["at"] = now
            now += 1
        merged.append(msg)
    _keep_reply_after_its_user(merged)
    ordered = list(enumerate(merged))
    ordered.sort(key=lambda item: (_spoken_at(item[1], item[0]), item[0]))
    return [msg for _, msg in ordered][-SHARE_MAX_MSGS:]


def share_preview(messages) -> str:
    """对话列表标题用这场对话的第一条用户消息。"""
    if not isinstance(messages, list):
        return ""
    for item in messages:
        if not isinstance(item, dict) or item.get("role") != "user":
            continue
        text = " ".join(str(item.get("content") or "").split())
        if text:
            return text[:42]
    return ""


def transcript_key(messages) -> tuple:
    """用来判断两条记录是不是同一场对话的不同快照。"""
    out = []
    if not isinstance(messages, list):
        return tuple()
    for item in messages:
        if not isinstance(item, dict):
            continue
        role = item.get("role")
        if role not in ("user", "assistant"):
            continue
        text = " ".join(str(item.get("content") or "").split())
        if text:
            out.append((role, text))
    return tuple(out)


def dedupe_chat_snapshots(chats, limit: int = 5) -> list:
    """同一场对话被反复另存时，只留最新、最完整的一条。调用方需已按时间倒序。"""
    kept_keys: list[tuple] = []
    kept: list = []
    cap = max(1, min(int(limit or 5), 5))
    for chat in chats or []:
        if not isinstance(chat, dict):
            continue
        key = transcript_key(chat.get("messages"))
        # 刚点的新对话还没有发言，也要单独占一条，不能被丢掉
        if not key:
            key = ("__blank__", str(chat.get("id") or ""))
        skip = False
        for i, prev in enumerate(kept_keys):
            if key == prev or prev[:len(key)] == key:
                skip = True
                break
            if key[:len(prev)] == prev:
                kept_keys[i] = key
                kept[i] = chat
                skip = True
                break
        if skip:
            continue
        kept_keys.append(key)
        kept.append(chat)
        if len(kept) >= cap:
            break
    return kept[:cap]
