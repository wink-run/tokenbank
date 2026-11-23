"""官方中继，内置在后端里：同一个端口上的 /mesh/ws，不用另起服务、不用配令牌。

协议和每个 app 里的中继（client/electron/mesh/relay.js）完全一样：
  中继 → {type:'challenge', nonce, kind:'official', device_id:null}
  设备 → {type:'register', proto:1, cert, sig}        sig = 设备密钥签 `tb-mesh-register|<nonce>`
  中继 → {type:'registered', kind:'official', device_id:null, relay:true} | {type:'error', message}
  设备 → {type:'relay', to, data}                      同账号：转给那台 {type:'relay', from, data}
  设备 → {type:'relay', to, to_user, ticket, data}     跨账号：只凭云端签的雇佣票，转过去带 from_user
  中继 → peers / peer_offline / relay_status，双向 ping / pong
data 是两台设备之间端到端加密的内容，中继不解开。

签发公钥和吊销列表在进程里直接拿，不用像独立中继那样去拉。
只适合单进程（uvicorn 一个 worker）；要多实例时改用独立的 mesh-relay（client/electron/mesh/relay-server.js）。
MESH_BUILTIN_RELAY=0 关掉。
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import secrets
import time
from typing import Optional

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

import mesh_cert
from mesh_router import _verify_device_sig, ensure_tables, issuer
from pg_compat import connect

logger = logging.getLogger("server")
router = APIRouter()

REGISTER_TIMEOUT_SEC = 10
STATUS_SEC = 10
PAIR_TTL_SEC = 60
REVOKED_TTL_SEC = 60
MAX_PER_USER = int(os.getenv("MESH_RELAY_MAX_PER_USER", "20"))


def enabled() -> bool:
    return os.environ.get("MESH_BUILTIN_RELAY", "1") != "0"


class _Conn:
    __slots__ = ("ws", "user", "device", "endpoint", "name", "lock")

    def __init__(self, ws: WebSocket):
        self.ws = ws
        self.user = ""
        self.device = ""
        self.endpoint = ""
        self.name = ""
        self.lock = asyncio.Lock()

    async def send(self, obj: dict) -> bool:
        try:
            async with self.lock:
                await self.ws.send_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")))
            return True
        except Exception:
            return False


_conns: dict[tuple[str, str], _Conn] = {}
_pairs: dict[tuple[str, str, str], dict] = {}
_grants: dict[str, int] = {}
_revoked: set = set()
_revoked_at = 0.0
_status_task: Optional[asyncio.Task] = None


async def _revoked_set() -> set:
    global _revoked, _revoked_at
    if time.time() - _revoked_at > REVOKED_TTL_SEC:
        try:
            await ensure_tables()
            async with connect() as db:
                async with db.execute("SELECT endpoint_id FROM mesh_revocations") as cur:
                    _revoked = {r[0] for r in await cur.fetchall()}
            _revoked_at = time.time()
        except Exception:
            logger.exception("[mesh_relay] load revocations failed")
    return _revoked


def _issuer_keys() -> list:
    return mesh_cert.issuer_keys(issuer())


def _connected(user: str) -> list:
    return [{"device_id": c.device, "name": c.name} for (u, _), c in _conns.items() if u == user]


async def _announce(user: str) -> None:
    devices = _connected(user)
    for (u, d), c in list(_conns.items()):
        if u == user:
            await c.send({"type": "peers", "devices": [x for x in devices if x["device_id"] != d]})


def _status(user: str) -> dict:
    now = time.time()
    pairs = []
    for k, p in list(_pairs.items()):
        if now - p["at"] > PAIR_TTL_SEC:
            _pairs.pop(k, None)
        elif k[0] == user:
            pairs.append({"a": k[1], "b": k[2], "bytes": p["bytes"]})
    return {"kind": "official", "relay_device": None, "pairs": pairs}


async def _status_loop() -> None:
    while True:
        await asyncio.sleep(STATUS_SEC)
        for user in {u for (u, _) in list(_conns)}:
            s = _status(user)
            for (u, _), c in list(_conns.items()):
                if u == user:
                    await c.send({"type": "relay_status", **s})


def _dump(data) -> None:
    path = os.environ.get("MESH_RELAY_DUMP")
    if path:
        try:
            with open(path, "a", encoding="utf-8") as f:
                f.write(json.dumps(data, ensure_ascii=False) + "\n")
        except OSError:
            pass


async def _hire_allowed(src: _Conn, dst: _Conn, ticket) -> bool:
    """跨账号：已有没过期的放行，或者这条带的雇佣票正好写着这两台"""
    now = int(time.time())
    key = lambda a, b: f"{a.user}:{a.device}>{b.user}:{b.device}"  # noqa: E731
    exp = _grants.get(key(src, dst))
    if exp and exp > now:
        return True
    if not ticket:
        return False
    c = mesh_cert.verify_hire_ticket(ticket, _issuer_keys(), now)
    if not c:
        return False
    revoked = await _revoked_set()
    ok = (str(c["sub"]) == src.user and str(c["hd"]) == src.device and str(c["he"]) == src.endpoint
          and str(c["wu"]) == dst.user and str(c["wd"]) == dst.device and str(c["we"]) == dst.endpoint
          and c["he"] not in revoked and c["we"] not in revoked)
    if not ok:
        return False
    _grants[key(src, dst)] = c["exp"]
    _grants[key(dst, src)] = c["exp"]
    if len(_grants) > 10000:
        for k, e in list(_grants.items()):
            if e <= now:
                _grants.pop(k, None)
    return True


async def _register(conn: _Conn, msg: dict, nonce: str) -> Optional[str]:
    """通过返回 None，不通过返回原因"""
    if msg.get("type") != "register":
        return "先注册"
    c = mesh_cert.verify_cert(msg.get("cert"), _issuer_keys())
    if not c:
        return "证书无效"
    if c.get("scope") != "self":
        return "unknown_scope"
    if c.get("endpoint_id") in await _revoked_set():
        return "revoked"
    if not _verify_device_sig(str(c.get("endpoint_id") or ""), f"tb-mesh-register|{nonce}", str(msg.get("sig") or "")):
        return "bad_signature"
    user = str(c["sub"])
    if sum(1 for (u, _) in _conns if u == user) >= MAX_PER_USER and (user, str(c["device_id"])) not in _conns:
        return "too_many_devices"
    conn.user, conn.device, conn.endpoint, conn.name = user, str(c["device_id"]), str(c["endpoint_id"]), str(c.get("name") or "")
    return None


async def _on_message(conn: _Conn, msg: dict, size: int) -> None:
    kind = msg.get("type")
    if kind == "ping":
        await conn.send({"type": "pong", "t": msg.get("t")})
        return
    if kind != "relay":
        return
    to = str(msg.get("to") or "")
    to_user = str(msg.get("to_user") or conn.user)
    target = _conns.get((to_user, to))
    if to_user != conn.user:
        if not target or not await _hire_allowed(conn, target, msg.get("ticket")):
            await conn.send({"type": "peer_offline", "to": to, "to_user": to_user})
            return
        _dump(msg.get("data"))
        await target.send({"type": "relay", "from": conn.device, "from_user": conn.user, "data": msg.get("data")})
        return
    if not target:
        await conn.send({"type": "peer_offline", "to": to})
        return
    _dump(msg.get("data"))
    await target.send({"type": "relay", "from": conn.device, "data": msg.get("data")})
    a, b = sorted([conn.device, to])
    p = _pairs.setdefault((conn.user, a, b), {"bytes": 0})
    p["at"] = time.time()
    p["bytes"] += size


@router.websocket("/mesh/ws")
async def mesh_ws(ws: WebSocket):
    global _status_task
    if not enabled():
        await ws.close(code=4004)
        return
    await ws.accept()
    if _status_task is None or _status_task.done():
        _status_task = asyncio.create_task(_status_loop())
    conn = _Conn(ws)
    nonce = secrets.token_hex(16)
    await conn.send({"type": "challenge", "nonce": nonce, "kind": "official", "device_id": None})
    registered = False
    try:
        raw = await asyncio.wait_for(ws.receive_text(), REGISTER_TIMEOUT_SEC)
        try:
            msg = json.loads(raw)
        except ValueError:
            msg = {}
        why = await _register(conn, msg if isinstance(msg, dict) else {}, nonce)
        if why:
            logger.info("[mesh_relay] 拒绝 %s 接入：%s", ws.client.host if ws.client else "?", why)
            await conn.send({"type": "error", "message": why})
            await ws.close(code=4003)
            return
        old = _conns.get((conn.user, conn.device))
        if old is not None:
            try:
                await old.ws.close(code=4000)
            except Exception:
                pass
        _conns[(conn.user, conn.device)] = conn
        registered = True
        await conn.send({"type": "registered", "kind": "official", "device_id": None, "relay": True})
        await _announce(conn.user)
        while True:
            raw = await ws.receive_text()
            try:
                msg = json.loads(raw)
            except ValueError:
                continue
            if isinstance(msg, dict):
                await _on_message(conn, msg, len(raw))
    except (WebSocketDisconnect, asyncio.TimeoutError, RuntimeError):
        pass
    finally:
        if registered and _conns.get((conn.user, conn.device)) is conn:
            _conns.pop((conn.user, conn.device), None)
            await _announce(conn.user)


@router.get("/mesh/relay/healthz")
async def relay_health():
    return {"ok": True, "edition": "builtin", "enabled": enabled(), "devices": len(_conns), "issuer_keys": len(_issuer_keys())}


def own_relay_url(request) -> str:
    """没配 MESH_RELAY_URLS 时，按这次请求的域名算出内置中继的地址（经 nginx 时认 X-Forwarded-Proto）"""
    proto = (request.headers.get("x-forwarded-proto") or request.url.scheme or "http").split(",")[0].strip()
    host = (request.headers.get("x-forwarded-host") or request.headers.get("host") or "").split(",")[0].strip()
    if not host:
        return ""
    return f"{'wss' if proto == 'https' else 'ws'}://{host}/mesh/ws"
