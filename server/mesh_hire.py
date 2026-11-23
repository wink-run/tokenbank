"""雇佣走设备通道：云端只签票、记账，看不到提示词和结果。

和 /api/agent-tasks 的区别：
- 雇佣方 app 先来领票（POST /mesh/hire/ticket）：云端选好出租方设备、扣好积分、签一张雇佣票；
- 雇佣方凭票经官方中继把任务端到端加密交给出租方设备（client/electron/mesh/hire.js）；
- 出租方做完先来结算（POST /mesh/hire/{task_id}/settle，用设备密钥签名），再把结果交给雇佣方；
- 雇佣方中途不要了可以取消（POST /mesh/hire/{task_id}/cancel）；到期没人结算就退款。
出租方没开设备网络、或者是旧客户端时返回 409 mesh_unavailable，雇佣方照旧走 /api/agent-tasks。
"""

from __future__ import annotations

import asyncio
import logging
import time
import uuid
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

import database as db
import mesh_cert
from agent_boundary import resolve_call_context
from agent_output import should_award_contributor, should_charge
from auth import get_current_user_id
from dispatch_agent import AGENT_TASK_CREDITS, AGENT_TASK_TIMEOUT_SEC, _refund_task_charge, consumer_isolation_key
from mesh_router import _verify_device_sig, ensure_tables, issuer
from pg_compat import connect
from worker_pool import pool, worker_owner_id

logger = logging.getLogger("server")
router = APIRouter()

MESH_HIRE_CAP = "mesh_hire"
_tables_ready = False


async def _ensure() -> None:
    global _tables_ready
    if _tables_ready:
        return
    await ensure_tables()
    async with connect() as d:
        await d.execute("""
            CREATE TABLE IF NOT EXISTS mesh_hires (
                task_id         TEXT PRIMARY KEY,
                assistant_id    TEXT NOT NULL,
                hirer_user      INTEGER NOT NULL,
                hirer_device    TEXT NOT NULL,
                worker_user     INTEGER NOT NULL,
                worker_device   TEXT NOT NULL,
                worker_endpoint TEXT NOT NULL,
                worker_id       TEXT,
                call_context    TEXT NOT NULL,
                charged         INTEGER NOT NULL DEFAULT 0,
                status          TEXT NOT NULL,
                exp             BIGINT NOT NULL,
                created_at      BIGINT NOT NULL,
                settled_at      BIGINT
            )
        """)
        # 结算、取消、到期抢同一单：谁写进 claim 谁算数
        await d.execute("ALTER TABLE mesh_hires ADD COLUMN IF NOT EXISTS claim TEXT")
        await d.commit()
    _tables_ready = True


async def _endpoint_of(device_id: str, user_id) -> Optional[str]:
    async with connect() as d:
        async with d.execute(
            "SELECT endpoint_id FROM mesh_endpoints WHERE device_id=? AND user_id=?", (str(device_id or ""), int(user_id))
        ) as cur:
            row = await cur.fetchone()
    return row[0] if row else None


def _unavailable(reason: str):
    return HTTPException(409, {"code": "mesh_unavailable", "message": reason})


class TicketRequest(BaseModel):
    assistant_id: str
    caller_device_id: str
    owner: Optional[str] = None
    worker_id: Optional[str] = None
    timeout_ms: Optional[int] = None
    session_key: Optional[str] = None


@router.post("/mesh/hire/ticket")
async def hire_ticket(req: TicketRequest, uid: int = Depends(get_current_user_id)):
    await _ensure()
    aid = req.assistant_id.strip()
    if not aid:
        raise HTTPException(400, "assistant_id required")
    hirer_endpoint = await _endpoint_of(req.caller_device_id, uid)
    if not hirer_endpoint:
        raise _unavailable("这台设备没开设备网络")
    circles = set(await db.get_user_circle_ids(uid))
    workers = pool.pick_agent_workers(
        aid, user_circle_ids=circles, worker_id=req.worker_id, owner=req.owner,
        exclude_device_id=req.caller_device_id.strip() or None,
    )
    picked = None
    for w in workers:
        if MESH_HIRE_CAP not in (getattr(w, "caps", None) or []):
            continue
        mesh_dev = getattr(w, "mesh_device_id", "") or getattr(w, "device_id", "")
        ep = await _endpoint_of(mesh_dev, worker_owner_id(w))
        if ep:
            picked = (w, ep, mesh_dev)
            break
    if not picked:
        raise _unavailable("出租方设备没开设备网络" if workers else "该智能体当前无在线节点")
    worker, worker_endpoint, worker_device = picked
    call_context = resolve_call_context(uid, worker_owner_id(worker))
    if call_context == "owner":
        raise _unavailable("自己的设备走「我的设备」，不用雇佣")
    task_id = f"at-{uuid.uuid4().hex[:12]}"
    charged = should_charge(call_context, False)
    if charged:
        ok, bal = await db.deduct_credits(uid, AGENT_TASK_CREDITS, model_name=f"agent:{aid}", tokens=0, tier="p2p")
        if not ok:
            raise HTTPException(402, {"code": "insufficient_credits", "message": "Insufficient credits",
                                      "balance": bal, "credits_required": AGENT_TASK_CREDITS})
        try:
            await db.record_agent_task_charge(task_id, uid, aid, AGENT_TASK_CREDITS)
        except Exception:
            logger.exception("[mesh_hire] record charge failed task_id=%s", task_id)
            await db.award_credits(user_id=uid, delta=AGENT_TASK_CREDITS, type_="refund", model_name=f"agent:{aid}",
                                   tokens=0, base_credits=AGENT_TASK_CREDITS, multiplier=1.0,
                                   note=f"mesh hire ticket failed refund task_id={task_id}")
            raise _unavailable("记账失败")
    timeout_sec = max(30, min(int((req.timeout_ms or AGENT_TASK_TIMEOUT_SEC * 1000) / 1000), 3600))
    ticket, exp = mesh_cert.issue_hire_ticket(
        issuer(), task_id=task_id, assistant_id=aid,
        hirer_user=uid, hirer_device=req.caller_device_id.strip(), hirer_endpoint=hirer_endpoint,
        worker_user=worker_owner_id(worker), worker_device=worker_device, worker_endpoint=worker_endpoint,
        call_context=call_context, consumer_key=consumer_isolation_key(uid),
        session_key=(req.session_key or "").strip()[:120], ttl_sec=timeout_sec + 120,
    )
    async with connect() as d:
        await d.execute(
            """INSERT INTO mesh_hires (task_id, assistant_id, hirer_user, hirer_device, worker_user, worker_device,
                 worker_endpoint, worker_id, call_context, charged, status, exp, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)""",
            (task_id, aid, uid, req.caller_device_id.strip(), int(worker_owner_id(worker)), worker_device,
             worker_endpoint, worker.worker_id, call_context, 1 if charged else 0, exp, int(time.time())),
        )
        await d.commit()
    asyncio.create_task(_expire_later(task_id, exp))
    logger.info("[mesh_hire] ticket task_id=%s assistant=%s hirer=%s worker=%s", task_id, aid, uid, worker.worker_id)
    return {
        "task_id": task_id, "ticket": ticket, "expires_at": exp, "call_context": call_context,
        "credits_charged": AGENT_TASK_CREDITS if charged else 0,
        "worker": {"device_id": worker_device, "user_id": str(worker_owner_id(worker))},
    }


async def _row(task_id: str):
    async with connect() as d:
        async with d.execute(
            "SELECT task_id, assistant_id, hirer_user, worker_user, worker_endpoint, worker_id, call_context, charged, status, exp "
            "FROM mesh_hires WHERE task_id=?", (task_id,)
        ) as cur:
            r = await cur.fetchone()
    if not r:
        return None
    keys = ["task_id", "assistant_id", "hirer_user", "worker_user", "worker_endpoint", "worker_id", "call_context", "charged", "status", "exp"]
    return {k: r[i] for i, k in enumerate(keys)}


async def _claim(task_id: str, status: str) -> bool:
    """只从 pending 改走一次：结算、取消、到期三者只有一个生效"""
    token = uuid.uuid4().hex
    async with connect() as d:
        await d.execute(
            "UPDATE mesh_hires SET status=?, settled_at=?, claim=? WHERE task_id=? AND status='pending'",
            (status, int(time.time()), token, task_id),
        )
        await d.commit()
        async with d.execute("SELECT claim FROM mesh_hires WHERE task_id=?", (task_id,)) as cur:
            row = await cur.fetchone()
    return bool(row) and row[0] == token


async def _refund(row: dict, note: str) -> float:
    return await _refund_task_charge(row["task_id"], row["hirer_user"], row["assistant_id"], bool(row["charged"]), note)


async def _expire_later(task_id: str, exp: int) -> None:
    try:
        await asyncio.sleep(max(1, exp - time.time() + 5))
        row = await _row(task_id)
        if row and await _claim(task_id, "expired"):
            await _refund(row, f"mesh hire expired refund task_id={task_id}")
    except Exception:
        logger.exception("[mesh_hire] expire failed task_id=%s", task_id)


async def live_mesh_hire_ids() -> set:
    """还在有效期里、没结算的雇佣：重启时不当孤儿退款，出租方还会来结算"""
    await _ensure()
    async with connect() as d:
        async with d.execute("SELECT task_id, exp FROM mesh_hires WHERE status='pending' AND exp >= ?", (int(time.time()),)) as cur:
            rows = await cur.fetchall()
    for r in rows:
        asyncio.create_task(_expire_later(r[0], int(r[1])))
    return {r[0] for r in rows}


async def refund_expired_mesh_hires() -> int:
    """服务重启后：到期没结算的退掉"""
    await _ensure()
    async with connect() as d:
        async with d.execute("SELECT task_id FROM mesh_hires WHERE status='pending' AND exp < ?", (int(time.time()),)) as cur:
            ids = [r[0] for r in await cur.fetchall()]
    n = 0
    for tid in ids:
        row = await _row(tid)
        if row and await _claim(tid, "expired"):
            await _refund(row, f"mesh hire expired refund task_id={tid}")
            n += 1
    return n


class SettleRequest(BaseModel):
    status: str          # completed / failed / rejected / timeout / cancelled
    sig: str             # 出租方设备密钥签 `tb-hire-settle|<task_id>|<status>`
    duration_ms: Optional[int] = None


@router.post("/mesh/hire/{task_id}/settle")
async def hire_settle(task_id: str, req: SettleRequest):
    """出租方做完来结算。凭出租方设备的签名，不靠登录：设备密钥就是票上那把"""
    await _ensure()
    row = await _row(task_id)
    if not row:
        raise HTTPException(404, "no such hire")
    status = req.status.strip().lower()
    if not _verify_device_sig(row["worker_endpoint"], f"tb-hire-settle|{task_id}|{status}", req.sig):
        raise HTTPException(403, "签名不对")
    if row["status"] != "pending":
        # 雇佣方已经取消、或者到期退款了：出租方不该再交结果
        return {"ok": False, "status": row["status"]}
    success = status == "completed"
    if not await _claim(task_id, "completed" if success else "failed"):
        return {"ok": False, "status": (await _row(task_id) or {}).get("status")}
    aid = row["assistant_id"]
    worker = next((w for w in getattr(pool, "_workers", []) if w.worker_id == row["worker_id"]), None)
    if worker is not None:
        try:
            worker.record_agent_complete(aid, success, req.duration_ms)
        except Exception:
            pass
    if not success:
        refunded = await _refund(row, f"mesh hire failed refund task_id={task_id} status={status}")
        return {"ok": True, "status": "failed", "credits_refunded": refunded}
    if should_award_contributor(row["call_context"], True):
        await db.award_credits(
            user_id=row["worker_user"], delta=AGENT_TASK_CREDITS, type_="contribute", model_name=f"agent:{aid}",
            tokens=0, base_credits=AGENT_TASK_CREDITS, multiplier=1.0,
            note=f"agent_task kind=agent via=mesh task_id={task_id} worker={row['worker_id']}",
        )
        now = datetime.now().isoformat(timespec="seconds")
        try:
            await db.log_settlement(
                worker_id=row["worker_id"] or "", user_id=row["worker_user"], period_start=now, period_end=now,
                online_mins=0, output_tokens=0, avg_latency=0, success_rate=1.0, multiplier=1.0,
                credits_awarded=AGENT_TASK_CREDITS, resources=[f"agent:{aid}"],
            )
        except Exception:
            logger.exception("[mesh_hire] log_settlement failed task_id=%s", task_id)
    if row["charged"]:
        try:
            await db.finish_agent_task_charge(task_id, "completed")
        except Exception:
            logger.exception("[mesh_hire] charge complete failed task_id=%s", task_id)
    return {"ok": True, "status": "completed"}


@router.post("/mesh/hire/{task_id}/cancel")
async def hire_cancel(task_id: str, uid: int = Depends(get_current_user_id)):
    """雇佣方不要了（连不上出租方、或者中途叫停）：还没结算就退款"""
    await _ensure()
    row = await _row(task_id)
    if not row or int(row["hirer_user"]) != int(uid):
        raise HTTPException(404, "no such hire")
    if not await _claim(task_id, "cancelled"):
        return {"ok": False, "status": row["status"]}
    refunded = await _refund(row, f"mesh hire cancelled refund task_id={task_id}")
    return {"ok": True, "status": "cancelled", "credits_refunded": refunded}


@router.get("/mesh/hire/{task_id}")
async def hire_status(task_id: str, uid: int = Depends(get_current_user_id)):
    row = await _row(task_id)
    if not row or int(uid) not in (int(row["hirer_user"]), int(row["worker_user"])):
        raise HTTPException(404, "no such hire")
    return {"task_id": task_id, "status": row["status"], "assistant_id": row["assistant_id"], "expires_at": row["exp"]}
