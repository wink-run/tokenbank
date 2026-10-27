"""出租智能体市场路由 - 面向消费者的智能体雇用（对齐虚拟智能体命名）"""

import json
import logging
import secrets
import time
import uuid
from typing import Optional

from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel

import database as db
from auth import get_current_user_id, get_optional_user_id

logger = logging.getLogger(__name__)
router = APIRouter()

# agent:* 通行门票据（不落 tools FK；V1 内存）
_agent_gate_tickets: dict[str, dict] = {}
_AGENT_GATE_TICKET_TTL_SEC = 30 * 60


def redeem_agent_gate_ticket(ticket_id: str, assistant_id: str) -> Optional[dict]:
    """Consume a pending tools-hub gate ticket for one anonymous agent use.

    Returns ticket meta on success; None if missing/expired/mismatched/already used.
    Ad-watched tickets authorize use without login; paid tickets are issued only
    after login+debit at /api/tools/gate.
    """
    tid = (ticket_id or "").strip()
    aid = (assistant_id or "").strip()
    if not tid or not aid:
        return None
    meta = _agent_gate_tickets.get(tid)
    if not meta:
        return None
    if meta.get("status") != "pending":
        return None
    if str(meta.get("assistant_id") or "").strip() != aid:
        return None
    created = float(meta.get("created_at") or 0)
    if created and (time.time() - created) > _AGENT_GATE_TICKET_TTL_SEC:
        meta["status"] = "expired"
        return None
    meta["status"] = "used"
    meta["used_at"] = time.time()
    return meta


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
    """工具通行门请求（看广告 OR 付费）"""
    tool_id: str  # 数字 id 或 agent:<assistant_id>
    gate_type: str  # 'ad' or 'paid'


class TaskStartRequest(BaseModel):
    """启动任务请求"""
    ticket_id: str
    input_data: dict


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

    用户出租：与 Network → Agents / /public/agents 同源（在线 worker 公开名片）
    平台虚拟：tools 表 trust_level=virtual 的种子/平台条目（对齐虚拟模型）
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

    for a in live:
        if not isinstance(a, dict):
            continue
        aid = str(a.get("id") or "").strip()
        if not aid:
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
            # 场景筛选命中工具种子时，跳过在线出租（它们统一归「在线智能体」）
            continue
        cards.append({
            "id": f"agent:{aid}",
            "name": a.get("name") or aid,
            "display_name": dn,
            "description": desc or "在线出租智能体，看广告或付积分即可使用",
            "icon": "🤖",
            "scene": "agent",
            "scene_display_name": "在线智能体",
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

    # 2) 平台虚拟（tools 表，仅 virtual；避免假「用户出租」种子盖过真出租）
    query = """
        SELECT
            t.id, t.name, t.display_name, t.description, t.icon,
            t.scene, t.scene_display_name, t.featured, t.trust_level,
            tv.pricing_type, tv.pricing_amount,
            t.created_at, t.updated_at
        FROM tools t
        JOIN tool_versions tv ON t.id = tv.tool_id AND tv.is_active = 1
        WHERE t.enabled = 1 AND t.trust_level = 'virtual'
    """
    params: list = []
    if scene_f and scene_f not in ("agent", "rented"):
        query += " AND t.scene = ?"
        params.append(scene_f)
    elif scene_f in ("agent", "rented"):
        # 只要在线出租时，不再附带虚拟种子
        query += " AND 1=0"
    if q:
        query += " AND (LOWER(t.display_name) LIKE ? OR LOWER(COALESCE(t.description,'')) LIKE ?)"
        params.extend([f"%{q}%", f"%{q}%"])
    query += " ORDER BY t.featured DESC, t.created_at DESC"

    try:
        async with db.connect() as conn:
            rows = await conn.fetch_all(query, params)
        for row in rows:
            item = dict(row)
            item["id"] = item["id"]  # int ok for seed virtual
            item["source"] = "virtual"
            item["online"] = True
            item["try_url"] = f"/tools/{item['id']}"
            cards.append(item)
    except Exception as e:
        logger.warning("discover: virtual tools query failed: %s", e)

    # 场景聚合
    scenes_map = {"agent": "在线智能体"}
    try:
        async with db.connect() as conn:
            scene_rows = await conn.fetch_all(
                """
                SELECT DISTINCT scene, scene_display_name
                FROM tools
                WHERE enabled = 1 AND trust_level = 'virtual'
                  AND scene IS NOT NULL AND scene != ''
                ORDER BY scene
                """
            )
        for row in scene_rows:
            scenes_map[row["scene"]] = row["scene_display_name"] or row["scene"]
    except Exception:
        pass
    if any(c.get("source") == "network" for c in cards):
        scenes_map.setdefault("agent", "在线智能体")

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
            "description": desc or "在线出租智能体",
            "detail_desc": (
                f"供给者 @{owner}" if owner else "用户出租智能体"
            ) + (f" · 运行时 {runtime}" if runtime else "")
            + "\n与 Network → 智能体同源；通行门后打开网页对话。",
            "icon": "🤖",
            "scene": "agent",
            "scene_display_name": "在线智能体",
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
            "online": True,
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
    通过通行门雇用智能体（看广告 OR 付积分）
    - 看广告：免费，模拟广告播放成功
    - 付积分：扣除积分（需登录）
    用户出租（agent:*）与平台虚拟共用同一套收费模式
    """
    tid = str(req.tool_id or "").strip()
    if not tid:
        raise HTTPException(status_code=400, detail="tool_id required")

    if req.gate_type not in ("ad", "paid"):
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
        pricing_amount = 1.0
        if req.gate_type == "ad":
            settlement_type = "ad_watched"
            credits_cost = 0
        else:
            settlement_type = "credits_paid"
            credits_cost = pricing_amount
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

        ticket_id = f"tkt_{secrets.token_urlsafe(16)}"
        # 把广告/付费票带进对话页，匿名看完广告即可用，不必再登录
        redirect_url = f"/a/{aid}?gate_ticket={ticket_id}"
        _agent_gate_tickets[ticket_id] = {
            "tool_id": tid,
            "assistant_id": aid,
            "user_id": user_id,
            "settlement_type": settlement_type,
            "credits_cost": credits_cost,
            "redirect_url": redirect_url,
            "display_name": dn,
            "status": "pending",
            "created_at": time.time(),
        }
        return {
            "ticket_id": ticket_id,
            "tool_id": tid,
            "settlement_type": settlement_type,
            "credits_cost": credits_cost,
            "redirect_url": redirect_url,
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

    if req.gate_type == "ad":
        settlement_type = "ad_watched"
        credits_cost = 0
    else:
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

    if req.gate_type == "paid" and user_id and credits_cost > 0:
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
