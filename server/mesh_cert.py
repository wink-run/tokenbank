"""设备网络证书：云端签发，设备之间离线互相校验。

格式和客户端 client/electron/mesh/identity.js 完全一致（Ed25519 签名的紧凑 JWS，typ=tokenbank-mesh-cert），
客户端用内置 / 下发的签发方公钥校验，不需要再问云端。

签发方密钥：
- 环境变量 MESH_ISSUER_KEY（32 字节种子的 hex）优先，多台服务端实例要配同一把；
- 没配时用 data/mesh_issuer.key，第一次用时生成（只适合单实例）。
轮换：新钥匙签发，旧公钥放进 MESH_ISSUER_OLD_KEYS（逗号分隔的 kid:x）继续下发，旧证书到期前仍能校验。
"""

from __future__ import annotations

import base64
import json
import os
import re
import time
from pathlib import Path

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

CERT_TYP = "tokenbank-mesh-cert"
ISSUER = "tokenbank"
DEFAULT_TTL_SEC = 30 * 86400
KEY_FILE = Path(__file__).resolve().parent / "data" / "mesh_issuer.key"

# iroh 的 endpoint id 是 32 字节公钥的 hex
ENDPOINT_ID_RE = re.compile(r"^[0-9a-f]{64}$")


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def from_b64url(s: str) -> bytes:
    s = str(s)
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def _json(obj) -> bytes:
    # 和 JS 的 JSON.stringify 一样：不加空格，中文原样
    return json.dumps(obj, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


class Issuer:
    def __init__(self, seed: bytes):
        if len(seed) != 32:
            raise ValueError("签发方种子必须是 32 字节")
        self._key = Ed25519PrivateKey.from_private_bytes(seed)
        pub = self._key.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
        self.x = b64url(pub)
        # 和客户端 generateIssuer 一样：kid 是公钥前 8 字节的 hex
        self.kid = pub[:8].hex()

    @property
    def public_key(self) -> dict:
        return {"kid": self.kid, "x": self.x}

    def sign(self, data: bytes) -> bytes:
        return self._key.sign(data)


def load_issuer(env: dict | None = None, key_file: Path = KEY_FILE) -> Issuer:
    env = os.environ if env is None else env
    raw = str(env.get("MESH_ISSUER_KEY", "") or "").strip()
    if raw:
        return Issuer(bytes.fromhex(raw))
    try:
        seed = bytes.fromhex(key_file.read_text().strip())
        return Issuer(seed)
    except (FileNotFoundError, ValueError):
        pass
    seed = os.urandom(32)
    key_file.parent.mkdir(parents=True, exist_ok=True)
    key_file.write_text(seed.hex())
    try:
        os.chmod(key_file, 0o600)
    except OSError:
        pass
    return Issuer(seed)


def issuer_keys(issuer: Issuer, env: dict | None = None) -> list[dict]:
    """下发给客户端的签发方公钥：当前这把 + 轮换期的旧钥匙"""
    env = os.environ if env is None else env
    keys = [issuer.public_key]
    for item in str(env.get("MESH_ISSUER_OLD_KEYS", "") or "").split(","):
        kid, _, x = item.strip().partition(":")
        if kid and x and kid != issuer.kid:
            keys.append({"kid": kid, "x": x})
    return keys


def issue_cert(issuer: Issuer, *, user_id, device_id: str, endpoint_id: str, name: str = "",
               ttl_sec: int = DEFAULT_TTL_SEC, now: int | None = None,
               scope: str = "self", circles: list | None = None, team=None) -> tuple[str, int]:
    """签一张证书，返回 (证书, 到期时间)。scope / circles / team 预留给以后的圈子、团队"""
    if not ENDPOINT_ID_RE.match(str(endpoint_id or "")):
        raise ValueError("endpoint_id 不对")
    if not str(device_id or "").strip():
        raise ValueError("缺少 device_id")
    now = int(time.time()) if now is None else int(now)
    exp = now + int(ttl_sec)
    header = {"alg": "EdDSA", "typ": CERT_TYP, "kid": issuer.kid}
    payload = {
        "typ": CERT_TYP,
        "ver": 1,
        "iss": ISSUER,
        "sub": str(user_id),
        "device_id": str(device_id),
        "endpoint_id": str(endpoint_id),
        "name": str(name or "")[:64],
        "iat": now,
        "exp": exp,
        "scope": scope,
        "circles": list(circles or []),
        "team": team,
    }
    signing_input = f"{b64url(_json(header))}.{b64url(_json(payload))}"
    sig = issuer.sign(signing_input.encode("ascii"))
    return f"{signing_input}.{b64url(sig)}", exp


def verify_cert(token: str, keys: list[dict], now: int | None = None) -> dict | None:
    """校验签名和有效期，通过返回 claims。服务端自己用（比如中继放行），规则和客户端一致"""
    parts = str(token or "").split(".")
    if len(parts) != 3:
        return None
    try:
        header = json.loads(from_b64url(parts[0]))
        claims = json.loads(from_b64url(parts[1]))
    except (ValueError, json.JSONDecodeError):
        return None
    if header.get("alg") != "EdDSA" or header.get("typ") != CERT_TYP:
        return None
    key = next((k for k in keys or [] if k.get("kid") == header.get("kid")), None)
    if not key:
        return None
    try:
        Ed25519PublicKey.from_public_bytes(from_b64url(key["x"])).verify(
            from_b64url(parts[2]), f"{parts[0]}.{parts[1]}".encode("ascii"))
    except Exception:
        return None
    now = int(time.time()) if now is None else int(now)
    if claims.get("typ") != CERT_TYP or not isinstance(claims.get("exp"), int) or claims["exp"] < now - 300:
        return None
    return claims


def relay_urls(env: dict | None = None) -> list[str]:
    """TokenBank 官方中继地址（MESH_RELAY_URLS，逗号分隔，如 wss://relay.example.com/mesh/ws）"""
    env = os.environ if env is None else env
    return [u.strip() for u in str(env.get("MESH_RELAY_URLS", "") or "").split(",") if u.strip()]
