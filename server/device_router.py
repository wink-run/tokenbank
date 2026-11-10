"""设备注册、心跳、列表、删除"""

import secrets

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

import database as db
from auth import get_current_user_id
from device_assets import devices_with_assets

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
    sent = req.device_id.strip()
    device_id = sent
    owner_id = await db.get_device_owner(device_id) if device_id else None
    if owner_id is not None and owner_id != uid:
        # 这个 id 是别人的，本机另外生成，不能并到对方那条记录上
        device_id = ""
        owner_id = None
    # Docker 每次重建本地文件会丢，带上来的是新 id。同名 CLI 复用已有的那条。
    # 桌面版仍保留客户端自己的 id，避免两台都叫「桌面设备」的 Mac 被并成一台。
    owned_by_user = owner_id == uid
    same_cli = None
    if (req.type or "").strip() == "cli" and not db.is_placeholder_device_name(req.name):
        same_cli = await db.find_device_by_identity(uid, req.name, req.platform, type_="cli")
    reused = db.reuse_cli_device_id(owned_by_user, same_cli, req.type, req.name)
    if reused:
        device_id = reused
    if not device_id:
        device_id = "dev-" + secrets.token_hex(8)
    # 没带 id 的旧客户端才按名字复用。带了 id 的桌面版不能换回旧记录。
    if not sent and not db.is_placeholder_device_name(req.name):
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
    if (req.type or "").strip() == "cli":
        await db.delete_cli_device_duplicates(uid, device_id, req.name, req.platform)
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


@router.get("/user/devices/assets")
async def list_device_assets(uid: int = Depends(get_current_user_id)):
    """各设备上报的资产清单（只有名字、来源和内容摘要），客户端据此提醒设备之间不一致。"""
    rows = await db.get_user_devices_inventory(uid)
    return {"devices": devices_with_assets(rows)}


@router.delete("/device/{device_id}")
async def remove_device(device_id: str, uid: int = Depends(get_current_user_id)):
    await db.delete_device(device_id, uid)
    return {"ok": True}
