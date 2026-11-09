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
    rewrite_artifact_paths,
)
from agent_boundary import redact_hired_text, reject_hired_input, resolve_call_context
from agent_output import settle_output, should_award_contributor, should_charge
from worker_pool import pool, worker_owner_id

logger = logging.getLogger("server")

# 一次用户发言算一次交互。同一对话里的多轮各自扣一次，可用环境变量覆盖
AGENT_TASK_CREDITS = float(os.getenv("AGENT_TASK_CREDITS", "5"))
# 默认超时 10 分钟（本机 CLI 可能较慢）
AGENT_TASK_TIMEOUT_SEC = int(os.getenv("AGENT_TASK_TIMEOUT_SEC", "600"))


def _sse(data: dict) -> str:
    return f"data: {json.dumps(data, ensure_ascii=False)}\n\n"


def _visible_text(text: str, call_context: str) -> str:
    """雇佣才抹路径和密钥。本人的正文保持原样。"""
    if call_context == "hired":
        return redact_hired_text(text)
    return str(text or "")


def _public_progress_parts(raw, call_context: str = "owner") -> list:
    """网页对话用的分段：正文 / 思考 / 工具。丢掉未知字段，限制长度。

    雇佣的正文留到终态，避免密钥先出现在增量里。工具状态照常推。
    """
    hired = call_context == "hired"
    out = []
    if not isinstance(raw, list):
        return out
    for item in raw[:80]:
        if not isinstance(item, dict):
            continue
        kind = str(item.get("type") or "")
        if kind == "tool":
            detail = str(item.get("detail") or "")
            result = str(item.get("result") or "")
            tool = {
                "type": "tool",
                "name": str(item.get("name") or "tool")[:80],
                "detail": _visible_text(detail, call_context)[:4000],
            }
            shown = _visible_text(result, call_context)
            if shown:
                tool["result"] = shown[:4000]
            status = str(item.get("status") or "").strip().lower()
            # 结束态无论写 done 还是 status，网页都按同一种完成来收
            if item.get("done") or status in ("completed", "complete", "done", "error", "failed"):
                tool["done"] = True
            if item.get("error") or status in ("error", "failed"):
                tool["error"] = True
            out.append(tool)
            continue
        if hired or kind not in ("text", "thinking"):
            continue
        text = str(item.get("text") or "")
        if not text.strip():
            continue
        out.append({"type": kind, "text": text[:80_000]})
    return out


def _apply_artifacts(task_id: str, output: str, raw, call_context: str = "owner") -> tuple[str, list]:
    """成品存到本服务，正文里的本机路径换成 /media/agent 中转地址。地址换完再拦截雇佣正文。"""
    stored = publish_agent_artifacts(task_id, raw)
    text = rewrite_artifact_paths(output, stored) if stored else output
    return _visible_text(text, call_context), public_artifacts(stored)


# 正文先到、文件后到。旧客户端这段时间内断线仍保留正文
_ARTIFACT_FOLLOW_SEC = 20
# 同一幂等键再来时接上这一单，不新开
_IDEMPOTENCY: dict[str, dict] = {}


def _idem_slot(user_id, guest_ip: Optional[str], key: Optional[str]) -> str:
    token = str(key or "").strip()
    if not token:
        return ""
    who = f"u{int(user_id)}" if user_id is not None else f"g{guest_ip or ''}"
    return f"{who}:{token[:80]}"


def _idem_lookup(slot: str, digest: str):
    """返回 join 的任务号、conflict，或 None。"""
    if not slot:
        return None
    row = _IDEMPOTENCY.get(slot)
    if not row:
        return None
    if str(row.get("digest") or "") != str(digest or ""):
        return "conflict"
    return str(row.get("task_id") or "")


def _idem_store(slot: str, digest: str, task_id: str) -> None:
    if not slot or not task_id:
        return
    _IDEMPOTENCY[slot] = {"digest": digest, "task_id": task_id}
    if len(_IDEMPOTENCY) > 400:
        _IDEMPOTENCY.pop(next(iter(_IDEMPOTENCY)))


async def _refund_task_charge(task_id: str, user_id, aid: str, charged: bool, note: str) -> float:
    """只退扣过的那一笔。本人和访客没有记录，直接返回 0。"""
    if not charged or user_id is None:
        return 0
    try:
        state = await db.claim_agent_task_refund(task_id)
    except Exception:
        logger.exception("[agent_task] claim refund failed task_id=%s", task_id)
        state = "missing"
    if state == "settled":
        return 0
    await db.award_credits(
        user_id=user_id,
        delta=AGENT_TASK_CREDITS,
        type_="refund",
        model_name=f"agent:{aid}",
        tokens=0,
        base_credits=AGENT_TASK_CREDITS,
        multiplier=1.0,
        note=note,
    )
    return AGENT_TASK_CREDITS


async def refund_orphaned_agent_charges() -> int:
    """服务端重启后，内存里的任务没了。还标着 running 的退回一次。"""
    try:
        rows = await db.list_running_agent_task_charges()
    except Exception:
        logger.exception("[agent_task] list running charges failed")
        return 0
    count = 0
    for row in rows:
        try:
            amount = await _refund_task_charge(
                str(row.get("task_id") or ""),
                row.get("user_id"),
                str(row.get("assistant_id") or ""),
                True,
                f"agent_task restart refund task_id={row.get('task_id')}",
            )
        except Exception:
            logger.exception("[agent_task] restart refund failed task_id=%s", row.get("task_id"))
            continue
        if amount:
            count += 1
    return count


def _release_pending(ctx: dict, msg: dict) -> dict:
    task_id = ctx["task_id"]
    owner = _task_worker(ctx)
    if owner is not None:
        owner.pending_agents.pop(task_id, None)
    out = dict(msg)
    out.pop("artifacts_follow", None)
    out.pop("output_commit", None)
    return out


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
    """读队列。新客户端先给清单再给字节，到齐才结束。

    旧客户端仍是正文先到、文件后补，超过等待就放行，并标明没走确认。
    清单还没到齐就断线，终态是待补传，不把正文当成完成。
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
    commit = None
    manifest = None
    artifacts = None

    def _emit(msg: dict) -> dict:
        return _release_pending(ctx, msg)

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
        if kind == "agent_task_progress" and held is None and commit is None:
            text = str(msg.get("text") or "")
            if text:
                ctx["partial_output"] = text[:200_000]
            yield msg
            continue
        if kind == "agent_task_output_manifest":
            manifest = msg
            if commit is not None:
                yield _emit(settle_output(commit, manifest, artifacts, confirmed=True))
                return
            continue
        if kind == "agent_task_artifacts":
            artifacts = msg.get("artifacts")
            if held is not None:
                merged = dict(held)
                merged["artifacts"] = artifacts
                # 旧的第二帧：有字节就带上，仍标明这轮没走清单确认
                yield _emit(settle_output(merged, None, artifacts, confirmed=False))
                return
            if commit is not None and manifest is not None:
                yield _emit(settle_output(commit, manifest, artifacts, confirmed=True))
                return
            continue
        if kind == "agent_task_result":
            if msg.get("output_commit"):
                commit = msg
                if manifest is not None:
                    yield _emit(settle_output(commit, manifest, artifacts, confirmed=True))
                    return
                continue
            if msg.get("artifacts_follow"):
                held = msg
                file_deadline = min(deadline, time.time() + _ARTIFACT_FOLLOW_SEC)
                continue
            yield _emit(settle_output(_keep_partial_on_disconnect(msg, ctx), None, msg.get("artifacts"), confirmed=False))
            return
        if (held is not None or commit is not None) and msg.get("error") == "worker disconnected":
            base = commit or held
            confirmed = commit is not None
            settled = settle_output(base, manifest, artifacts, confirmed=confirmed)
            if confirmed and settled.get("status") == "completed":
                settled["status"] = "output_pending"
                settled["error"] = "output_pending"
                settled["output_confirmed"] = False
            yield _emit(settled)
            return
        if msg.get("status") or msg.get("error"):
            if held is not None or commit is not None:
                base = commit or held
                yield _emit(settle_output(base, manifest, artifacts, confirmed=commit is not None))
                return
            yield _emit(settle_output(_keep_partial_on_disconnect(msg, ctx), None, None, confirmed=False))
            return
    if commit is not None:
        settled = settle_output(commit, manifest, artifacts, confirmed=True)
        if settled.get("status") == "completed":
            settled["status"] = "output_pending"
            settled["error"] = "output_pending"
            settled["output_confirmed"] = False
        yield _emit(settled)
        return
    if held is not None:
        yield _emit(settle_output(held, None, artifacts, confirmed=False))
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
    call_context: str = "hired",
    charged: bool = False,
) -> dict:
    """处理终态结果：退款 / 结息 / 组装响应。待补传不退，缺文件和失败才退。"""
    status = (result or {}).get("status") or "failed"
    success = status == "completed"
    pending = status == "output_pending"
    usage = (result or {}).get("usage") or {}
    duration_ms = usage.get("duration_ms")
    worker.record_agent_complete(aid, success, duration_ms if isinstance(duration_ms, (int, float)) else None)

    refunded = 0.0
    if not success and not pending:
        already_refunded = bool((result or {}).get("cancel_settled"))
        if not already_refunded:
            refunded = await _refund_task_charge(
                task_id,
                consumer_user_id,
                aid,
                charged,
                f"agent_task failed refund task_id={task_id} status={status}",
            )
        failed = {
            "ok": False,
            "task_id": task_id,
            "status": status,
            "error": (result or {}).get("error") or status,
            "output": (result or {}).get("output") or "",
            "credits_refunded": refunded,
            "call_context": call_context,
        }
        text, arts = _apply_artifacts(task_id, failed["output"], (result or {}).get("artifacts"), call_context)
        failed["output"] = text
        if arts:
            failed["artifacts"] = arts
        return failed

    if success and should_award_contributor(call_context, True) and getattr(worker, "user_id", None):
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
        if charged:
            try:
                await db.finish_agent_task_charge(task_id, "completed")
            except Exception:
                logger.exception("[agent_task] charge complete failed task_id=%s", task_id)

    done = {
        "ok": success,
        "task_id": task_id,
        "status": status,
        "output": str((result or {}).get("output") or "")[:200_000],
        "usage": usage,
        "credits_charged": AGENT_TASK_CREDITS if charged else 0,
        "call_context": call_context,
        "output_confirmed": bool((result or {}).get("output_confirmed")),
    }
    if pending:
        done["error"] = "output_pending"
    text, arts = _apply_artifacts(task_id, done["output"], (result or {}).get("artifacts"), call_context)
    done["output"] = text
    if arts:
        done["artifacts"] = arts
    if pending and charged:
        asyncio.create_task(_expire_output_pending(task_id, consumer_user_id, aid))
    return done


async def _expire_output_pending(task_id: str, user_id, aid: str) -> None:
    """待补传超过事件保留时间仍没完成，改成失败并退款。"""
    try:
        await asyncio.sleep(_AGENT_FEED_TTL)
        await _refund_task_charge(
            task_id,
            user_id,
            aid,
            True,
            f"agent_task pending expired task_id={task_id}",
        )
    except Exception:
        logger.exception("[agent_task] pending expire failed task_id=%s", task_id)


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
    session_key: Optional[str] = None,
    idempotency_key: Optional[str] = None,
    idempotency_digest: Optional[str] = None,
    caller_device_id: Optional[str] = None,
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
    slot = _idem_slot(consumer_user_id, guest_ip, idempotency_key)
    joined = _idem_lookup(slot, idempotency_digest or "")
    if joined == "conflict":
        return None, {
            "ok": False,
            "error": "idempotency key reused with a different body",
            "status": "conflict",
        }
    if joined:
        return {
            "join_task_id": joined,
            "guest": guest,
            "consumer_user_id": consumer_user_id,
        }, None
    consumer_key = consumer_isolation_key(consumer_user_id, guest_ip=guest_ip)
    # 分享里的下一句必须回到发起人那条会话，不能按当前发言人新开
    continue_session = False
    cli_session_id = ""
    bound_share = (share_id or "").strip()[:40]
    # 没有分享号时，用调用方自己的对话线程把工作目录隔开
    bound_session = (session_key or "").strip()[:120]
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
        if not user:
            return None, {"ok": False, "error": "user not found", "status": "rejected"}
        circles = set(await db.get_user_circle_ids(consumer_user_id))
    else:
        circles = set()

    caller_dev = (caller_device_id or "").strip()
    workers = pool.pick_agent_workers(
        aid, user_circle_ids=circles, worker_id=worker_id, owner=owner,
        exclude_device_id=caller_dev or None,
    )
    if not workers and caller_dev:
        # 只有本机自己在线时，上面会被排除光。这和「没人在线」不是同一件事。
        own = pool.pick_agent_workers(
            aid, user_circle_ids=circles, worker_id=worker_id, owner=owner,
        )
        if own:
            return None, {
                "ok": False,
                "error": "不能雇佣本机上的智能体",
                "status": "rejected",
            }
    if not workers:
        return None, {
            "ok": False,
            "error": "该智能体当前无在线节点（出租方可能已离线、未勾选贡献，或节点尚未重连上报）",
            "status": "rejected",
        }

    worker = workers[0]
    # 执行节点属于调用人自己：自己的智能体。否则是雇来的，才做输入检查
    call_context = resolve_call_context(consumer_user_id, worker_owner_id(worker))
    charged = should_charge(call_context, guest)
    if charged:
        user = await db.get_user_by_id(consumer_user_id)
        if not user or float(user["credits_balance"] or 0) < AGENT_TASK_CREDITS:
            return None, {
                "ok": False,
                "error": "Insufficient credits",
                "status": "rejected",
                "credits_required": AGENT_TASK_CREDITS,
                "call_context": call_context,
            }
    if call_context == "hired":
        names = [item.get("name") for item in (img_list or []) + (file_list or []) if isinstance(item, dict)]
        rejected = reject_hired_input(text, names)
        if rejected:
            return None, {"ok": False, "error": rejected, "status": "rejected", "call_context": "hired"}
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
        "share_id": bound_share,
        "session_key": bound_session,
        "images": img_list or None,
        "files": file_list or None,
        "partial_output": "",
        "worker_box": worker_box,
        "clock": clock,
        "call_context": call_context,
        "charged": False,
    }
    worker.active_requests += 1

    if charged:
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
                "call_context": call_context,
            }
        worker.pending_agents[task_id]["charged"] = True
        try:
            await db.record_agent_task_charge(task_id, consumer_user_id, aid, AGENT_TASK_CREDITS)
        except Exception:
            logger.exception("[agent_task] record charge failed task_id=%s", task_id)
    _idem_store(slot, idempotency_digest or "", task_id)

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
            "share_id": bound_share or None,
            "session_key": bound_session or None,
            "images": img_list or None,
            "files": file_list or None,
            # 客户端不认识的字段会忽略，登录环境保持原样
            "call_context": call_context,
        })
        logger.info(
            "[agent_task] dispatch task_id=%s assistant=%s worker=%s user=%s guest=%s key=%s",
            task_id, aid, worker.worker_id, consumer_user_id, guest, consumer_key,
        )
    except Exception as e:
        worker.pending_agents.pop(task_id, None)
        worker.active_requests = max(0, worker.active_requests - 1)
        await _refund_task_charge(
            task_id, consumer_user_id, aid, charged,
            f"agent_task error refund task_id={task_id}",
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
        "call_context": call_context,
        "charged": charged,
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
        await _refund_task_charge(
            task_id,
            entry.get("consumer_user_id"),
            str(entry.get("assistant_id") or ""),
            bool(entry.get("charged")),
            f"agent_task cancelled refund task_id={task_id}",
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
    await _refund_task_charge(
        task_id,
        entry.get("consumer_user_id"),
        str(entry.get("assistant_id") or ""),
        bool(entry.get("charged")),
        f"agent_task cancelled refund task_id={task_id}",
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
    refunded = await _refund_task_charge(
        task_id, consumer_user_id, aid, bool(ctx.get("charged")),
        f"agent_task timeout refund task_id={task_id}",
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
        "credits_refunded": refunded,
    }


async def _join_existing_result(task_id: str) -> dict:
    """同一个幂等键再来：等原来那一单的终态，不新开、不另扣。"""
    deadline = time.time() + AGENT_TASK_TIMEOUT_SEC
    while time.time() < deadline:
        feed = _AGENT_FEEDS.get(task_id)
        if feed:
            for ev in reversed(feed.get("events") or []):
                if ev.get("event") in ("done", "error"):
                    return {k: v for k, v in ev.items() if k != "event"}
            if feed.get("finished"):
                break
        await asyncio.sleep(0.2)
    return {
        "ok": False,
        "task_id": task_id,
        "status": "timeout",
        "error": "idempotent wait timeout",
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
    session_key: Optional[str] = None,
    idempotency_key: Optional[str] = None,
    idempotency_digest: Optional[str] = None,
    caller_device_id: Optional[str] = None,
) -> dict:
    """选节点，按本人或雇佣校验，下发后等到终态。失败退款。"""
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
        share_id=share_id,
        session_key=session_key,
        idempotency_key=idempotency_key,
        idempotency_digest=idempotency_digest,
        caller_device_id=caller_device_id,
    )
    if err:
        if guest_ip and err.get("status") == "rejected":
            from web_public import release_guest_trial
            release_guest_trial(guest_ip)
        return err
    assert ctx is not None
    if ctx.get("join_task_id"):
        return await _join_existing_result(ctx["join_task_id"])
    try:
        async for msg in _iter_agent_messages(ctx):
            if msg is None:
                return await _refund_timeout(ctx)
            if msg.get("type") == "agent_task_progress":
                continue  # 非流式忽略过程事件
            await _remember_share_cli_session(ctx.get("share_id") or "", msg)
            return await _finalize_agent_result(
                result=msg,
                task_id=ctx["task_id"],
                aid=ctx["aid"],
                worker=_task_worker(ctx),
                guest=ctx["guest"],
                consumer_user_id=ctx["consumer_user_id"],
                call_context=ctx.get("call_context") or "hired",
                charged=bool(ctx.get("charged")),
            )
        return await _refund_timeout(ctx)
    except Exception as e:
        worker = _task_worker(ctx)
        task_id = ctx["task_id"]
        aid = ctx["aid"]
        guest = ctx["guest"]
        consumer_user_id = ctx["consumer_user_id"]
        worker.pending_agents.pop(task_id, None)
        worker.active_requests = max(0, worker.active_requests - 1)
        await _refund_task_charge(
            task_id, consumer_user_id, aid, bool(ctx.get("charged")),
            f"agent_task error refund task_id={task_id}",
        )
        worker.record_agent_complete(aid, False)
        logger.error("[agent_task] error task_id=%s: %s", task_id, e)
        return {"ok": False, "task_id": task_id, "status": "failed", "error": str(e)}


# 网页刷新或切页会断开 SSE，任务本身继续跑。事件留在这里，页面回来后从同一条流接上。
_AGENT_FEEDS: dict[str, dict] = {}
_AGENT_FEED_TTL = 30 * 60


def _sweep_agent_feeds(now: float | None = None) -> None:
    now = time.time() if now is None else now
    stale = [k for k, feed in _AGENT_FEEDS.items() if now - float(feed.get("created") or now) > _AGENT_FEED_TTL]
    for key in stale:
        _AGENT_FEEDS.pop(key, None)


def _ensure_agent_feed(task_id: str, user_id, call_context: str = "hired") -> dict:
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
            "call_context": call_context if call_context in ("owner", "hired") else "hired",
        }
        _AGENT_FEEDS[task_id] = feed
    return feed


def _publish_agent_feed(task_id: str, event: dict) -> None:
    feed = _AGENT_FEEDS.get(task_id)
    if not feed:
        return
    # 标出是自己的还是雇来的。页面只读它已经认识的字段
    event = dict(event)
    event.setdefault("call_context", feed.get("call_context") or "hired")
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
    feed = _ensure_agent_feed(task_id, ctx.get("consumer_user_id"), ctx.get("call_context") or "hired")
    _publish_agent_feed(task_id, {"event": "started", "task_id": task_id})
    try:
        async for msg in _iter_agent_messages(ctx):
            if msg is None:
                final = await _refund_timeout(ctx)
                _publish_agent_feed(task_id, {**final, "event": "error", "guest": guest, "need_login_to_continue": guest})
                await _release_share_turn(task_id, final.get("output") or "")
                return
            if msg.get("type") == "agent_task_progress":
                hired = (ctx.get("call_context") or "") == "hired"
                _publish_agent_feed(task_id, {
                    "event": "progress",
                    "task_id": task_id,
                    "text": "" if hired else str(msg.get("text") or "")[:200_000],
                    "tool": msg.get("tool"),
                    "progress_event": msg.get("event"),
                    "parts": _public_progress_parts(msg.get("parts"), ctx.get("call_context") or "owner"),
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
                call_context=ctx.get("call_context") or "hired",
                charged=bool(ctx.get("charged")),
            )
            terminal = final.get("status") in ("output_pending", "output_missing")
            ev = "done" if final.get("ok") or terminal else "error"
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
        await _refund_task_charge(
            task_id, consumer_user_id, aid, bool(ctx.get("charged")),
            f"agent_task error refund task_id={task_id}",
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


def start_agent_feed(ctx: dict, guest: bool) -> None:
    feed = _ensure_agent_feed(ctx["task_id"], ctx.get("consumer_user_id"), ctx.get("call_context") or "hired")
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
    session_key: Optional[str] = None,
    idempotency_key: Optional[str] = None,
    idempotency_digest: Optional[str] = None,
    caller_device_id: Optional[str] = None,
) -> AsyncIterator[str]:
    """SSE：progress 事件推正文，done/error 收尾。页面断开后任务仍继续。"""
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
        share_id=share_id,
        session_key=session_key,
        idempotency_key=idempotency_key,
        idempotency_digest=idempotency_digest,
        caller_device_id=caller_device_id,
    )
    if err:
        # 还没派到设备上：这次不算试用，避免第一条还没回复就被额度拦住
        if guest and guest_ip and err.get("status") == "rejected":
            from web_public import release_guest_trial
            release_guest_trial(guest_ip)
        payload = {**err, "event": "error", "guest": guest, "need_login_to_continue": guest}
        yield _sse(payload)
        return

    assert ctx is not None
    if ctx.get("join_task_id"):
        tid = str(ctx["join_task_id"])
        for _ in range(50):
            if tid in _AGENT_FEEDS:
                break
            await asyncio.sleep(0.1)
        async for chunk in iter_agent_feed_sse(tid):
            yield chunk
        return
    start_agent_feed(ctx, guest)
    async for chunk in iter_agent_feed_sse(ctx["task_id"]):
        yield chunk
