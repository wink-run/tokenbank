"""出租智能体市场路由 - 面向消费者的智能体雇用（对齐虚拟智能体命名）"""

import json
import logging
import secrets
import uuid
from typing import Optional

from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel

import database as db
from auth import get_current_user_id, get_optional_user_id

logger = logging.getLogger(__name__)
router = APIRouter()


# ── V1 演示辅助函数 ────────────────────────────────────────────────────────────

async def _demo_process_task(task_id: str):
    """
    V1 演示级：模拟出租智能体处理任务
    真实版本：
    - 用户出租智能体：由开发者的 dispatch_url 处理并回调
    - 平台虚拟智能体：类似虚拟模型，由平台提供算力
    """
    import asyncio
    import random
    
    # 模拟处理延迟 3-8 秒
    await asyncio.sleep(random.uniform(3, 8))
    
    # 更新进度
    async with db.connect() as conn:
        await conn.execute("""
            UPDATE tool_tasks 
            SET status = 'processing', progress = 0.5
            WHERE task_id = ?
        """, [task_id])
        await conn.commit()
    
    await asyncio.sleep(random.uniform(2, 4))
    
    # 模拟完成
    result_data = {
        "success": True,
        "message": "处理完成（演示）",
        "download_url": "https://example.com/demo-result.pdf",
        "demo_note": "V1 演示结果 - 真实版本将由用户出租智能体或平台虚拟智能体处理",
    }
    
    async with db.connect() as conn:
        await conn.execute("""
            UPDATE tool_tasks 
            SET status = 'completed', progress = 1.0, 
                result_data = ?, completed_at = CURRENT_TIMESTAMP
            WHERE task_id = ?
        """, [json.dumps(result_data), task_id])
        await conn.commit()


# ── 数据模型 ──────────────────────────────────────────────────────────────────

class ToolGateRequest(BaseModel):
    """工具通行门请求。只接受付积分，看广告不能换使用资格。"""
    tool_id: str  # 数字 id 或 agent:<assistant_id>
    gate_type: str  # 仅 'paid'


class TaskStartRequest(BaseModel):
    """启动任务请求"""
    ticket_id: str
    input_data: dict


async def _snapshot_live_public_agents() -> None:
    """把此刻在线的公开名片写入库，节点稍后断开也不会从列表消失。"""
    try:
        from worker_pool import pool
    except Exception:
        return
    # 同一用户的每台终端都要记下来，不能只留先连上的那一台
    for w in pool.all_workers():
        wid = str(getattr(w, "worker_id", "") or "")
        if wid.startswith("vw-"):
            continue
        uid = getattr(w, "user_id", None)
        if not uid:
            continue
        try:
            await db.replace_owner_public_agents(int(uid), getattr(w, "agents", None) or [])
        except Exception as e:
            logger.warning("snapshot public agents failed: %s", e)


# ── 工具发现 ──────────────────────────────────────────────────────────────────

@router.get("/api/tools/discover")
async def discover_tools(
    scene: Optional[str] = None,
    search: Optional[str] = None,
    limit: int = 20,
    user_id: Optional[int] = Depends(get_optional_user_id),
):
    """
    出租智能体发现首页（用户出租 + 平台虚拟）

    用户出租：与 Network → Agents / /public/agents 同源（在线 worker 公开名片）。
    平台虚拟示例（一键抠图、PDF 转 Word）不再列入。
    """
    q = (search or "").strip().lower()
    scene_f = (scene or "").strip()
    lim = max(1, min(int(limit or 20), 100))
    cards: list[dict] = []

    # 1) 在线用户出租智能体（Network Agents 同源）
    try:
        from worker_pool import pool
        live = pool.list_agents_for_user(public_only=True) or []
    except Exception as e:
        logger.warning("discover: list public agents failed: %s", e)
        live = []

    seen_live = set()
    for a in live:
        if not isinstance(a, dict):
            continue
        aid = str(a.get("id") or "").strip()
        if not aid or aid in seen_live:
            continue
        dn = (a.get("display_name") or a.get("name") or aid).strip()
        desc = (a.get("description") or "").strip()
        owner = (a.get("owner_nickname") or "").strip()
        runtime = (a.get("runtime") or "").strip()
        if q:
            blob = f"{dn} {desc} {owner} {runtime} {aid}".lower()
            if q not in blob:
                continue
        if scene_f and scene_f not in ("agent", "rented"):
            # 场景筛选命中工具种子时，跳过在线出租（它们统一归「智能体」）
            continue
        # 同一智能体在多台终端同时在线时只展示一条
        seen_live.add(aid)
        cards.append({
            "id": f"agent:{aid}",
            "name": a.get("name") or aid,
            "display_name": dn,
            "description": desc or "公开智能体",
            "icon": "🤖",
            "scene": "agent",
            "scene_display_name": "智能体",
            "featured": 1,
            "trust_level": "user_rented",
            "pricing_type": "ad_or_paid",
            "pricing_amount": 1.0,
            "owner_nickname": owner,
            "runtime": runtime,
            "assistant_id": aid,
            "try_url": f"/a/{aid}",
            "source": "network",
            "online": True,
        })

    # 先把当前在线名片记下，之后节点断开列表里还能看到
    await _snapshot_live_public_agents()
    # 暂时离线的公开智能体：名片还在，打开只能看历史
    live_ids = {str(c.get("assistant_id") or "") for c in cards}
    try:
        stored = await db.list_stored_public_agents()
    except Exception as e:
        logger.warning("discover: stored agents failed: %s", e)
        stored = []
    for a in stored:
        aid = str(a.get("id") or "").strip()
        if not aid or aid in live_ids:
            continue
        dn = (a.get("display_name") or a.get("name") or aid).strip()
        desc = (a.get("description") or "").strip()
        owner = (a.get("owner_nickname") or "").strip()
        runtime = (a.get("runtime") or "").strip()
        if q:
            blob = f"{dn} {desc} {owner} {runtime} {aid}".lower()
            if q not in blob:
                continue
        if scene_f and scene_f not in ("agent", "rented"):
            continue
        cards.append({
            "id": f"agent:{aid}",
            "name": a.get("name") or aid,
            "display_name": dn,
            "description": desc or "暂时不在线，可查看历史对话",
            "icon": "🤖",
            "scene": "agent",
            "scene_display_name": "智能体",
            "featured": 0,
            "trust_level": "user_rented",
            "pricing_type": "ad_or_paid",
            "pricing_amount": 1.0,
            "owner_nickname": owner,
            "runtime": runtime,
            "assistant_id": aid,
            "try_url": f"/a/{aid}",
            "source": "network",
            "online": False,
        })

    # 只保留真实出租的智能体。平台虚拟示例不进列表。
    scenes_map = {}
    if any(c.get("source") == "network" for c in cards):
        scenes_map["agent"] = "智能体"

    return {
        "tools": cards[:lim],
        "scenes": [{"value": k, "label": v} for k, v in scenes_map.items()],
    }


# ── 工具详情 ──────────────────────────────────────────────────────────────────

@router.get("/api/tools/{tool_id}")
async def get_tool_detail(
    tool_id: str,
    user_id: Optional[int] = Depends(get_optional_user_id),
):
    """获取出租智能体详情（用户出租 / 平台虚拟）"""
    tid = (tool_id or "").strip()

    # Network 在线出租：agent:<assistant_id>
    if tid.startswith("agent:"):
        aid = tid[6:].strip()
        if not aid:
            raise HTTPException(status_code=404, detail="Tool not found")
        try:
            from worker_pool import pool
            card = pool.get_agent_for_user(aid, public_only=True)
        except Exception as e:
            logger.warning("tool detail agent lookup failed: %s", e)
            card = None
        offline = False
        if not card:
            card = await db.get_stored_public_agent(aid)
            offline = bool(card)
        if not card:
            raise HTTPException(status_code=404, detail="Agent offline or not found")
        dn = (card.get("display_name") or card.get("name") or aid).strip()
        desc = (card.get("description") or "").strip()
        owner = (card.get("owner_nickname") or "").strip()
        runtime = (card.get("runtime") or "").strip()
        return {
            "id": f"agent:{aid}",
            "name": card.get("name") or aid,
            "display_name": dn,
            "description": desc or ("暂时不在线，可查看历史对话" if offline else "公开智能体"),
            "detail_desc": (
                f"供给者 @{owner}" if owner else "用户出租智能体"
            ) + (f" · 运行时 {runtime}" if runtime else "")
            + ("\n暂时不在线，不能发起新对话，历史记录仍可查看。" if offline else ""),
            "icon": "🤖",
            "scene": "agent",
            "scene_display_name": "智能体",
            "featured": 1,
            "trust_level": "user_rented",
            "pricing_type": "ad_or_paid",
            "pricing_amount": 1.0,
            "dispatch_type": "rented_agent",
            "owner_nickname": owner,
            "runtime": runtime,
            "assistant_id": aid,
            "try_url": f"/a/{aid}",
            "source": "network",
            "online": not offline,
            "manifest": {},
        }

    # 平台虚拟 / 种子：数字 id
    try:
        numeric_id = int(tid)
    except ValueError:
        raise HTTPException(status_code=404, detail="Tool not found")

    query = """
        SELECT
            t.id, t.name, t.display_name, t.description, t.detail_desc,
            t.icon, t.scene, t.scene_display_name, t.featured, t.trust_level,
            tv.id as version_id, tv.version, tv.pricing_type, tv.pricing_amount,
            tv.dispatch_type, tv.dispatch_url, tv.timeout_seconds, tv.manifest,
            t.publisher_id, t.created_at, t.updated_at
        FROM tools t
        JOIN tool_versions tv ON t.id = tv.tool_id AND tv.is_active = 1
        WHERE t.id = ? AND t.enabled = 1
    """

    async with db.connect() as conn:
        tool = await conn.fetch_one(query, [numeric_id])

    if not tool:
        raise HTTPException(status_code=404, detail="Tool not found")

    result = dict(tool)
    result["try_url"] = f"/tools/{numeric_id}"
    result["source"] = "virtual" if result.get("trust_level") == "virtual" else "tools"
    if result.get("manifest"):
        try:
            result["manifest"] = json.loads(result["manifest"])
        except Exception:
            result["manifest"] = {}

    return result


# ── 通行门 ────────────────────────────────────────────────────────────────────

@router.post("/api/tools/gate")
async def pass_gate(
    req: ToolGateRequest,
    user_id: Optional[int] = Depends(get_optional_user_id),
):
    """
    通过通行门雇用智能体（付积分，需登录）。
    看广告不能换使用资格。
    """
    tid = str(req.tool_id or "").strip()
    if not tid:
        raise HTTPException(status_code=400, detail="tool_id required")

    # 看广告不再发放免费使用
    if req.gate_type != "paid":
        raise HTTPException(status_code=400, detail="Invalid gate_type")

    # ── 用户出租智能体（与 Network 同源）──────────────────────────────────────
    if tid.startswith("agent:"):
        aid = tid[6:].strip()
        if not aid:
            raise HTTPException(status_code=404, detail="Tool not found")
        try:
            from worker_pool import pool
            card = pool.get_agent_for_user(aid, public_only=True)
        except Exception as e:
            logger.warning("gate agent lookup failed: %s", e)
            card = None
        if not card:
            raise HTTPException(status_code=404, detail="Agent offline or not found")

        dn = (card.get("display_name") or card.get("name") or aid).strip()
        credits_cost = 1.0
        if not user_id:
            raise HTTPException(status_code=401, detail="Login required to pay with credits")
        async with db.connect() as conn:
            user = await conn.fetch_one(
                "SELECT credits_balance FROM users WHERE id = ?",
                [user_id],
            )
        if user and user["credits_balance"] < credits_cost:
            raise HTTPException(status_code=402, detail="Insufficient credits")
        await db.add_transaction(
            user_id=user_id,
            type="tool_usage",
            delta=-credits_cost,
            note=f"使用出租智能体: {dn}",
            model_name=f"tool_{tid}",
        )
        # 登录后直接进对话，不再发广告票
        return {
            "ticket_id": "",
            "tool_id": tid,
            "settlement_type": "credits_paid",
            "credits_cost": credits_cost,
            "redirect_url": f"/a/{aid}",
        }

    # ── 平台虚拟 / 种子（数字 id）────────────────────────────────────────────
    try:
        numeric_id = int(tid)
    except ValueError:
        raise HTTPException(status_code=404, detail="Tool not found")

    async with db.connect() as conn:
        tool = await conn.fetch_one("""
            SELECT t.id, t.display_name, tv.pricing_type, tv.pricing_amount
            FROM tools t
            JOIN tool_versions tv ON t.id = tv.tool_id AND tv.is_active = 1
            WHERE t.id = ?
        """, [numeric_id])

    if not tool:
        raise HTTPException(status_code=404, detail="Tool not found")

    ticket_id = f"tkt_{secrets.token_urlsafe(16)}"
    settlement_type = "credits_paid"
    credits_cost = tool["pricing_amount"] or 0
    if not user_id:
        raise HTTPException(status_code=401, detail="Login required to pay with credits")
    async with db.connect() as conn:
        user = await conn.fetch_one(
            "SELECT credits_balance FROM users WHERE id = ?",
            [user_id],
        )
    if user and user["credits_balance"] < credits_cost:
        raise HTTPException(status_code=402, detail="Insufficient credits")

    async with db.connect() as conn:
        await conn.execute("""
            INSERT INTO tool_tickets
            (ticket_id, tool_id, user_id, settlement_type, credits_cost, status, created_at)
            VALUES (?, ?, ?, ?, ?, 'pending', CURRENT_TIMESTAMP)
        """, [ticket_id, numeric_id, user_id, settlement_type, credits_cost])
        await conn.commit()

    if user_id and credits_cost > 0:
        await db.add_transaction(
            user_id=user_id,
            type="tool_usage",
            delta=-credits_cost,
            note=f"使用工具: {tool['display_name']}",
            model_name=f"tool_{numeric_id}",
        )

    return {
        "ticket_id": ticket_id,
        "tool_id": numeric_id,
        "settlement_type": settlement_type,
        "credits_cost": credits_cost,
    }


# ── 任务执行 ──────────────────────────────────────────────────────────────────

@router.post("/api/tools/tasks/start")
async def start_task(
    req: TaskStartRequest,
    user_id: Optional[int] = Depends(get_current_user_id),
):
    """
    调度出租智能体执行任务
    - 验证 ticket
    - 派发到用户出租智能体或平台虚拟智能体
    - 返回 task_id 用于查询进度
    """
    # 验证 ticket
    async with db.connect() as conn:
        ticket = await conn.fetch_one("""
            SELECT tt.*, tv.dispatch_type, tv.dispatch_url, tv.timeout_seconds
            FROM tool_tickets tt
            JOIN tool_versions tv ON tt.tool_id = tv.tool_id AND tv.is_active = 1
            WHERE tt.ticket_id = ? AND tt.status = 'pending'
        """, [req.ticket_id])
    
    if not ticket:
        raise HTTPException(status_code=404, detail="Invalid or used ticket")
    
    # 创建任务
    task_id = f"tsk_{secrets.token_urlsafe(16)}"
    
    async with db.connect() as conn:
        await conn.execute("""
            INSERT INTO tool_tasks 
            (task_id, ticket_id, tool_id, user_id, input_data, status, created_at)
            VALUES (?, ?, ?, ?, ?, 'created', CURRENT_TIMESTAMP)
        """, [task_id, req.ticket_id, ticket["tool_id"], user_id, json.dumps(req.input_data)])
        
        # 标记 ticket 为已使用
        await conn.execute("""
            UPDATE tool_tickets 
            SET status = 'used', used_at = CURRENT_TIMESTAMP
            WHERE ticket_id = ?
        """, [req.ticket_id])
        
        await conn.commit()
    
    # V1: 仅支持站内调度到开发者智能体
    if ticket["dispatch_type"] == "rented_agent":
        # 租用代理：V1 演示级 - 模拟派发和处理
        async with db.connect() as conn:
            await conn.execute("""
                UPDATE tool_tasks 
                SET status = 'dispatched', dispatched_at = CURRENT_TIMESTAMP
                WHERE task_id = ?
            """, [task_id])
            await conn.commit()
        
        # V1: 演示级自动完成逻辑（模拟智能体处理）
        # 真实版本应该调用 dispatch_url 并等待回调
        import asyncio
        asyncio.create_task(_demo_process_task(task_id))
        
        return {
            "task_id": task_id,
            "status": "dispatched",
            "message": "任务已派发到智能体，正在处理中…",
        }
    
    else:
        raise HTTPException(status_code=400, detail="Unsupported dispatch_type")


# ── 任务状态查询 ──────────────────────────────────────────────────────────────

@router.get("/api/tools/tasks/{task_id}")
async def get_task_status(
    task_id: str,
    user_id: Optional[int] = Depends(get_current_user_id),
):
    """查询任务状态和结果"""
    async with db.connect() as conn:
        task = await conn.fetch_one("""
            SELECT 
                tt.task_id, tt.tool_id, tt.status, tt.progress, 
                tt.result_data, tt.error_message,
                tt.created_at, tt.dispatched_at, tt.completed_at,
                t.display_name as tool_name
            FROM tool_tasks tt
            JOIN tools t ON tt.tool_id = t.id
            WHERE tt.task_id = ?
        """, [task_id])
    
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    
    result = dict(task)
    
    # 解析 JSON 字段
    if result.get("result_data"):
        try:
            result["result_data"] = json.loads(result["result_data"])
        except:
            pass
    
    return result


# ── 我的工具使用记录 ──────────────────────────────────────────────────────────

@router.get("/api/tools/my-tasks")
async def get_my_tasks(
    limit: int = 20,
    user_id: int = Depends(get_current_user_id),
):
    """获取用户的工具使用记录"""
    async with db.connect() as conn:
        tasks = await conn.fetch_all("""
            SELECT 
                tt.task_id, tt.tool_id, tt.status, 
                tt.created_at, tt.completed_at,
                t.display_name as tool_name, t.icon
            FROM tool_tasks tt
            JOIN tools t ON tt.tool_id = t.id
            WHERE tt.user_id = ?
            ORDER BY tt.created_at DESC
            LIMIT ?
        """, [user_id, limit])
    
    return {
        "tasks": [dict(row) for row in tasks],
    }
