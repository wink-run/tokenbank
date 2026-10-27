"""工具合集站路由 - 面向消费者的工具发现和使用"""

import json
import logging
import secrets
import time
import uuid
from typing import Optional

from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel

import database as db
from auth import get_current_user_id

logger = logging.getLogger(__name__)
router = APIRouter()


# ── V1 演示辅助函数 ────────────────────────────────────────────────────────────

async def _demo_process_task(task_id: str):
    """
    V1 演示级：模拟智能体处理任务
    真实版本应该由开发者的 dispatch_url 处理并回调
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
        "demo_note": "这是 V1 演示结果，真实版本将由开发者智能体处理",
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
    tool_id: int
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
    user_id: Optional[int] = Depends(get_current_user_id),
):
    """
    工具发现首页
    - 支持场景筛选（scene: download, watermark, image, office 等）
    - 支持搜索（search: 关键词）
    - 返回精选工具列表
    """
    query = """
        SELECT 
            t.id, t.name, t.display_name, t.description, t.icon,
            t.scene, t.featured, t.trust_level,
            tv.pricing_type, tv.pricing_amount,
            t.created_at, t.updated_at
        FROM tools t
        JOIN tool_versions tv ON t.id = tv.tool_id AND tv.is_active = 1
        WHERE t.enabled = 1
    """
    params = []
    
    if scene:
        query += " AND t.scene = ?"
        params.append(scene)
    
    if search:
        query += " AND (t.display_name LIKE ? OR t.description LIKE ?)"
        search_pattern = f"%{search}%"
        params.extend([search_pattern, search_pattern])
    
    query += " ORDER BY t.featured DESC, t.created_at DESC LIMIT ?"
    params.append(limit)
    
    async with db.connect() as conn:
        tools = await conn.fetch_all(query, params)
    
    # 获取场景列表
    scenes_query = """
        SELECT DISTINCT scene, scene_display_name 
        FROM tools 
        WHERE enabled = 1 AND scene IS NOT NULL AND scene != ''
        ORDER BY scene
    """
    async with db.connect() as conn:
        scenes = await conn.fetch_all(scenes_query)
    
    return {
        "tools": [dict(row) for row in tools],
        "scenes": [{"value": row["scene"], "label": row["scene_display_name"]} for row in scenes],
    }


# ── 工具详情 ──────────────────────────────────────────────────────────────────

@router.get("/api/tools/{tool_id}")
async def get_tool_detail(
    tool_id: int,
    user_id: Optional[int] = Depends(get_current_user_id),
):
    """获取工具详情"""
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
        tool = await conn.fetch_one(query, [tool_id])
    
    if not tool:
        raise HTTPException(status_code=404, detail="Tool not found")
    
    result = dict(tool)
    # 解析 manifest JSON
    if result.get("manifest"):
        try:
            result["manifest"] = json.loads(result["manifest"])
        except:
            result["manifest"] = {}
    
    return result


# ── 通行门 ────────────────────────────────────────────────────────────────────

@router.post("/api/tools/gate")
async def pass_gate(
    req: ToolGateRequest,
    user_id: Optional[int] = Depends(get_current_user_id),
):
    """
    通过通行门（看广告 OR 付费）
    - 看广告：免费，模拟广告播放成功
    - 付费：扣除积分或记录订单
    成功后返回 task_ticket 用于启动任务
    """
    # 获取工具信息
    async with db.connect() as conn:
        tool = await conn.fetch_one("""
            SELECT t.id, t.display_name, tv.pricing_type, tv.pricing_amount
            FROM tools t
            JOIN tool_versions tv ON t.id = tv.tool_id AND tv.is_active = 1
            WHERE t.id = ?
        """, [req.tool_id])
    
    if not tool:
        raise HTTPException(status_code=404, detail="Tool not found")
    
    # 生成 ticket
    ticket_id = f"tkt_{secrets.token_urlsafe(16)}"
    
    if req.gate_type == "ad":
        # 看广告（MVP 阶段模拟成功）
        settlement_type = "ad_watched"
        credits_cost = 0
    elif req.gate_type == "paid":
        # 付费（扣除积分或记录订单）
        settlement_type = "credits_paid"
        credits_cost = tool["pricing_amount"] or 0
        
        # 检查积分余额（如果已登录）
        if user_id:
            async with db.connect() as conn:
                user = await conn.fetch_one(
                    "SELECT credits_balance FROM users WHERE id = ?",
                    [user_id]
                )
            if user and user["credits_balance"] < credits_cost:
                raise HTTPException(status_code=402, detail="Insufficient credits")
    else:
        raise HTTPException(status_code=400, detail="Invalid gate_type")
    
    # 创建 ticket 记录
    async with db.connect() as conn:
        await conn.execute("""
            INSERT INTO tool_tickets 
            (ticket_id, tool_id, user_id, settlement_type, credits_cost, status, created_at)
            VALUES (?, ?, ?, ?, ?, 'pending', CURRENT_TIMESTAMP)
        """, [ticket_id, req.tool_id, user_id, settlement_type, credits_cost])
        await conn.commit()
    
    # 如果是付费，扣除积分
    if req.gate_type == "paid" and user_id and credits_cost > 0:
        await db.add_transaction(
            user_id=user_id,
            type="tool_usage",
            delta=-credits_cost,
            note=f"使用工具: {tool['display_name']}",
            model_name=f"tool_{req.tool_id}",
        )
    
    return {
        "ticket_id": ticket_id,
        "tool_id": req.tool_id,
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
    启动任务执行
    - 验证 ticket
    - 根据 dispatch_type 分发任务
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
