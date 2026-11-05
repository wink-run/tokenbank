"""设备注册、心跳、列表、删除"""

import secrets

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

import database as db
from auth import get_current_user_id

router = APIRouter()


class RegisterRequest(BaseModel):
    type: str = "desktop"
    name: str = ""
    platform: str = ""
    version: str = ""
    gateway_port: int = 11430
    device_id: str = ""


class HeartbeatRequest(BaseModel):
    device_id: str
    online: bool = True
    stats: dict = Field(default_factory=dict)
    # 客户端升级后心跳可刷新设备元数据，避免 DB 长期滞留旧版本/错误 type
    version: str = ""
    name: str = ""
    platform: str = ""
    type: str = ""


@router.post("/device/register")
async def register_device(req: RegisterRequest, uid: int = Depends(get_current_user_id)):
    device_id = req.device_id.strip()
    if device_id:
        # 仅当 ID 已归属其他用户时丢弃；新 ID（库中不存在）允许客户端预生成
        owner_id = await db.get_device_owner(device_id)
        if owner_id is not None and owner_id != uid:
            device_id = ""
    if not device_id:
        device_id = "dev-" + secrets.token_hex(8)
    # 同一台机器重复注册时复用已有记录，避免 Docker 重建后再插一行
    same = await db.find_device_by_identity(uid, req.name, req.platform)
    if same:
        device_id = same
    row = await db.upsert_device(
        device_id=device_id,
        user_id=uid,
        type_=req.type,
        name=req.name,
        platform=req.platform,
        version=req.version,
        gateway_port=req.gateway_port,
    )
    return row


@router.post("/device/heartbeat")
async def device_heartbeat(req: HeartbeatRequest, uid: int = Depends(get_current_user_id)):
    # verify device belongs to this user
    owner_id = await db.get_device_owner(req.device_id)
    if owner_id != uid:
        raise HTTPException(404, "Device not found")
    stats = req.stats or {}
    inventory = stats.get("inventory")
    if isinstance(inventory, dict) and not inventory:
        inventory = None
    await db.record_device_heartbeat(
        device_id=req.device_id,
        user_id=uid,
        online=req.online,
        calls=int(stats.get("calls", 0)),
        errors=int(stats.get("errors", 0)),
        providers=int(stats.get("providers_active", 0)),
        inventory=inventory,
        version=req.version.strip(),
        name=req.name.strip(),
        platform=req.platform.strip(),
        type_=req.type.strip(),
    )
    return {"ok": True}


@router.get("/user/devices")
async def list_devices(uid: int = Depends(get_current_user_id)):
    devices = await db.get_user_devices(uid)
    return {"devices": devices}


@router.delete("/device/{device_id}")
async def remove_device(device_id: str, uid: int = Depends(get_current_user_id)):
    await db.delete_device(device_id, uid)
    return {"ok": True}
