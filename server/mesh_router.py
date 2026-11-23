"""设备网络：签发设备证书、地址簿、吊销列表。

内容不经过这里：设备之间直连（打不通时走 TokenBank 中继，中继只转发加密的包）。
云端只管谁是谁（证书）、去哪找（地址簿）、谁被踢了（吊销）。
"""

from __future__ import annotations

import base64
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
        # 新设备入网要一台已入网的设备批准（账号的第一台自动通过）
        await db.execute("""
            CREATE TABLE IF NOT EXISTS mesh_approvals (
                device_id    TEXT PRIMARY KEY,
                user_id      INTEGER NOT NULL,
                endpoint_id  TEXT NOT NULL,
                name         TEXT,
                status       TEXT NOT NULL,
                requested_at BIGINT NOT NULL,
                decided_at   BIGINT,
                decided_by   TEXT
            )
        """)
        await db.execute("CREATE INDEX IF NOT EXISTS idx_mesh_approvals_user ON mesh_approvals(user_id)")
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
        await db.execute("DELETE FROM mesh_approvals WHERE device_id=? AND user_id=?", (device_id, user_id))
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
        if not old and not await _approved(db, uid, device_id, endpoint_id, req.name.strip() or (db_name or "")):
            await db.commit()
            raise HTTPException(403, {"code": "approval_pending", "message": "等我已入网的设备批准"})
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


# ── 新设备批准 ────────────────────────────────────────────────────────────────

def _approval_required() -> bool:
    return os.environ.get("MESH_REQUIRE_APPROVAL", "1") != "0"


async def _approved(db, uid: int, device_id: str, endpoint_id: str, name: str) -> bool:
    """这台能不能领证书：批准过；或者账号下还没有已入网的设备（第一台）；或者关了批准。没批准的记成待批准"""
    async with db.execute("SELECT status FROM mesh_approvals WHERE device_id=? AND user_id=?", (device_id, uid)) as cur:
        row = await cur.fetchone()
    if row and row[0] == "approved":
        return True
    async with db.execute("SELECT COUNT(*) FROM mesh_endpoints WHERE user_id=?", (uid,)) as cur:
        joined = (await cur.fetchone())[0]
    now = int(time.time())
    if joined == 0 or not _approval_required():
        await db.execute(
            """INSERT INTO mesh_approvals (device_id, user_id, endpoint_id, name, status, requested_at, decided_at, decided_by)
               VALUES (?, ?, ?, ?, 'approved', ?, ?, ?)
               ON CONFLICT (device_id) DO UPDATE SET status='approved', endpoint_id=excluded.endpoint_id, decided_at=excluded.decided_at""",
            (device_id, uid, endpoint_id, name, now, now, "first" if joined == 0 else "auto"),
        )
        return True
    await db.execute(
        """INSERT INTO mesh_approvals (device_id, user_id, endpoint_id, name, status, requested_at)
           VALUES (?, ?, ?, ?, 'pending', ?)
           ON CONFLICT (device_id) DO UPDATE SET endpoint_id=excluded.endpoint_id, name=excluded.name,
             requested_at=excluded.requested_at, status='pending'""",
        (device_id, uid, endpoint_id, name, now),
    )
    return False


def _verify_device_sig(endpoint_id: str, text: str, sig: str) -> bool:
    from cryptography.exceptions import InvalidSignature
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
    try:
        pub = Ed25519PublicKey.from_public_bytes(bytes.fromhex(endpoint_id))
        pub.verify(base64.urlsafe_b64decode(sig + "=" * (-len(sig) % 4)), text.encode())
        return True
    except (InvalidSignature, ValueError):
        return False


@router.get("/mesh/pending")
async def list_pending(uid: int = Depends(get_current_user_id)):
    """等批准的新设备"""
    await ensure_tables()
    async with connect() as db:
        async with db.execute(
            "SELECT device_id, endpoint_id, name, requested_at FROM mesh_approvals WHERE user_id=? AND status='pending' ORDER BY requested_at",
            (uid,),
        ) as cur:
            rows = await cur.fetchall()
    return {"pending": [{"device_id": r[0], "endpoint_id": r[1], "name": r[2] or "", "requested_at": r[3]} for r in rows]}


class DecisionRequest(BaseModel):
    device_id: str                 # 要批准 / 拒绝的新设备
    approver_device_id: str        # 已入网、做决定的这台
    approve: bool = True
    sig: str                       # 做决定的设备用设备密钥签 `tb-mesh-approve|<新设备>|<新设备的 endpoint_id>|<approve|reject>`


@router.post("/mesh/approve")
async def decide(req: DecisionRequest, uid: int = Depends(get_current_user_id)):
    """已入网的设备批准或拒绝新设备。要那台设备的签名：只有登录令牌（比如密码泄露）加不了设备"""
    await ensure_tables()
    async with connect() as db:
        async with db.execute(
            "SELECT endpoint_id FROM mesh_endpoints WHERE device_id=? AND user_id=?", (req.approver_device_id, uid)
        ) as cur:
            approver = await cur.fetchone()
        if not approver:
            raise HTTPException(403, "只有已入网的设备能批准")
        async with db.execute(
            "SELECT endpoint_id FROM mesh_approvals WHERE device_id=? AND user_id=? AND status='pending'", (req.device_id, uid)
        ) as cur:
            pending = await cur.fetchone()
        if not pending:
            raise HTTPException(404, "没有这台等批准的设备")
        verb = "approve" if req.approve else "reject"
        if not _verify_device_sig(approver[0], f"tb-mesh-approve|{req.device_id}|{pending[0]}|{verb}", req.sig):
            raise HTTPException(403, "签名不对")
        if req.approve:
            await db.execute(
                "UPDATE mesh_approvals SET status='approved', decided_at=?, decided_by=? WHERE device_id=? AND user_id=?",
                (int(time.time()), req.approver_device_id, req.device_id, uid),
            )
        else:
            await db.execute("DELETE FROM mesh_approvals WHERE device_id=? AND user_id=?", (req.device_id, uid))
        await db.commit()
    return {"ok": True, "device_id": req.device_id, "approved": req.approve}


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
    """同时回拨每个公网地址的 http://<地址>/mesh/ping，回的 endpoint_id 对得上才算「从外面连得到」。
    一台电脑常有好几个公网 IPv6 地址：并发、最多 8 个、每个 2 秒，整体 3 秒内一定返回，不拖慢设备的同步"""
    import asyncio
    import httpx
    targets = []
    for a in addrs:
        hp = _split_addr(a)
        if hp and _public(hp[0]):
            targets.append((a, f"[{hp[0]}]" if hp[0].version == 6 else str(hp[0]), hp[1]))
    targets = targets[:8]
    if not targets:
        return []
    async with httpx.AsyncClient(timeout=2.0, trust_env=False) as client:
        async def one(a, host, port):
            try:
                r = await client.get(f"http://{host}:{port}/mesh/ping")
                return a if r.status_code == 200 and str(r.json().get("endpoint_id", "")).lower() == endpoint_id else None
            except Exception:
                return None
        try:
            got = await asyncio.wait_for(asyncio.gather(*(one(*t) for t in targets)), timeout=3.0)
        except asyncio.TimeoutError:
            return []
    return [a for a in got if a]


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
