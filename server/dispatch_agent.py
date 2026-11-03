"""社区武将任务派发：经 /ws/worker 下发 agent_task，等待 agent_task_result（可 SSE 转发进度）。"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import time
import uuid
from datetime import datetime
from typing import AsyncIterator, Optional

import database as db
from agent_artifacts import public_artifacts, publish_agent_artifacts, rewrite_artifact_paths
from worker_pool import pool

logger = logging.getLogger("server")

# 一期固定按次计费（积分）；可用环境变量覆盖
AGENT_TASK_CREDITS = float(os.getenv("AGENT_TASK_CREDITS", "10"))
# 默认超时 10 分钟（本机 CLI 可能较慢）
AGENT_TASK_TIMEOUT_SEC = int(os.getenv("AGENT_TASK_TIMEOUT_SEC", "600"))


def _sse(data: dict) -> str:
    return f"data: {json.dumps(data, ensure_ascii=False)}\n\n"


def _public_progress_parts(raw) -> list:
    """网页对话用的分段：正文 / 思考 / 工具。丢掉未知字段，限制长度。"""
    out = []
    if not isinstance(raw, list):
        return out
    for item in raw[:80]:
        if not isinstance(item, dict):
            continue
        kind = str(item.get("type") or "")
        if kind == "tool":
            tool = {
                "type": "tool",
                "name": str(item.get("name") or "tool")[:80],
                "detail": str(item.get("detail") or "")[:4000],
            }
            result = str(item.get("result") or "")
            if result:
                tool["result"] = result[:4000]
            if item.get("done"):
                tool["done"] = True
            if item.get("error"):
                tool["error"] = True
            out.append(tool)
            continue
        if kind not in ("text", "thinking"):
            continue
        text = str(item.get("text") or "")
        if not text.strip():
            continue
        out.append({"type": kind, "text": text[:80_000]})
    return out


def _apply_artifacts(task_id: str, output: str, raw) -> tuple[str, list]:
    """成品存到本服务，正文里的本机路径换成 /media/agent 中转地址。"""
    stored = publish_agent_artifacts(task_id, raw)
    if not stored:
        return output, []
    return rewrite_artifact_paths(output, stored), public_artifacts(stored)


# 正文先到、文件后到。这段时间内断线仍保留正文，不改写成 worker disconnected
_ARTIFACT_FOLLOW_SEC = 20


async def _iter_agent_messages(ctx: dict):
    """读队列：进度原样吐出；终态若声明还有文件，就再等一帧再结束。

    文件帧丢失或连接随大包断开时，已经入队的正文仍然按原状态返回。
    超时且没有任何终态时产出 None，由调用方退款。
    """
    q = ctx["queue"]
    worker = ctx["worker"]
    task_id = ctx["task_id"]
    deadline = time.time() + float(ctx["timeout_sec"])
    held = None
    file_deadline = None

    def _release(msg: dict) -> dict:
        worker.pending_agents.pop(task_id, None)
        out = dict(msg)
        out.pop("artifacts_follow", None)
        return out

    while True:
        now = time.time()
        limit = file_deadline if held is not None and file_deadline is not None else deadline
        if now >= limit:
            break
        try:
            msg = await asyncio.wait_for(q.get(), timeout=max(0.1, limit - now))
        except asyncio.TimeoutError:
            break
        if not isinstance(msg, dict):
            continue
        kind = msg.get("type")
        if kind == "agent_task_progress" and held is None:
            yield msg
            continue
        if kind == "agent_task_artifacts" and held is not None:
            merged = dict(held)
            merged["artifacts"] = msg.get("artifacts")
            yield _release(merged)
            return
        if kind == "agent_task_result":
            # 出租方先交正文，文件单独再来。先挂起，避免随后的断线覆盖成功结果
            if msg.get("artifacts_follow"):
                held = msg
                file_deadline = min(deadline, time.time() + _ARTIFACT_FOLLOW_SEC)
                continue
            yield _release(msg)
            return
        if held is not None and msg.get("error") == "worker disconnected":
            yield _release(held)
            return
        if msg.get("status") or msg.get("error"):
            if held is not None:
                yield _release(held)
                return
            yield _release(msg)
            return
    if held is not None:
        yield _release(held)
        return
    yield None


async def _finalize_agent_result(
    *,
    result: dict,
    task_id: str,
    aid: str,
    worker,
    guest: bool,
    consumer_user_id: Optional[int],
) -> dict:
    """处理终态结果：退款 / 结息 / 组装响应。"""
    status = (result or {}).get("status") or "failed"
    success = status == "completed"
    usage = (result or {}).get("usage") or {}
    duration_ms = usage.get("duration_ms")
    worker.record_agent_complete(aid, success, duration_ms if isinstance(duration_ms, (int, float)) else None)

    if not success:
        if not guest:
            await db.award_credits(
                user_id=consumer_user_id,
                delta=AGENT_TASK_CREDITS,
                type_="refund",
                model_name=f"agent:{aid}",
                tokens=0,
                base_credits=AGENT_TASK_CREDITS,
                multiplier=1.0,
                note=f"agent_task failed refund task_id={task_id} status={status}",
            )
        failed = {
            "ok": False,
            "task_id": task_id,
            "status": status,
            "error": (result or {}).get("error") or status,
            "output": (result or {}).get("output") or "",
            "credits_refunded": 0 if guest else AGENT_TASK_CREDITS,
        }
        text, arts = _apply_artifacts(task_id, failed["output"], (result or {}).get("artifacts"))
        failed["output"] = text
        if arts:
            failed["artifacts"] = arts
        return failed

    if worker.user_id:
        await db.award_credits(
            user_id=worker.user_id,
            delta=AGENT_TASK_CREDITS,
            type_="contribute",
            model_name=f"agent:{aid}",
            tokens=0,
            base_credits=AGENT_TASK_CREDITS,
            multiplier=1.0,
            note=f"agent_task kind=agent task_id={task_id} worker={worker.worker_id}",
        )
        now = datetime.now().isoformat(timespec="seconds")
        label = aid
        for card in getattr(worker, "agents", None) or []:
            if isinstance(card, dict) and card.get("id") == aid:
                label = card.get("display_name") or card.get("name") or aid
                break
        try:
            await db.log_settlement(
                worker_id=worker.worker_id,
                user_id=worker.user_id,
                period_start=now,
                period_end=now,
                online_mins=0,
                output_tokens=0,
                avg_latency=0,
                success_rate=1.0,
                multiplier=1.0,
                credits_awarded=AGENT_TASK_CREDITS,
                resources=[f"agent:{label}"],
            )
        except Exception:
            logger.exception("[agent_task] log_settlement failed task_id=%s", task_id)

    done = {
        "ok": True,
        "task_id": task_id,
        "status": "completed",
        "output": str((result or {}).get("output") or "")[:200_000],
        "usage": usage,
        "credits_charged": AGENT_TASK_CREDITS,
    }
    text, arts = _apply_artifacts(task_id, done["output"], (result or {}).get("artifacts"))
    done["output"] = text
    if arts:
        done["artifacts"] = arts
    return done


def consumer_isolation_key(
    consumer_user_id: Optional[int],
    *,
    guest_ip: Optional[str] = None,
) -> str:
    """出租方执行隔离键：登录用户按 uid，访客按 IP 哈希，避免共用同一 CLI session/工作目录。"""
    if consumer_user_id is not None:
        return f"u{int(consumer_user_id)}"

    raw = (guest_ip or "").strip() or "unknown"
    digest = hashlib.sha256(raw.encode("utf-8")).hexdigest()[:12]
    return f"g{digest}"


async def _prepare_agent_task(
    *,
    assistant_id: str,
    prompt: str,
    consumer_user_id: Optional[int],
    worker_id: Optional[str] = None,
    owner: Optional[str] = None,
    timeout_ms: Optional[int] = None,
    guest_ip: Optional[str] = None,
    images: Optional[list] = None,
    files: Optional[list] = None,
) -> tuple[Optional[dict], Optional[dict]]:
    """预检 + 下发。成功返回 (ctx, None)；失败返回 (None, error_dict)。"""
    from web_public import (
        WEB_AGENT_ATTACH_ONLY_PROMPT,
        WEB_AGENT_IMAGE_ONLY_PROMPT,
        normalize_agent_files,
        normalize_agent_images,
    )

    aid = (assistant_id or "").strip()
    text = (prompt or "").strip()
    try:
        img_list = normalize_agent_images(images)
        file_list = normalize_agent_files(files)
    except ValueError as e:
        return None, {"ok": False, "error": str(e), "status": "rejected"}
    if not text and file_list:
        text = WEB_AGENT_ATTACH_ONLY_PROMPT
    elif not text and img_list:
        text = WEB_AGENT_IMAGE_ONLY_PROMPT
    if not aid or not text:
        return None, {"ok": False, "error": "assistant_id and prompt required", "status": "rejected"}

    guest = consumer_user_id is None
    consumer_key = consumer_isolation_key(consumer_user_id, guest_ip=guest_ip)
    if not guest:
        user = await db.get_user_by_id(consumer_user_id)
        if not user or float(user["credits_balance"] or 0) < AGENT_TASK_CREDITS:
            return None, {
                "ok": False,
                "error": "Insufficient credits",
                "status": "rejected",
                "credits_required": AGENT_TASK_CREDITS,
            }
        circles = set(await db.get_user_circle_ids(consumer_user_id))
    else:
        circles = set()

    workers = pool.pick_agent_workers(
        aid, user_circle_ids=circles, worker_id=worker_id, owner=owner,
    )
    if not workers:
        return None, {
            "ok": False,
            "error": "该智能体当前无在线节点（出租方可能已离线、未勾选贡献，或节点尚未重连上报）",
            "status": "rejected",
        }

    worker = workers[0]
    task_id = f"at-{uuid.uuid4().hex[:12]}"
    q: asyncio.Queue = asyncio.Queue()
    worker.pending_agents[task_id] = {
        "queue": q,
        "assistant_id": aid,
        "dispatch_time": time.time(),
        "consumer_user_id": consumer_user_id,
        "consumer_key": consumer_key,
    }
    worker.active_requests += 1

    if not guest:
        ok_deduct, bal = await db.deduct_credits(
            consumer_user_id,
            AGENT_TASK_CREDITS,
            model_name=f"agent:{aid}",
            tokens=0,
            tier="p2p",
        )
        if not ok_deduct:
            worker.pending_agents.pop(task_id, None)
            worker.active_requests = max(0, worker.active_requests - 1)
            return None, {
                "ok": False,
                "error": "Insufficient credits",
                "status": "rejected",
                "balance": bal,
                "credits_required": AGENT_TASK_CREDITS,
            }

    timeout_sec = max(30, (timeout_ms or AGENT_TASK_TIMEOUT_SEC * 1000) / 1000)
    try:
        await worker.send({
            "type": "agent_task",
            "task_id": task_id,
            "assistant_id": aid,
            "prompt": text[:50_000],
            "timeout_ms": int(timeout_sec * 1000),
            # 出租方按调用方隔离 CLI session / 工作目录，避免多用户互相影响
            "consumer_key": consumer_key,
            "consumer_user_id": consumer_user_id,
            "images": img_list or None,
            "files": file_list or None,
        })
        logger.info(
            "[agent_task] dispatch task_id=%s assistant=%s worker=%s user=%s guest=%s key=%s",
            task_id, aid, worker.worker_id, consumer_user_id, guest, consumer_key,
        )
    except Exception as e:
        worker.pending_agents.pop(task_id, None)
        worker.active_requests = max(0, worker.active_requests - 1)
        if not guest:
            await db.award_credits(
                user_id=consumer_user_id,
                delta=AGENT_TASK_CREDITS,
                type_="refund",
                model_name=f"agent:{aid}",
                tokens=0,
                base_credits=AGENT_TASK_CREDITS,
                multiplier=1.0,
                note=f"agent_task error refund task_id={task_id}",
            )
        worker.record_agent_complete(aid, False)
        logger.error("[agent_task] send error task_id=%s: %s", task_id, e)
        return None, {"ok": False, "task_id": task_id, "status": "failed", "error": str(e)}

    return {
        "task_id": task_id,
        "aid": aid,
        "worker": worker,
        "queue": q,
        "guest": guest,
        "consumer_user_id": consumer_user_id,
        "consumer_key": consumer_key,
        "timeout_sec": timeout_sec,
    }, None


async def _refund_timeout(ctx: dict) -> dict:
    task_id = ctx["task_id"]
    aid = ctx["aid"]
    worker = ctx["worker"]
    guest = ctx["guest"]
    consumer_user_id = ctx["consumer_user_id"]
    timeout_sec = ctx["timeout_sec"]
    worker.pending_agents.pop(task_id, None)
    worker.active_requests = max(0, worker.active_requests - 1)
    if not guest:
        await db.award_credits(
            user_id=consumer_user_id,
            delta=AGENT_TASK_CREDITS,
            type_="refund",
            model_name=f"agent:{aid}",
            tokens=0,
            base_credits=AGENT_TASK_CREDITS,
            multiplier=1.0,
            note=f"agent_task timeout refund task_id={task_id}",
        )
    worker.record_agent_complete(aid, False)
    return {
        "ok": False,
        "task_id": task_id,
        "status": "timeout",
        "error": f"Agent task timeout ({int(timeout_sec)}s)",
        "credits_refunded": 0 if guest else AGENT_TASK_CREDITS,
    }


async def handle_agent_task(
    *,
    assistant_id: str,
    prompt: str,
    consumer_user_id: Optional[int],
    worker_id: Optional[str] = None,
    owner: Optional[str] = None,
    timeout_ms: Optional[int] = None,
    guest_ip: Optional[str] = None,
    images: Optional[list] = None,
    files: Optional[list] = None,
) -> dict:
    """选 worker → 预扣积分 → 下发 → 等待终态结果；失败退款。"""
    ctx, err = await _prepare_agent_task(
        assistant_id=assistant_id,
        prompt=prompt,
        consumer_user_id=consumer_user_id,
        worker_id=worker_id,
        owner=owner,
        timeout_ms=timeout_ms,
        guest_ip=guest_ip,
        images=images,
        files=files,
    )
    if err:
        return err
    assert ctx is not None
    try:
        async for msg in _iter_agent_messages(ctx):
            if msg is None:
                return await _refund_timeout(ctx)
            if msg.get("type") == "agent_task_progress":
                continue  # 非流式忽略过程事件
            return await _finalize_agent_result(
                result=msg,
                task_id=ctx["task_id"],
                aid=ctx["aid"],
                worker=ctx["worker"],
                guest=ctx["guest"],
                consumer_user_id=ctx["consumer_user_id"],
            )
        return await _refund_timeout(ctx)
    except Exception as e:
        worker = ctx["worker"]
        task_id = ctx["task_id"]
        aid = ctx["aid"]
        guest = ctx["guest"]
        consumer_user_id = ctx["consumer_user_id"]
        worker.pending_agents.pop(task_id, None)
        worker.active_requests = max(0, worker.active_requests - 1)
        if not guest:
            await db.award_credits(
                user_id=consumer_user_id,
                delta=AGENT_TASK_CREDITS,
                type_="refund",
                model_name=f"agent:{aid}",
                tokens=0,
                base_credits=AGENT_TASK_CREDITS,
                multiplier=1.0,
                note=f"agent_task error refund task_id={task_id}",
            )
        worker.record_agent_complete(aid, False)
        logger.error("[agent_task] error task_id=%s: %s", task_id, e)
        return {"ok": False, "task_id": task_id, "status": "failed", "error": str(e)}


async def iter_agent_task_sse(
    *,
    assistant_id: str,
    prompt: str,
    consumer_user_id: Optional[int],
    worker_id: Optional[str] = None,
    owner: Optional[str] = None,
    timeout_ms: Optional[int] = None,
    guest: bool = False,
    guest_ip: Optional[str] = None,
    images: Optional[list] = None,
    files: Optional[list] = None,
) -> AsyncIterator[str]:
    """SSE：progress 事件推正文，done/error 收尾。"""
    ctx, err = await _prepare_agent_task(
        assistant_id=assistant_id,
        prompt=prompt,
        consumer_user_id=consumer_user_id,
        worker_id=worker_id,
        owner=owner,
        timeout_ms=timeout_ms,
        guest_ip=guest_ip,
        images=images,
        files=files,
    )
    if err:
        payload = {**err, "event": "error", "guest": guest, "need_login_to_continue": guest}
        yield _sse(payload)
        return

    assert ctx is not None
    try:
        async for msg in _iter_agent_messages(ctx):
            if msg is None:
                final = await _refund_timeout(ctx)
                yield _sse({**final, "event": "error", "guest": guest, "need_login_to_continue": guest})
                return

            if msg.get("type") == "agent_task_progress":
                yield _sse({
                    "event": "progress",
                    "task_id": ctx["task_id"],
                    "text": str(msg.get("text") or "")[:200_000],
                    "tool": msg.get("tool"),
                    "progress_event": msg.get("event"),
                    "parts": _public_progress_parts(msg.get("parts")),
                })
                continue

            final = await _finalize_agent_result(
                result=msg,
                task_id=ctx["task_id"],
                aid=ctx["aid"],
                worker=ctx["worker"],
                guest=ctx["guest"],
                consumer_user_id=ctx["consumer_user_id"],
            )
            ev = "done" if final.get("ok") else "error"
            yield _sse({
                **final,
                "event": ev,
                "guest": guest,
                "need_login_to_continue": guest,
            })
            return
    except Exception as e:
        worker = ctx["worker"]
        task_id = ctx["task_id"]
        aid = ctx["aid"]
        guest_flag = ctx["guest"]
        consumer_user_id = ctx["consumer_user_id"]
        worker.pending_agents.pop(task_id, None)
        worker.active_requests = max(0, worker.active_requests - 1)
        if not guest_flag:
            await db.award_credits(
                user_id=consumer_user_id,
                delta=AGENT_TASK_CREDITS,
                type_="refund",
                model_name=f"agent:{aid}",
                tokens=0,
                base_credits=AGENT_TASK_CREDITS,
                multiplier=1.0,
                note=f"agent_task error refund task_id={task_id}",
            )
        worker.record_agent_complete(aid, False)
        logger.error("[agent_task] stream error task_id=%s: %s", task_id, e)
        yield _sse({
            "event": "error",
            "ok": False,
            "task_id": task_id,
            "status": "failed",
            "error": str(e),
            "guest": guest,
            "need_login_to_continue": guest,
        })
