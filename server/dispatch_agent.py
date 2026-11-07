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
from agent_artifacts import (
    public_artifacts,
    publish_agent_artifacts,
    redact_remaining_local_paths,
    rewrite_artifact_paths,
)
from worker_pool import pool

logger = logging.getLogger("server")

# 一次用户发言算一次交互。同一对话里的多轮各自扣一次，可用环境变量覆盖
AGENT_TASK_CREDITS = float(os.getenv("AGENT_TASK_CREDITS", "5"))
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
    text = rewrite_artifact_paths(output, stored) if stored else output
    # 换不掉的出租方路径不再原样返回
    return redact_remaining_local_paths(text), public_artifacts(stored)


# 正文先到、文件后到。这段时间内断线仍保留正文，不改写成 worker disconnected
_ARTIFACT_FOLLOW_SEC = 20


def _keep_partial_on_disconnect(msg: dict, ctx: dict) -> dict:
    """出租方中途掉线时，失败帧往往没有 output。把已经收到的正文补回去。"""
    if str(msg.get("error") or "") != "worker disconnected":
        return msg
    if str(msg.get("output") or "").strip():
        return msg
    partial = str(ctx.get("partial_output") or "")
    if not partial:
        return msg
    merged = dict(msg)
    merged["output"] = partial
    return merged


def _task_worker(ctx: dict):
    """任务当前挂在哪台设备上。重连后续跑会换成新连接。"""
    box = ctx.get("worker_box") if isinstance(ctx, dict) else None
    if isinstance(box, dict) and box.get("worker") is not None:
        return box["worker"]
    return ctx.get("worker") if isinstance(ctx, dict) else None


async def _iter_agent_messages(ctx: dict):
    """读队列：进度原样吐出；终态若声明还有文件，就再等一帧再结束。

    文件帧丢失或连接随大包断开时，已经入队的正文仍然按原状态返回。
    超时且没有任何终态时产出 None，由调用方退款。
    断线后续跑会把 clock.deadline_at 往后推，等待期间不要提前判超时。
    """
    q = ctx["queue"]
    task_id = ctx["task_id"]
    if not isinstance(ctx.get("clock"), dict):
        ctx["clock"] = {"deadline_at": time.time() + float(ctx["timeout_sec"])}
    elif not ctx["clock"].get("deadline_at"):
        ctx["clock"]["deadline_at"] = time.time() + float(ctx["timeout_sec"])
    held = None
    file_deadline = None

    def _release(msg: dict) -> dict:
        owner = _task_worker(ctx)
        if owner is not None:
            owner.pending_agents.pop(task_id, None)
        out = dict(msg)
        out.pop("artifacts_follow", None)
        return out

    while True:
        now = time.time()
        deadline = float(ctx["clock"]["deadline_at"])
        limit = file_deadline if held is not None and file_deadline is not None else deadline
        if now >= limit:
            break
        try:
            msg = await asyncio.wait_for(q.get(), timeout=max(0.1, limit - now))
        except asyncio.TimeoutError:
            continue
        if not isinstance(msg, dict):
            continue
        kind = msg.get("type")
        if kind == "agent_task_progress" and held is None:
            # 超时交卷时把已经流过的正文带回，调用方才能接着跑
            text = str(msg.get("text") or "")
            if text:
                ctx["partial_output"] = text[:200_000]
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
            # 连接断了也要把已经流过的正文交回去，调用方才能接着聊
            yield _release(_keep_partial_on_disconnect(msg, ctx))
            return
        if held is not None and msg.get("error") == "worker disconnected":
            yield _release(held)
            return
        if msg.get("status") or msg.get("error"):
            if held is not None:
                yield _release(held)
                return
            yield _release(_keep_partial_on_disconnect(msg, ctx))
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
        # 调用方已在取消接口里退过积分
        already_refunded = bool((result or {}).get("cancel_settled"))
        if not guest and not already_refunded:
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


async def _release_share_turn(task_id: str, output: str) -> None:
    """这轮任务结束就放开分享里的输入，避免别人一直被挡住。"""
    try:
        await db.release_share_turn_for_task(task_id, output)
    except Exception:
        logger.exception("[agent_task] release share turn failed task_id=%s", task_id)


async def _remember_share_cli_session(share_id: str, result: dict) -> None:
    """把这一轮的 CLI 会话记在分享上，下一个人接着聊时才能 --resume。"""
    sid = str((result or {}).get("cli_session_id") or "").strip()[:80]
    share = str(share_id or "").strip()
    if not sid or not share:
        return
    try:
        await db.set_share_cli_session(share, sid)
    except Exception:
        logger.exception("[agent_task] save cli session failed share=%s", share)


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


def _share_has_assistant(share: dict) -> bool:
    """这条分享里已经有过助手回复，下一句就是在接着聊。"""
    try:
        data = json.loads(share.get("messages") or "[]")
    except Exception:
        return False
    if not isinstance(data, list):
        return False
    for item in data:
        if not isinstance(item, dict) or item.get("role") != "assistant":
            continue
        if str(item.get("content") or "").strip():
            return True
        parts = item.get("parts")
        if isinstance(parts, list) and parts:
            return True
    return False


def share_session_binding(share: Optional[dict], speaker_key: str) -> dict:
    """同一条分享接着聊时，沿用发起人的工作目录和 CLI 会话。

    按当前发言人另开会话会丢掉已经生成的文件和上一轮上下文。
    """
    if not isinstance(share, dict):
        return {"consumer_key": speaker_key, "continue_session": False, "cli_session_id": ""}
    owner = share.get("user_id")
    try:
        key = f"u{int(owner)}" if owner is not None else speaker_key
    except (TypeError, ValueError):
        key = speaker_key
    sid = str(share.get("cli_session_id") or "").strip()[:80]
    # 还没记下 session id 时，用工作目录里的最近一次会话续上
    continue_session = bool(sid) or _share_has_assistant(share)
    return {
        "consumer_key": key,
        "continue_session": continue_session,
        "cli_session_id": sid,
    }


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
    share_id: Optional[str] = None,
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
    # 分享里的下一句必须回到发起人那条会话，不能按当前发言人新开
    continue_session = False
    cli_session_id = ""
    bound_share = (share_id or "").strip()[:40]
    if bound_share:
        share = await db.get_agent_chat_share(bound_share)
        if not share or str(share.get("assistant_id") or "") != aid:
            return None, {"ok": False, "error": "share not found", "status": "rejected"}
        binding = share_session_binding(share, consumer_key)
        consumer_key = binding["consumer_key"]
        continue_session = binding["continue_session"]
        cli_session_id = binding["cli_session_id"]
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
    timeout_sec = max(30, (timeout_ms or AGENT_TASK_TIMEOUT_SEC * 1000) / 1000)
    # 重连后续跑要换到新连接上，完成和退款都读这个盒子
    worker_box = {"worker": worker}
    clock = {"deadline_at": time.time() + timeout_sec}
    worker.pending_agents[task_id] = {
        "queue": q,
        "assistant_id": aid,
        "dispatch_time": time.time(),
        "consumer_user_id": consumer_user_id,
        "consumer_key": consumer_key,
        "prompt": text[:50_000],
        "timeout_ms": int(timeout_sec * 1000),
        "continue_session": bool(continue_session),
        "cli_session_id": cli_session_id or "",
        "images": img_list or None,
        "files": file_list or None,
        "share_id": bound_share,
        "partial_output": "",
        "worker_box": worker_box,
        "clock": clock,
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
            "continue_session": continue_session or None,
            "cli_session_id": cli_session_id or None,
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
        "share_id": bound_share,
        "timeout_sec": timeout_sec,
        "worker_box": worker_box,
        "clock": clock,
    }, None


async def cancel_agent_task(task_id: str, consumer_user_id: Optional[int]) -> bool:
    """调用方中途暂停：停掉出租方进程，并退回这一轮积分。"""
    task_id = str(task_id or "").strip()
    if not task_id:
        return False
    for worker in pool.all_workers():
        pending = getattr(worker, "pending_agents", None) or {}
        entry = pending.get(task_id)
        if not entry:
            continue
        # 登录用户只能停自己的；访客任务没有 user id，凭任务号停止
        if entry.get("consumer_user_id") != consumer_user_id:
            return False
        if entry.get("cancel_settled"):
            return True
        entry["cancel_settled"] = True
        owner = entry.get("consumer_user_id")
        if owner is not None:
            await db.award_credits(
                user_id=owner,
                delta=AGENT_TASK_CREDITS,
                type_="refund",
                model_name=f"agent:{entry.get('assistant_id') or ''}",
                tokens=0,
                base_credits=AGENT_TASK_CREDITS,
                multiplier=1.0,
                note=f"agent_task cancelled refund task_id={task_id}",
            )
        try:
            await worker.send({"type": "agent_task_cancel", "task_id": task_id})
        except Exception:
            logger.exception("[agent_task] cancel send failed task_id=%s", task_id)
        q = entry.get("queue")
        pending.pop(task_id, None)
        worker.active_requests = max(0, getattr(worker, "active_requests", 1) - 1)
        if q is not None:
            await q.put({
                "type": "agent_task_result",
                "task_id": task_id,
                "status": "cancelled",
                "error": "cancelled",
                "output": "",
                "cancel_settled": True,
            })
        logger.info("[agent_task] cancelled task_id=%s user=%s", task_id, consumer_user_id)
        return True
    # 出租方正在重启，任务还挂在暂存里，同样可以停
    entry = pool.find_parked_agent(task_id)
    if not entry:
        return False
    if entry.get("consumer_user_id") != consumer_user_id:
        return False
    if entry.get("cancel_settled"):
        return True
    entry["cancel_settled"] = True
    pool.pop_parked_agent(task_id)
    owner = entry.get("consumer_user_id")
    if owner is not None:
        await db.award_credits(
            user_id=owner,
            delta=AGENT_TASK_CREDITS,
            type_="refund",
            model_name=f"agent:{entry.get('assistant_id') or ''}",
            tokens=0,
            base_credits=AGENT_TASK_CREDITS,
            multiplier=1.0,
            note=f"agent_task cancelled refund task_id={task_id}",
        )
    q = entry.get("queue")
    if q is not None:
        await q.put({
            "type": "agent_task_result",
            "task_id": task_id,
            "status": "cancelled",
            "error": "cancelled",
            "output": "",
            "cancel_settled": True,
        })
    logger.info("[agent_task] cancelled parked task_id=%s user=%s", task_id, consumer_user_id)
    return True


async def _refund_timeout(ctx: dict) -> dict:
    task_id = ctx["task_id"]
    aid = ctx["aid"]
    worker = _task_worker(ctx)
    guest = ctx["guest"]
    consumer_user_id = ctx["consumer_user_id"]
    timeout_sec = ctx["timeout_sec"]
    removed = worker.pending_agents.pop(task_id, None) if worker is not None else None
    # 还在等重连时，任务不在旧连接上，要从暂存里拿掉，避免退款后又被续跑
    if removed is None:
        pool.pop_parked_agent(task_id)
    if worker is not None:
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
    if worker is not None:
        worker.record_agent_complete(aid, False)
    partial = str(ctx.get("partial_output") or "")
    return {
        "ok": False,
        "task_id": task_id,
        "status": "timeout",
        "error": f"Agent task timeout ({int(timeout_sec)}s)",
        "output": partial,
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
    share_id: Optional[str] = None,
    app_id: Optional[str] = None,
    previous_response_id: Optional[str] = None,
    call_context: str = "hired",
) -> dict:
    """选 worker → 预扣积分 → 下发 → 等待终态结果；失败退款。
    
    外部接口保持不变；内部通过 Gateway-over-WebSocket 调用 worker 本地 Gateway。
    """
    from gateway_over_websocket import invoke_worker_gateway

    # 选择 worker（先选，再根据 worker 决定 harness_id 格式）
    guest = consumer_user_id is None
    if not guest:
        user = await db.get_user_by_id(consumer_user_id)
        if not user or float(user["credits_balance"] or 0) < AGENT_TASK_CREDITS:
            return {
                "ok": False,
                "error": "Insufficient credits",
                "status": "rejected",
                "credits_required": AGENT_TASK_CREDITS,
            }
        circles = set(await db.get_user_circle_ids(consumer_user_id))
    else:
        circles = set()

    workers = pool.pick_agent_workers(
        assistant_id, user_circle_ids=circles, worker_id=worker_id, owner=owner,
    )
    if not workers:
        return {
            "ok": False,
            "error": "该智能体当前无在线节点",
            "status": "rejected",
        }

    worker = workers[0]
    task_id = f"at-{uuid.uuid4().hex[:12]}"
    
    # 判断该 worker 是否本地拥有此 assistant（在其 agents 列表中）
    # 若是，使用本地 harness_id（assistant_id），避免客户端把它当作远程社区智能体再次回云端
    # 否则用 community: 格式（真正的远程雇佣场景）
    worker_has_local = any(
        isinstance(c, dict) and c.get("id") == assistant_id
        for c in (getattr(worker, "agents", None) or [])
    )
    
    if worker_has_local:
        # 本地智能体：直接用 assistant_id 作为 harness_id
        harness_id = assistant_id
    else:
        # 远程社区智能体：使用 community: 格式
        harness_id = f"community:{assistant_id}"
        if owner:
            harness_id = f"{harness_id}@{owner}"
    
    # 构建 Gateway 请求
    # 构建consumer_key用于隔离工作目录
    consumer_key = None
    if consumer_user_id:
        consumer_key = f"u{consumer_user_id}"
    elif guest_ip:
        # 游客用IP哈希作为consumer_key
        import hashlib
        h = hashlib.sha256(guest_ip.encode()).hexdigest()[:12]
        consumer_key = f"g{h}"
    
    # 安全：hired模式输入检查（程序级硬规则，第一层防御）
    if call_context == "hired":
        from agent_safety import check_input_safety, ensure_checker_available
        
        # 1. 验证检查器可用性（fail closed）
        checker_ok, checker_err = ensure_checker_available()
        if not checker_ok:
            return {
                "ok": False,
                "error": checker_err or "Safety checker unavailable",
                "status": "rejected",
            }
        
        # 2. 检查输入安全性
        files_meta = []
        if files:
            files_meta = [{"name": f.get("name", "")} for f in files]
        
        is_safe, safety_err = check_input_safety(prompt, files_meta)
        if not is_safe:
            logger.warning(
                "[dispatch_agent] Rejected unsafe hired input: task=%s, assistant=%s",
                task_id, assistant_id,
            )
            return {
                "ok": False,
                "error": safety_err or "Input violates safety policy",
                "status": "rejected",
            }
    
    gateway_body = {
        "input": prompt,
        "metadata": {
            "harness_id": harness_id,
            "call_context": call_context,
            "assistant_id": assistant_id,
            "consumer_key": consumer_key,
        },
    }
    
    # 附件：图片和文件（data URL格式）
    if images:
        gateway_body["images"] = images
    if files:
        gateway_body["files"] = files
    
    if previous_response_id:
        gateway_body["previous_response_id"] = previous_response_id

    # 扣除积分
    if not guest:
        ok_deduct, bal = await db.deduct_credits(
            consumer_user_id,
            AGENT_TASK_CREDITS,
            model_name=f"agent:{assistant_id}",
            tokens=0,
            tier="p2p",
        )
        if not ok_deduct:
            return {
                "ok": False,
                "error": "Insufficient credits",
                "status": "rejected",
                "balance": bal,
                "credits_required": AGENT_TASK_CREDITS,
            }

    # 调用 worker 的本地 Gateway
    # 发起方由调用者显式传递，不推断
    try:
        gateway_response = await invoke_worker_gateway(
            worker=worker,
            method="POST",
            path="/v1/agent/responses",
            body=gateway_body,
            timeout_sec=(timeout_ms or AGENT_TASK_TIMEOUT_SEC * 1000) // 1000,
            initiator=app_id,  # 调用方显式传递
        )

        # 转换 Gateway 响应为云端格式
        status = gateway_response.get("status", "failed")
        success = status == "completed"
        
        # 提取输出文本
        output_text = ""
        output_list = gateway_response.get("output", [])
        if isinstance(output_list, list) and output_list:
            first_msg = output_list[0]
            if isinstance(first_msg, dict):
                content = first_msg.get("content", [])
                if isinstance(content, list):
                    for item in content:
                        if isinstance(item, dict) and item.get("type") == "output_text":
                            output_text = str(item.get("text", ""))
                            break

        if success and worker.user_id:
            # 结息给出租方
            await db.award_credits(
                user_id=worker.user_id,
                delta=AGENT_TASK_CREDITS,
                type_="contribute",
                model_name=f"agent:{assistant_id}",
                tokens=0,
                base_credits=AGENT_TASK_CREDITS,
                multiplier=1.0,
                note=f"agent_task kind=agent task_id={task_id} worker={worker.worker_id}",
            )
        elif not success and not guest:
            # 失败退款给调用方
            await db.award_credits(
                user_id=consumer_user_id,
                delta=AGENT_TASK_CREDITS,
                type_="refund",
                model_name=f"agent:{assistant_id}",
                tokens=0,
                base_credits=AGENT_TASK_CREDITS,
                multiplier=1.0,
                note=f"agent_task failed refund task_id={task_id}",
            )

        # 安全：hired模式先检查安全性，通过后才上传artifacts（fail closed）
        raw_artifacts = gateway_response.get("artifacts")
        if call_context == "hired" and success:
            from agent_safety import check_output_safety, sanitize_paths_in_output
            
            # 提取session_root（由worker内部传递，仅供脱敏用，不得泄露给用户）
            session_root = gateway_response.get("metadata", {}).get("session_root")
            # 立即从metadata中删除，防止泄露给最终用户
            if session_root and "metadata" in gateway_response:
                gateway_response["metadata"].pop("session_root", None)
            
            # 1. 先检查输出文本和artifacts安全性（在上传之前）
            output_safe, output_err = check_output_safety(
                output_text,
                artifacts=raw_artifacts,
                session_dir=session_root,
            )
            if not output_safe:
                logger.warning(
                    "[dispatch_agent] Blocked unsafe hired output: task=%s, assistant=%s",
                    task_id, assistant_id,
                )
                # 阻断输出，不上传artifacts，不透出原文
                return {
                    "ok": False,
                    "task_id": task_id,
                    "status": "failed",
                    "error": output_err or "Output violates safety policy",
                    "credits_charged": 0,
                    "credits_refunded": AGENT_TASK_CREDITS if not guest else 0,
                }
            
            # 2. 安全检查通过，上传artifacts并改写路径
            processed_output, public_arts = _apply_artifacts(task_id, output_text, raw_artifacts)
            
            # 3. 路径脱敏（基于实际session root）
            processed_output = sanitize_paths_in_output(processed_output, session_root=session_root)
        elif call_context == "local":
            # 本机local：不上传artifacts，保留本地路径
            processed_output, public_arts = output_text, []
        else:
            # hired但失败：不上传artifacts
            processed_output, public_arts = output_text, []
        
        result = {
            "ok": success,
            "task_id": task_id,
            "status": status,
            "output": processed_output[:200_000],
            "usage": gateway_response.get("usage") or {},
            "credits_charged": AGENT_TASK_CREDITS if success else 0,
            "credits_refunded": 0 if success or guest else AGENT_TASK_CREDITS,
        }
        
        # 多轮对话：返回 response_id 用于续session
        response_id = gateway_response.get("id")
        if response_id:
            result["response_id"] = response_id
        
        if public_arts:
            result["artifacts"] = public_arts
        
        return result

    except Exception as e:
        # 失败退款
        if not guest:
            await db.award_credits(
                user_id=consumer_user_id,
                delta=AGENT_TASK_CREDITS,
                type_="refund",
                model_name=f"agent:{assistant_id}",
                tokens=0,
                base_credits=AGENT_TASK_CREDITS,
                multiplier=1.0,
                note=f"agent_task error refund task_id={task_id}",
            )
        
        logger.error("[agent_task] error task_id=%s: %s", task_id, e)
        
        # hired模式：脱敏错误消息（防止路径泄露）
        error_msg = str(e)
        if call_context == "hired":
            from agent_safety import sanitize_paths_in_output
            # 注：此处gateway_response可能未定义（调用前失败），使用None作为session_root
            session_root = None
            if 'gateway_response' in locals() and gateway_response:
                session_root = gateway_response.get("metadata", {}).get("session_root")
            error_msg = sanitize_paths_in_output(error_msg, session_root=session_root)
        
        return {
            "ok": False,
            "task_id": task_id,
            "status": "failed",
            "error": error_msg,
            "credits_refunded": 0 if guest else AGENT_TASK_CREDITS,
        }


# 网页刷新或切页会断开 SSE，任务本身继续跑。事件留在这里，页面回来后从同一条流接上。
_AGENT_FEEDS: dict[str, dict] = {}
_AGENT_FEED_TTL = 30 * 60


def _sweep_agent_feeds(now: float | None = None) -> None:
    now = time.time() if now is None else now
    stale = [k for k, feed in _AGENT_FEEDS.items() if now - float(feed.get("created") or now) > _AGENT_FEED_TTL]
    for key in stale:
        _AGENT_FEEDS.pop(key, None)


def _ensure_agent_feed(task_id: str, user_id) -> dict:
    _sweep_agent_feeds()
    feed = _AGENT_FEEDS.get(task_id)
    if feed is None:
        feed = {
            "events": [],
            "notify": asyncio.Event(),
            "user_id": user_id,
            "finished": False,
            "created": time.time(),
            "pump": None,
        }
        _AGENT_FEEDS[task_id] = feed
    return feed


def _publish_agent_feed(task_id: str, event: dict) -> None:
    feed = _AGENT_FEEDS.get(task_id)
    if not feed:
        return
    events = feed["events"]
    # 进度是全文快照，只留最新一帧，重放时不会把同一段正文叠很多遍
    if event.get("event") == "progress" and events and events[-1].get("event") == "progress":
        events[-1] = event
    else:
        events.append(event)
    feed["notify"].set()


def agent_feed_exists(task_id: str) -> bool:
    _sweep_agent_feeds()
    return str(task_id or "").strip() in _AGENT_FEEDS


async def _pump_agent_feed(ctx: dict, guest: bool) -> None:
    """读出租方队列并记成可重放的事件。不跟某一次 HTTP 连接绑在一起。"""
    task_id = ctx["task_id"]
    feed = _ensure_agent_feed(task_id, ctx.get("consumer_user_id"))
    _publish_agent_feed(task_id, {"event": "started", "task_id": task_id})
    try:
        async for msg in _iter_agent_messages(ctx):
            if msg is None:
                final = await _refund_timeout(ctx)
                _publish_agent_feed(task_id, {**final, "event": "error", "guest": guest, "need_login_to_continue": guest})
                await _release_share_turn(task_id, final.get("output") or "")
                return
            if msg.get("type") == "agent_task_progress":
                _publish_agent_feed(task_id, {
                    "event": "progress",
                    "task_id": task_id,
                    "text": str(msg.get("text") or "")[:200_000],
                    "tool": msg.get("tool"),
                    "progress_event": msg.get("event"),
                    "parts": _public_progress_parts(msg.get("parts")),
                })
                continue
            await _remember_share_cli_session(ctx.get("share_id") or "", msg)
            final = await _finalize_agent_result(
                result=msg,
                task_id=task_id,
                aid=ctx["aid"],
                worker=_task_worker(ctx),
                guest=ctx["guest"],
                consumer_user_id=ctx["consumer_user_id"],
            )
            ev = "done" if final.get("ok") else "error"
            _publish_agent_feed(task_id, {**final, "event": ev, "guest": guest, "need_login_to_continue": guest})
            await _release_share_turn(task_id, final.get("output") or "")
            return
    except asyncio.CancelledError:
        raise
    except Exception as e:
        worker = _task_worker(ctx)
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
        await _release_share_turn(task_id, "")
        _publish_agent_feed(task_id, {
            "event": "error",
            "ok": False,
            "task_id": task_id,
            "status": "failed",
            "error": str(e),
            "guest": guest,
            "need_login_to_continue": guest,
        })
    finally:
        feed["finished"] = True
        feed["notify"].set()


async def _pump_gateway_stream_to_feed(
    *,
    task_id: str,
    worker,
    gateway_body: dict,
    timeout_sec: int,
    app_id: Optional[str],
    call_context: str,
    is_guest: bool,
    consumer_user_id: Optional[int],
    assistant_id: str,
) -> None:
    """后台泵：消费 Gateway over WebSocket 流并写入 feed，不与浏览器 SSE 连接绑定。
    
    浏览器断开主 SSE 不影响此泵继续运行，直到 completed/error 写入 feed。
    """
    from gateway_over_websocket import invoke_worker_gateway_stream
    
    feed = _AGENT_FEEDS.get(task_id)
    if not feed:
        return
    
    accumulated_text = ""
    success = False
    
    # Parts累积器：维护text + 所有tools的完整快照
    parts_accumulator = {
        "text": None,  # {"type": "text", "text": "..."}
        "tools": {},   # {tool_id: {"type": "tool", "name": "...", ...}}
    }
    
    try:
        async for gateway_event in invoke_worker_gateway_stream(
            worker=worker,
            method="POST",
            path="/v1/agent/responses",
            body=gateway_body,
            timeout_sec=timeout_sec,
            initiator=app_id,
        ):
            event_name = gateway_event.get("event")
            event_data = gateway_event.get("data", {})
            
            if event_name == "response.output_text.delta":
                delta = event_data.get("delta", "")
                accumulated_text += delta
                
                # 更新parts累积器（text部分）
                if call_context == "hired":
                    from agent_safety import sanitize_paths_in_output
                    session_root = event_data.get("metadata", {}).get("session_root")
                    sanitized_text = sanitize_paths_in_output(accumulated_text[:200_000], session_root=session_root)
                    sanitized_part = sanitize_paths_in_output(accumulated_text[:80_000], session_root=session_root)
                    
                    parts_accumulator["text"] = {"type": "text", "text": sanitized_part}
                    
                    # 构建完整parts快照（text + 所有tools）
                    parts = []
                    if parts_accumulator["text"]:
                        parts.append(parts_accumulator["text"])
                    parts.extend(parts_accumulator["tools"].values())
                    
                    progress_event = {
                        "event": "progress",
                        "task_id": task_id,
                        "status": "running",
                        "text": sanitized_text,
                        "parts": parts,
                    }
                else:
                    parts_accumulator["text"] = {"type": "text", "text": accumulated_text[:80_000]}
                    
                    # 构建完整parts快照
                    parts = []
                    if parts_accumulator["text"]:
                        parts.append(parts_accumulator["text"])
                    parts.extend(parts_accumulator["tools"].values())
                    
                    progress_event = {
                        "event": "progress",
                        "task_id": task_id,
                        "text": accumulated_text[:200_000],
                        "parts": parts,
                    }
                _publish_agent_feed(task_id, progress_event)
            
            elif event_name == "response.output_text.snapshot":
                accumulated_text = event_data.get("text", "")
                
                # 更新parts累积器（text部分）
                if call_context == "hired":
                    from agent_safety import sanitize_paths_in_output
                    session_root = event_data.get("metadata", {}).get("session_root")
                    sanitized_text = sanitize_paths_in_output(accumulated_text[:200_000], session_root=session_root)
                    sanitized_part = sanitize_paths_in_output(accumulated_text[:80_000], session_root=session_root)
                    
                    parts_accumulator["text"] = {"type": "text", "text": sanitized_part}
                    
                    # 构建完整parts快照（text + 所有tools）
                    parts = []
                    if parts_accumulator["text"]:
                        parts.append(parts_accumulator["text"])
                    parts.extend(parts_accumulator["tools"].values())
                    
                    progress_event = {
                        "event": "progress",
                        "task_id": task_id,
                        "status": "running",
                        "text": sanitized_text,
                        "parts": parts,
                    }
                else:
                    parts_accumulator["text"] = {"type": "text", "text": accumulated_text[:80_000]}
                    
                    # 构建完整parts快照
                    parts = []
                    if parts_accumulator["text"]:
                        parts.append(parts_accumulator["text"])
                    parts.extend(parts_accumulator["tools"].values())
                    
                    progress_event = {
                        "event": "progress",
                        "task_id": task_id,
                        "text": accumulated_text[:200_000],
                        "parts": parts,
                    }
                _publish_agent_feed(task_id, progress_event)
            
            elif event_name == "response.tool":
                tool_name = event_data.get("tool", "")
                tool_id = event_data.get("tool_use_id")
                detail = event_data.get("detail", "")
                result = event_data.get("result", "")
                status = event_data.get("status", "running")
                
                # 更新parts累积器（按id/name更新tool）
                tool_key = tool_id if tool_id else tool_name
                
                if call_context == "hired":
                    from agent_safety import sanitize_paths_in_output
                    session_root = event_data.get("metadata", {}).get("session_root")
                    
                    tool_part = {"type": "tool", "name": tool_name}
                    if tool_id:
                        tool_part["id"] = tool_id
                    if detail:
                        tool_part["detail"] = sanitize_paths_in_output(detail, session_root=session_root)
                    if result:
                        tool_part["result"] = sanitize_paths_in_output(result, session_root=session_root)
                    if status:
                        tool_part["status"] = status
                    
                    # 按id/name更新（不是替换整个列表）
                    parts_accumulator["tools"][tool_key] = tool_part
                    
                    # 构建完整parts快照（text + 所有tools）
                    parts = []
                    if parts_accumulator["text"]:
                        parts.append(parts_accumulator["text"])
                    parts.extend(parts_accumulator["tools"].values())
                    
                    sanitized_text = sanitize_paths_in_output(accumulated_text[:200_000], session_root=session_root)
                    
                    progress_event = {
                        "event": "progress",
                        "task_id": task_id,
                        "status": "running",
                        "text": sanitized_text,
                        "tool": tool_name,
                        "parts": parts,
                    }
                else:
                    tool_part = {"type": "tool", "name": tool_name}
                    if tool_id:
                        tool_part["id"] = tool_id
                    if detail:
                        tool_part["detail"] = detail
                    if result:
                        tool_part["result"] = result
                    if status:
                        tool_part["status"] = status
                    
                    # 按id/name更新
                    parts_accumulator["tools"][tool_key] = tool_part
                    
                    # 构建完整parts快照
                    parts = []
                    if parts_accumulator["text"]:
                        parts.append(parts_accumulator["text"])
                    parts.extend(parts_accumulator["tools"].values())
                    
                    progress_event = {
                        "event": "progress",
                        "task_id": task_id,
                        "text": accumulated_text[:200_000],
                        "tool": tool_name,
                        "parts": parts,
                    }
                _publish_agent_feed(task_id, progress_event)
            
            elif event_name == "response.completed":
                success = True
                gateway_status = event_data.get("status", "completed")
                
                # 提取输出文本
                output_text = accumulated_text
                output_from_completed = ""
                output_list = event_data.get("output", [])
                if isinstance(output_list, list) and output_list:
                    first_msg = output_list[0]
                    if isinstance(first_msg, dict):
                        content = first_msg.get("content", [])
                        if isinstance(content, list):
                            for item in content:
                                if isinstance(item, dict) and item.get("type") == "output_text":
                                    output_from_completed = str(item.get("text", ""))
                                    break
                if len(output_from_completed) > len(output_text):
                    output_text = output_from_completed
                
                # 结息给出租方
                if gateway_status == "completed" and worker.user_id:
                    await db.award_credits(
                        user_id=worker.user_id,
                        delta=AGENT_TASK_CREDITS,
                        type_="contribute",
                        model_name=f"agent:{assistant_id}",
                        tokens=0,
                        base_credits=AGENT_TASK_CREDITS,
                        multiplier=1.0,
                        note=f"agent_task kind=agent task_id={task_id} worker={worker.worker_id}",
                    )
                
                response_id = event_data.get("id")
                raw_artifacts = event_data.get("artifacts")
                
                # hired安全检查
                if call_context == "hired" and gateway_status == "completed":
                    from agent_safety import check_output_safety, sanitize_paths_in_output
                    
                    session_root = event_data.get("metadata", {}).get("session_root")
                    if session_root and "metadata" in event_data:
                        event_data["metadata"].pop("session_root", None)
                    
                    output_safe, output_err = check_output_safety(
                        output_text,
                        artifacts=raw_artifacts,
                        session_dir=session_root,
                    )
                    if not output_safe:
                        logger.warning(
                            "[pump_gateway] Blocked unsafe hired output: task=%s, assistant=%s",
                            task_id, assistant_id,
                        )
                        error_payload = {
                            "event": "error",
                            "ok": False,
                            "task_id": task_id,
                            "status": "failed",
                            "error": output_err or "Output violates safety policy",
                            "credits_refunded": AGENT_TASK_CREDITS if not is_guest else 0,
                        }
                        _publish_agent_feed(task_id, error_payload)
                        return
                    
                    processed_output, public_arts = _apply_artifacts(task_id, output_text, raw_artifacts)
                    processed_output = sanitize_paths_in_output(processed_output, session_root=session_root)
                elif call_context == "local":
                    processed_output, public_arts = output_text, []
                else:
                    processed_output, public_arts = output_text, []
                
                # Done时标记所有tools为done:true，构建完整parts
                for tool_part in parts_accumulator["tools"].values():
                    tool_part["done"] = True
                    if "status" not in tool_part:
                        tool_part["status"] = "completed"
                
                # 构建完整parts（text + 所有done的tools）
                final_parts = []
                if parts_accumulator["text"]:
                    final_parts.append(parts_accumulator["text"])
                final_parts.extend(parts_accumulator["tools"].values())
                
                done_payload = {
                    "event": "done",
                    "ok": True,
                    "task_id": task_id,
                    "status": gateway_status,
                    "output": processed_output[:200_000],
                    "usage": event_data.get("usage") or {},
                    "credits_charged": AGENT_TASK_CREDITS,
                    "guest": is_guest,
                    "need_login_to_continue": is_guest,
                    "parts": final_parts,  # 完整parts快照
                }
                if response_id:
                    done_payload["response_id"] = response_id
                if public_arts:
                    done_payload["artifacts"] = public_arts
                
                _publish_agent_feed(task_id, done_payload)
                return
            
            elif event_name == "error":
                error_msg = event_data.get("error", {}).get("message", "unknown error")
                
                # hired脱敏错误
                if call_context == "hired":
                    from agent_safety import sanitize_paths_in_output
                    session_root = event_data.get("metadata", {}).get("session_root") if event_data.get("metadata") else None
                    error_msg = sanitize_paths_in_output(error_msg, session_root=session_root)
                    accumulated_text = sanitize_paths_in_output(accumulated_text, session_root=session_root)
                
                # 失败退款
                if not is_guest:
                    await db.award_credits(
                        user_id=consumer_user_id,
                        delta=AGENT_TASK_CREDITS,
                        type_="refund",
                        model_name=f"agent:{assistant_id}",
                        tokens=0,
                        base_credits=AGENT_TASK_CREDITS,
                        multiplier=1.0,
                        note=f"agent_task failed refund task_id={task_id}",
                    )
                
                error_payload = {
                    "event": "error",
                    "ok": False,
                    "task_id": task_id,
                    "status": "failed",
                    "error": error_msg,
                    "output": accumulated_text[:200_000],
                    "credits_refunded": 0 if is_guest else AGENT_TASK_CREDITS,
                    "guest": is_guest,
                    "need_login_to_continue": is_guest,
                }
                _publish_agent_feed(task_id, error_payload)
                return
    
    except Exception as e:
        logger.error("[pump_gateway] stream error task_id=%s: %s", task_id, e)
        
        # hired脱敏异常
        error_msg = str(e)
        output_text = accumulated_text[:200_000]
        if call_context == "hired":
            from agent_safety import sanitize_paths_in_output
            error_msg = sanitize_paths_in_output(error_msg, session_root=None)
            output_text = sanitize_paths_in_output(output_text, session_root=None)
        
        # 失败退款
        if not is_guest:
            await db.award_credits(
                user_id=consumer_user_id,
                delta=AGENT_TASK_CREDITS,
                type_="refund",
                model_name=f"agent:{assistant_id}",
                tokens=0,
                base_credits=AGENT_TASK_CREDITS,
                multiplier=1.0,
                note=f"agent_task error refund task_id={task_id}",
            )
        
        error_payload = {
            "event": "error",
            "ok": False,
            "task_id": task_id,
            "status": "failed",
            "error": error_msg,
            "output": output_text,
            "credits_refunded": 0 if is_guest else AGENT_TASK_CREDITS,
            "guest": is_guest,
            "need_login_to_continue": is_guest,
        }
        _publish_agent_feed(task_id, error_payload)
    
    finally:
        # 标记feed完成
        if task_id in _AGENT_FEEDS:
            _AGENT_FEEDS[task_id]["finished"] = True
            _AGENT_FEEDS[task_id]["notify"].set()


def start_agent_feed(ctx: dict, guest: bool) -> None:
    feed = _ensure_agent_feed(ctx["task_id"], ctx.get("consumer_user_id"))
    pump = feed.get("pump")
    if pump is not None and not pump.done():
        return
    feed["pump"] = asyncio.create_task(_pump_agent_feed(ctx, guest))


async def iter_agent_feed_sse(task_id: str) -> AsyncIterator[str]:
    """从已有事件接上。连接断开不影响任务，下一次再从这个列表继续读。

    进度是全文快照，发布时会盖掉最后一帧而不是追加。已经读过这一格的连接
    必须看到被盖掉后的新对象，否则工具调用发生了，页面却一直停在第一段思考。
    """
    feed = _AGENT_FEEDS.get(str(task_id or "").strip())
    if not feed:
        return
    cursor = 0
    seen_progress = None
    while True:
        events = feed["events"]
        while cursor < len(events):
            ev = events[cursor]
            last = cursor == len(events) - 1
            if ev.get("event") == "progress" and last:
                if ev is not seen_progress:
                    seen_progress = ev
                    yield _sse(ev)
                break
            cursor += 1
            if ev.get("event") == "progress":
                if ev is not seen_progress:
                    seen_progress = ev
                    yield _sse(ev)
                continue
            yield _sse(ev)
            if ev.get("event") in ("done", "error"):
                return
        if feed.get("finished"):
            events = feed["events"]
            if cursor >= len(events):
                return
            tail = events[-1]
            if cursor == len(events) - 1 and tail.get("event") == "progress" and tail is seen_progress:
                return
        # 先清再看一眼，避免清掉刚刚写进来的那一帧
        feed["notify"].clear()
        events = feed["events"]
        if cursor < len(events):
            tail = events[-1] if events else None
            waiting_on_same = (
                tail
                and cursor == len(events) - 1
                and tail.get("event") == "progress"
                and tail is seen_progress
            )
            if not waiting_on_same:
                continue
        if feed.get("finished") and cursor >= len(feed["events"]):
            return
        try:
            await asyncio.wait_for(feed["notify"].wait(), timeout=15)
        except asyncio.TimeoutError:
            yield ": keepalive\n\n"


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
    share_id: Optional[str] = None,
    app_id: Optional[str] = None,
    previous_response_id: Optional[str] = None,
    call_context: str = "hired",
) -> AsyncIterator[str]:
    """SSE：progress 事件推正文，done/error 收尾。
    
    内部通过 Gateway-over-WebSocket 流式调用 worker 本地 Gateway。
    """
    from gateway_over_websocket import invoke_worker_gateway_stream

    # 选择 worker（先选，再根据 worker 决定 harness_id 格式）
    is_guest = consumer_user_id is None
    if not is_guest:
        user = await db.get_user_by_id(consumer_user_id)
        if not user or float(user["credits_balance"] or 0) < AGENT_TASK_CREDITS:
            payload = {
                "event": "error",
                "ok": False,
                "error": "Insufficient credits",
                "status": "rejected",
                "guest": is_guest,
                "need_login_to_continue": is_guest,
            }
            yield _sse(payload)
            return
        circles = set(await db.get_user_circle_ids(consumer_user_id))
    else:
        circles = set()

    workers = pool.pick_agent_workers(
        assistant_id, user_circle_ids=circles, worker_id=worker_id, owner=owner,
    )
    if not workers:
        payload = {
            "event": "error",
            "ok": False,
            "error": "该智能体当前无在线节点",
            "status": "rejected",
            "guest": is_guest,
            "need_login_to_continue": is_guest,
        }
        yield _sse(payload)
        return

    worker = workers[0]
    task_id = f"at-{uuid.uuid4().hex[:12]}"
    
    # 判断该 worker 是否本地拥有此 assistant（在其 agents 列表中）
    # 若是，使用本地 harness_id（assistant_id），避免客户端把它当作远程社区智能体再次回云端
    # 否则用 community: 格式（真正的远程雇佣场景）
    worker_has_local = any(
        isinstance(c, dict) and c.get("id") == assistant_id
        for c in (getattr(worker, "agents", None) or [])
    )
    
    if worker_has_local:
        # 本地智能体：直接用 assistant_id 作为 harness_id
        harness_id = assistant_id
    else:
        # 远程社区智能体：使用 community: 格式
        harness_id = f"community:{assistant_id}"
        if owner:
            harness_id = f"{harness_id}@{owner}"
    
    # 构建 Gateway 请求
    # 构建consumer_key用于隔离工作目录
    consumer_key = None
    if consumer_user_id:
        consumer_key = f"u{consumer_user_id}"
    elif guest_ip:
        # 游客用IP哈希作为consumer_key
        import hashlib
        h = hashlib.sha256(guest_ip.encode()).hexdigest()[:12]
        consumer_key = f"g{h}"
    
    # 安全：hired模式输入检查（程序级硬规则，第一层防御）
    if call_context == "hired":
        from agent_safety import check_input_safety, ensure_checker_available
        
        # 1. 验证检查器可用性（fail closed）
        checker_ok, checker_err = ensure_checker_available()
        if not checker_ok:
            payload = {
                "event": "error",
                "ok": False,
                "error": checker_err or "Safety checker unavailable",
                "status": "rejected",
            }
            yield _sse(payload)
            return
        
        # 2. 检查输入安全性
        files_meta = []
        if files:
            files_meta = [{"name": f.get("name", "")} for f in files]
        
        is_safe, safety_err = check_input_safety(prompt, files_meta)
        if not is_safe:
            logger.warning(
                "[dispatch_agent] Rejected unsafe hired input (SSE): task=%s, assistant=%s",
                task_id, assistant_id,
            )
            payload = {
                "event": "error",
                "ok": False,
                "error": safety_err or "Input violates safety policy",
                "status": "rejected",
            }
            yield _sse(payload)
            return
    
    gateway_body = {
        "input": prompt,
        "metadata": {
            "harness_id": harness_id,
            "call_context": call_context,
            "assistant_id": assistant_id,
            "consumer_key": consumer_key,
        },
    }
    
    # 附件：图片和文件（data URL格式）
    if images:
        gateway_body["images"] = images
    if files:
        gateway_body["files"] = files
    
    # 多轮对话：续上之前的 session（如果提供了 previous_response_id）
    if previous_response_id:
        gateway_body["previous_response_id"] = previous_response_id

    # 扣除积分
    if not is_guest:
        ok_deduct, bal = await db.deduct_credits(
            consumer_user_id,
            AGENT_TASK_CREDITS,
            model_name=f"agent:{assistant_id}",
            tokens=0,
            tier="p2p",
        )
        if not ok_deduct:
            payload = {
                "event": "error",
                "ok": False,
                "error": "Insufficient credits",
                "status": "rejected",
                "guest": is_guest,
                "need_login_to_continue": is_guest,
            }
            yield _sse(payload)
            return

    # 登记feed（让 /api/agent-tasks/{id}/events 可查询）
    feed = _ensure_agent_feed(task_id, consumer_user_id)
    
    # hired模式：后台泵解耦（浏览器断开不影响worker收包）
    if call_context == "hired":
        # 启动后台泵消费gateway stream
        pump = feed.get("pump")
        if pump is None or pump.done():
            feed["pump"] = asyncio.create_task(_pump_gateway_stream_to_feed(
                task_id=task_id,
                worker=worker,
                gateway_body=gateway_body,
                timeout_sec=(timeout_ms or AGENT_TASK_TIMEOUT_SEC * 1000) // 1000,
                app_id=app_id,
                call_context=call_context,
                is_guest=is_guest,
                consumer_user_id=consumer_user_id,
                assistant_id=assistant_id,
            ))
        
        # SSE从feed读取（断线不影响后台泵）
        async for sse_line in iter_agent_feed_sse(task_id):
            yield sse_line
        return
    
    # local模式：保持原有直接转发（不走feed，不解耦）
    # 发送 started 事件
    started_event = {"event": "started", "task_id": task_id}
    _publish_agent_feed(task_id, started_event)
    yield _sse(started_event)

    # 流式调用 worker 的本地 Gateway（local直接转发）
    accumulated_text = ""
    success = False
    try:
        async for gateway_event in invoke_worker_gateway_stream(
            worker=worker,
            method="POST",
            path="/v1/agent/responses",
            body=gateway_body,
            timeout_sec=(timeout_ms or AGENT_TASK_TIMEOUT_SEC * 1000) // 1000,
            initiator=app_id,  # 调用方显式传递
        ):
            event_name = gateway_event.get("event")
            event_data = gateway_event.get("data", {})

            if event_name == "response.output_text.delta":
                # Delta: 累积文本（local直接转发）
                delta = event_data.get("delta", "")
                accumulated_text += delta
                
                progress_event = {
                    "event": "progress",
                    "task_id": task_id,
                    "text": accumulated_text[:200_000],
                    "parts": [{"type": "text", "text": accumulated_text[:80_000]}],
                }
                _publish_agent_feed(task_id, progress_event)
                yield _sse(progress_event)
            
            elif event_name == "response.output_text.snapshot":
                # Snapshot: 替换文本（local直接转发）
                accumulated_text = event_data.get("text", "")
                
                progress_event = {
                    "event": "progress",
                    "task_id": task_id,
                    "text": accumulated_text[:200_000],
                    "parts": [{"type": "text", "text": accumulated_text[:80_000]}],
                }
                _publish_agent_feed(task_id, progress_event)
                yield _sse(progress_event)
            
            elif event_name == "response.tool":
                # 工具调用/结果（local直接转发）
                tool_name = event_data.get("tool", "")
                tool_id = event_data.get("tool_use_id")
                detail = event_data.get("detail", "")
                result = event_data.get("result", "")
                status = event_data.get("status", "running")
                
                tool_part = {"type": "tool", "name": tool_name}
                if tool_id:
                    tool_part["id"] = tool_id
                if detail:
                    tool_part["detail"] = detail
                if result:
                    tool_part["result"] = result
                if status:
                    tool_part["status"] = status
                
                progress_event = {
                    "event": "progress",
                    "task_id": task_id,
                    "text": accumulated_text[:200_000],
                    "tool": tool_name,
                    "parts": [tool_part],
                }
                _publish_agent_feed(task_id, progress_event)
                yield _sse(progress_event)
            
            elif event_name == "response.completed":
                # 完成
                success = True
                gateway_status = event_data.get("status", "completed")
                
                # 提取输出文本：优先使用流式累积的 accumulated_text（来自 delta 事件）
                # 但如果 completed.output 更长（工具调用后生成的文本可能没发delta），使用它
                output_text = accumulated_text
                
                # 始终检查 completed 事件的 output
                output_from_completed = ""
                output_list = event_data.get("output", [])
                if isinstance(output_list, list) and output_list:
                    first_msg = output_list[0]
                    if isinstance(first_msg, dict):
                        content = first_msg.get("content", [])
                        if isinstance(content, list):
                            for item in content:
                                if isinstance(item, dict) and item.get("type") == "output_text":
                                    output_from_completed = str(item.get("text", ""))
                                    break
                
                # 使用更长的那个（completed可能包含工具调用后生成的额外文本）
                if len(output_from_completed) > len(output_text):
                    output_text = output_from_completed

                # 结息给出租方
                if gateway_status == "completed" and worker.user_id:
                    await db.award_credits(
                        user_id=worker.user_id,
                        delta=AGENT_TASK_CREDITS,
                        type_="contribute",
                        model_name=f"agent:{assistant_id}",
                        tokens=0,
                        base_credits=AGENT_TASK_CREDITS,
                        multiplier=1.0,
                        note=f"agent_task kind=agent task_id={task_id} worker={worker.worker_id}",
                    )

                # 提取 response_id（用于多轮对话续session）
                response_id = event_data.get("id")
                
                # local：不上传artifacts，保留本地路径（hired已在前面return，这里只处理local）
                processed_output, public_arts = output_text, []
                
                done_payload = {
                    "event": "done",
                    "ok": True,
                    "task_id": task_id,
                    "status": gateway_status,
                    "output": processed_output[:200_000],
                    "usage": event_data.get("usage") or {},
                    "credits_charged": AGENT_TASK_CREDITS,
                    "guest": is_guest,
                    "need_login_to_continue": is_guest,
                }
                if response_id:
                    done_payload["response_id"] = response_id
                if public_arts:
                    done_payload["artifacts"] = public_arts
                
                # 发布到feed并标记完成
                _publish_agent_feed(task_id, done_payload)
                if task_id in _AGENT_FEEDS:
                    _AGENT_FEEDS[task_id]["finished"] = True
                
                yield _sse(done_payload)
                return
            
            elif event_name == "error":
                # 错误（local直接转发，hired已在前面return）
                error_msg = event_data.get("error", {}).get("message", "unknown error")
                
                # 失败退款
                if not is_guest:
                    await db.award_credits(
                        user_id=consumer_user_id,
                        delta=AGENT_TASK_CREDITS,
                        type_="refund",
                        model_name=f"agent:{assistant_id}",
                        tokens=0,
                        base_credits=AGENT_TASK_CREDITS,
                        multiplier=1.0,
                        note=f"agent_task failed refund task_id={task_id}",
                    )
                
                error_payload = {
                    "event": "error",
                    "ok": False,
                    "task_id": task_id,
                    "status": "failed",
                    "error": error_msg,
                    "output": accumulated_text[:200_000],
                    "credits_refunded": 0 if is_guest else AGENT_TASK_CREDITS,
                    "guest": is_guest,
                    "need_login_to_continue": is_guest,
                }
                
                # 发布到feed并标记完成
                _publish_agent_feed(task_id, error_payload)
                if task_id in _AGENT_FEEDS:
                    _AGENT_FEEDS[task_id]["finished"] = True
                
                yield _sse(error_payload)
                return

    except Exception as e:
        logger.error("[agent_task] stream error task_id=%s: %s", task_id, e)
        
        # local异常处理（hired已在前面return）
        error_msg = str(e)
        output_text = accumulated_text[:200_000]
        
        # 失败退款
        if not is_guest:
            await db.award_credits(
                user_id=consumer_user_id,
                delta=AGENT_TASK_CREDITS,
                type_="refund",
                model_name=f"agent:{assistant_id}",
                tokens=0,
                base_credits=AGENT_TASK_CREDITS,
                multiplier=1.0,
                note=f"agent_task error refund task_id={task_id}",
            )
        
        error_payload = {
            "event": "error",
            "ok": False,
            "task_id": task_id,
            "status": "failed",
            "error": error_msg,
            "output": output_text,
            "credits_refunded": 0 if is_guest else AGENT_TASK_CREDITS,
            "guest": is_guest,
            "need_login_to_continue": is_guest,
        }
        
        # 发布到feed并标记完成
        _publish_agent_feed(task_id, error_payload)
        if task_id in _AGENT_FEEDS:
            _AGENT_FEEDS[task_id]["finished"] = True
        
        yield _sse(error_payload)
