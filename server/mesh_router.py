"""设备网络：签发设备证书、地址簿、吊销列表、中继放行。

内容不经过这里：设备之间直连（打不通时走 TokenBank 中继，中继只转发加密的包）。
云端只管谁是谁（证书）、去哪找（地址簿）、谁被踢了（吊销）。
"""

from __future__ import annotations

import json
import logging
import os
import time

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel, Field

import mesh_cert
from auth import get_current_user_id
from pg_compat import connect

logger = logging.getLogger(__name__)
router = APIRouter()

_issuer: mesh_cert.Issuer | None = None
_tables_ready = False


def issuer() -> mesh_cert.Issuer:
    global _issuer
    if _issuer is None:
        _issuer = mesh_cert.load_issuer()
    return _issuer


async def ensure_tables() -> None:
    global _tables_ready
    if _tables_ready:
        return
    async with connect() as db:
        await db.execute("""
            CREATE TABLE IF NOT EXISTS mesh_endpoints (
                device_id    TEXT PRIMARY KEY,
                user_id      INTEGER NOT NULL,
                endpoint_id  TEXT NOT NULL,
                relay_url    TEXT,
                direct_addrs TEXT,
                cert_exp     BIGINT NOT NULL DEFAULT 0,
                updated_at   BIGINT NOT NULL DEFAULT 0
            )
        """)
        await db.execute("CREATE INDEX IF NOT EXISTS idx_mesh_endpoints_user ON mesh_endpoints(user_id)")
        await db.execute("CREATE INDEX IF NOT EXISTS idx_mesh_endpoints_endpoint ON mesh_endpoints(endpoint_id)")
        await db.execute("""
            CREATE TABLE IF NOT EXISTS mesh_revocations (
                endpoint_id TEXT PRIMARY KEY,
                device_id   TEXT NOT NULL,
                user_id     INTEGER NOT NULL,
                revoked_at  BIGINT NOT NULL
            )
        """)
        await db.execute("CREATE INDEX IF NOT EXISTS idx_mesh_revocations_user ON mesh_revocations(user_id)")
        await db.commit()
    _tables_ready = True


async def _device_owner(device_id: str):
    async with connect() as db:
        async with db.execute("SELECT user_id, name FROM devices WHERE id=?", (device_id,)) as cur:
            row = await cur.fetchone()
    return (row[0], row[1]) if row else (None, None)


async def _revoke(db, *, user_id: int, device_id: str, endpoint_id: str) -> None:
    await db.execute(
        """INSERT INTO mesh_revocations (endpoint_id, device_id, user_id, revoked_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (endpoint_id) DO NOTHING""",
        (endpoint_id, device_id, user_id, int(time.time())),
    )


async def revoke_device(device_id: str, user_id: int) -> None:
    """删除设备时调用：它的证书作废，其他设备下一次拉吊销列表后拒绝它"""
    await ensure_tables()
    async with connect() as db:
        async with db.execute(
            "SELECT endpoint_id FROM mesh_endpoints WHERE device_id=? AND user_id=?", (device_id, user_id)
        ) as cur:
            row = await cur.fetchone()
        if row:
            await _revoke(db, user_id=user_id, device_id=device_id, endpoint_id=row[0])
            await db.execute("DELETE FROM mesh_endpoints WHERE device_id=? AND user_id=?", (device_id, user_id))
        await db.commit()


def _clean_addrs(addrs) -> list[str]:
    out = []
    for a in addrs or []:
        s = str(a or "").strip()
        if s and len(s) <= 64 and ":" in s:
            out.append(s)
    return out[:16]


# ── 证书 ──────────────────────────────────────────────────────────────────────

class CertRequest(BaseModel):
    device_id: str
    endpoint_id: str
    name: str = ""


@router.post("/mesh/cert")
async def request_cert(req: CertRequest, uid: int = Depends(get_current_user_id)):
    """登录后的设备来领证书。设备要先注册（/device/register）。换了密钥（重装）时旧的那把自动吊销"""
    await ensure_tables()
    device_id = req.device_id.strip()
    endpoint_id = req.endpoint_id.strip().lower()
    owner, db_name = await _device_owner(device_id)
    if owner != uid:
        raise HTTPException(404, "设备没有注册，或不属于这个账号")
    if not mesh_cert.ENDPOINT_ID_RE.match(endpoint_id):
        raise HTTPException(400, "endpoint_id 不对")
    async with connect() as db:
        async with db.execute("SELECT 1 FROM mesh_revocations WHERE endpoint_id=?", (endpoint_id,)) as cur:
            if await cur.fetchone():
                raise HTTPException(403, "这把设备密钥已经吊销，请在设备上重置设备网络")
        async with db.execute(
            "SELECT endpoint_id, user_id FROM mesh_endpoints WHERE device_id=?", (device_id,)
        ) as cur:
            old = await cur.fetchone()
        if old and old[0] != endpoint_id:
            await _revoke(db, user_id=uid, device_id=device_id, endpoint_id=old[0])
        # 同一把密钥只能属于一台设备
        async with db.execute(
            "SELECT device_id FROM mesh_endpoints WHERE endpoint_id=? AND device_id<>?", (endpoint_id, device_id)
        ) as cur:
            if await cur.fetchone():
                raise HTTPException(409, "这把设备密钥已经被另一台设备用了")
        cert, exp = mesh_cert.issue_cert(issuer(), user_id=uid, device_id=device_id, endpoint_id=endpoint_id,
                                         name=req.name.strip() or (db_name or ""))
        await db.execute(
            """INSERT INTO mesh_endpoints (device_id, user_id, endpoint_id, cert_exp, updated_at)
               VALUES (?, ?, ?, ?, ?)
               ON CONFLICT (device_id) DO UPDATE SET user_id=excluded.user_id, endpoint_id=excluded.endpoint_id,
                 cert_exp=excluded.cert_exp, updated_at=excluded.updated_at""",
            (device_id, uid, endpoint_id, exp, int(time.time())),
        )
        await db.commit()
    iss = issuer()
    return {
        "cert": cert,
        "expires_at": exp,
        "user_id": str(uid),
        "issuer_keys": mesh_cert.issuer_keys(iss),
        "relay_urls": mesh_cert.relay_urls(),
        "relay_token": mesh_cert.relay_token(uid, iss) if mesh_cert.relay_urls() else None,
    }


# ── 地址簿 ────────────────────────────────────────────────────────────────────

class AddressRequest(BaseModel):
    device_id: str
    endpoint_id: str
    relay_url: str = ""
    direct_addrs: list[str] = Field(default_factory=list)


@router.post("/mesh/address")
async def publish_address(req: AddressRequest, uid: int = Depends(get_current_user_id)):
    """设备每分钟报一次自己在哪（中继地址、直连地址），其他设备按这个找它"""
    await ensure_tables()
    async with connect() as db:
        cur = await db.execute(
            """UPDATE mesh_endpoints SET relay_url=?, direct_addrs=?, updated_at=?
               WHERE device_id=? AND user_id=? AND endpoint_id=?""",
            (req.relay_url.strip()[:200] or None, json.dumps(_clean_addrs(req.direct_addrs)), int(time.time()),
             req.device_id.strip(), uid, req.endpoint_id.strip().lower()),
        )
        await db.commit()
    if getattr(cur, "rowcount", 1) == 0:
        raise HTTPException(404, "这台设备还没领证书")
    return {"ok": True}


@router.get("/mesh/peers")
async def list_peers(uid: int = Depends(get_current_user_id)):
    """本账号所有入网设备（不含已吊销的）。地址超过 10 分钟没更新的不给直连地址，免得白拨"""
    await ensure_tables()
    now = int(time.time())
    async with connect() as db:
        async with db.execute(
            """SELECT m.device_id, m.endpoint_id, m.relay_url, m.direct_addrs, m.updated_at, m.cert_exp,
                      d.name, d.online, d.last_seen
               FROM mesh_endpoints m JOIN devices d ON d.id = m.device_id
               WHERE m.user_id=? AND m.cert_exp > ?
                 AND NOT EXISTS (SELECT 1 FROM mesh_revocations r WHERE r.endpoint_id = m.endpoint_id)""",
            (uid, now),
        ) as cur:
            rows = await cur.fetchall()
    peers = []
    for r in rows:
        fresh = now - int(r[4] or 0) < 600
        try:
            addrs = json.loads(r[3] or "[]") if fresh else []
        except json.JSONDecodeError:
            addrs = []
        peers.append({
            "device_id": r[0], "endpoint_id": r[1], "relay_url": r[2] or None, "direct_addrs": addrs,
            "name": r[6] or "", "online": bool(r[7]), "last_seen": r[8], "address_updated_at": int(r[4] or 0),
        })
    return {"peers": peers}


@router.get("/mesh/revocations")
async def list_revocations(uid: int = Depends(get_current_user_id)):
    await ensure_tables()
    async with connect() as db:
        async with db.execute(
            "SELECT endpoint_id, device_id, revoked_at FROM mesh_revocations WHERE user_id=? ORDER BY revoked_at DESC LIMIT 500",
            (uid,),
        ) as cur:
            rows = await cur.fetchall()
    return {"revoked": [{"endpoint_id": r[0], "device_id": r[1], "revoked_at": r[2]} for r in rows]}


# ── 中继放行 ──────────────────────────────────────────────────────────────────

def _relay_endpoint_id(request: Request, body: dict) -> str:
    for h in ("x-iroh-endpoint-id", "x-iroh-node-id", "x-iroh-nodeid"):
        v = request.headers.get(h)
        if v:
            return v.strip().lower()
    return str(body.get("endpoint_id") or body.get("node_id") or request.query_params.get("endpoint_id") or "").strip().lower()


@router.post("/mesh/relay-access")
async def relay_access(request: Request):
    """iroh-relay 的 HTTP 放行回调：只放行持有效证书、没被吊销的设备。

    由中继服务带 MESH_RELAY_ACCESS_TOKEN 调用；回 "true" 放行、"false" 拒绝。
    """
    want = os.environ.get("MESH_RELAY_ACCESS_TOKEN", "")
    got = request.headers.get("authorization", "")
    if not want or got != f"Bearer {want}":
        return PlainTextResponse("false", status_code=401)
    try:
        body = await request.json()
        if not isinstance(body, dict):
            body = {}
    except Exception:
        body = {}
    endpoint_id = _relay_endpoint_id(request, body)
    if not mesh_cert.ENDPOINT_ID_RE.match(endpoint_id):
        return PlainTextResponse("false", status_code=403)
    await ensure_tables()
    async with connect() as db:
        async with db.execute(
            """SELECT 1 FROM mesh_endpoints m WHERE m.endpoint_id=? AND m.cert_exp > ?
                 AND NOT EXISTS (SELECT 1 FROM mesh_revocations r WHERE r.endpoint_id = m.endpoint_id)""",
            (endpoint_id, int(time.time())),
        ) as cur:
            ok = await cur.fetchone()
    return PlainTextResponse("true" if ok else "false", status_code=200 if ok else 403)
