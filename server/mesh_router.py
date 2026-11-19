"""设备网络：签发设备证书、地址簿、吊销列表。

内容不经过这里：设备之间直连（打不通时走 TokenBank 中继，中继只转发加密的包）。
云端只管谁是谁（证书）、去哪找（地址簿）、谁被踢了（吊销）。
"""

from __future__ import annotations

import ipaddress
import json
import logging
import os
import time

from fastapi import APIRouter, Depends, HTTPException, Request
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
        # 云端回拨验证过、从外面真的连得到的地址（能当中继的前提）
        await db.execute("ALTER TABLE mesh_endpoints ADD COLUMN IF NOT EXISTS verified_addrs TEXT")
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
    }


# ── 地址簿 ────────────────────────────────────────────────────────────────────

class AddressRequest(BaseModel):
    device_id: str
    endpoint_id: str
    relay_url: str = ""
    direct_addrs: list[str] = Field(default_factory=list)


def _split_addr(addr: str):
    """'1.2.3.4:41750' / '[2408::1]:41750' → (host, port)；不合法返回 None"""
    a = str(addr or "").strip()
    try:
        if a.startswith("["):
            host, _, port = a[1:].partition("]:")
        else:
            host, _, port = a.rpartition(":")
        ip = ipaddress.ip_address(host)
        return ip, int(port)
    except ValueError:
        return None


def _public(ip) -> bool:
    """云端只回拨公网地址：局域网、运营商 NAT（100.64/10，Tailscale 也在这里）、回环、链路本地都跳过"""
    if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_multicast or ip.is_unspecified or ip.is_reserved:
        return False
    if ip.version == 4 and ip in ipaddress.ip_network("100.64.0.0/10"):
        return False
    return True


async def _dial_back(addrs: list[str], endpoint_id: str) -> list[str]:
    """逐个公网地址连一次 http://<地址>/mesh/ping，回的 endpoint_id 对得上才算「从外面连得到」"""
    import httpx
    ok = []
    async with httpx.AsyncClient(timeout=3.0, trust_env=False) as client:
        for a in addrs:
            hp = _split_addr(a)
            if not hp or not _public(hp[0]):
                continue
            host = f"[{hp[0]}]" if hp[0].version == 6 else str(hp[0])
            try:
                r = await client.get(f"http://{host}:{hp[1]}/mesh/ping")
                if r.status_code == 200 and str(r.json().get("endpoint_id", "")).lower() == endpoint_id:
                    ok.append(a)
            except Exception:
                continue
    return ok


@router.post("/mesh/address")
async def publish_address(req: AddressRequest, request: Request, uid: int = Depends(get_current_user_id)):
    """设备每分钟报一次自己在哪；云端回拨验证哪些地址从外面连得到，并告诉设备它的出口 IP"""
    await ensure_tables()
    endpoint_id = req.endpoint_id.strip().lower()
    addrs = _clean_addrs(req.direct_addrs)
    verified = await _dial_back(addrs, endpoint_id) if os.environ.get("MESH_DIAL_BACK", "1") != "0" else []
    async with connect() as db:
        cur = await db.execute(
            """UPDATE mesh_endpoints SET relay_url=?, direct_addrs=?, verified_addrs=?, updated_at=?
               WHERE device_id=? AND user_id=? AND endpoint_id=?""",
            (req.relay_url.strip()[:200] or None, json.dumps(addrs), json.dumps(verified), int(time.time()),
             req.device_id.strip(), uid, endpoint_id),
        )
        await db.commit()
    if getattr(cur, "rowcount", 1) == 0:
        raise HTTPException(404, "这台设备还没领证书")
    observed = request.headers.get("x-real-ip") or (request.client.host if request.client else "")
    return {"ok": True, "verified": verified, "observed_ip": observed}


@router.get("/mesh/revoked-endpoints")
async def revoked_endpoints(request: Request):
    """给官方中继用：被吊销的设备密钥和签发方公钥（带 MESH_RELAY_ACCESS_TOKEN）"""
    want = os.environ.get("MESH_RELAY_ACCESS_TOKEN", "")
    if not want or request.headers.get("authorization", "") != f"Bearer {want}":
        raise HTTPException(401, "unauthorized")
    await ensure_tables()
    async with connect() as db:
        async with db.execute("SELECT endpoint_id FROM mesh_revocations ORDER BY revoked_at DESC LIMIT 100000") as cur:
            rows = await cur.fetchall()
    return {"endpoints": [r[0] for r in rows], "issuer_keys": mesh_cert.issuer_keys(issuer())}


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
