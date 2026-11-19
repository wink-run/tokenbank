"""设备网络证书：格式和客户端 identity.js 一致，客户端能离线校验。"""

import json
import shutil
import subprocess
from pathlib import Path

import pytest

import mesh_cert as m

EP = "ab" * 32
CLIENT_IDENTITY = Path(__file__).resolve().parent.parent / "client" / "electron" / "mesh" / "identity.js"


def issuer():
    return m.Issuer(bytes(range(32)))


def test_issue_and_verify_roundtrip():
    iss = issuer()
    cert, exp = m.issue_cert(iss, user_id=7, device_id="dev-a", endpoint_id=EP, name="macbook", now=1000)
    claims = m.verify_cert(cert, [iss.public_key], now=2000)
    assert claims["sub"] == "7" and claims["device_id"] == "dev-a" and claims["endpoint_id"] == EP
    assert claims["scope"] == "self" and claims["circles"] == [] and claims["team"] is None
    assert exp == 1000 + m.DEFAULT_TTL_SEC


def test_rejects_wrong_key_expired_and_tampered():
    iss = issuer()
    cert, _ = m.issue_cert(iss, user_id=7, device_id="dev-a", endpoint_id=EP, now=1000, ttl_sec=100)
    other = m.Issuer(bytes(32))
    assert m.verify_cert(cert, [other.public_key], now=1000) is None
    assert m.verify_cert(cert, [iss.public_key], now=1000 + 100 + 301) is None
    head, body, sig = cert.split(".")
    claims = json.loads(m.from_b64url(body))
    claims["sub"] = "8"
    forged = f"{head}.{m.b64url(json.dumps(claims).encode())}.{sig}"
    assert m.verify_cert(forged, [iss.public_key], now=1000) is None


def test_bad_endpoint_id_is_refused():
    with pytest.raises(ValueError):
        m.issue_cert(issuer(), user_id=1, device_id="dev-a", endpoint_id="not-hex")


def test_kid_matches_client_rule():
    iss = issuer()
    assert iss.kid == m.from_b64url(iss.x)[:8].hex()


def test_issuer_keys_include_rotation_keys():
    iss = issuer()
    keys = m.issuer_keys(iss, env={"MESH_ISSUER_OLD_KEYS": "old1:xxx, ,bad"})
    assert keys[0] == iss.public_key and {"kid": "old1", "x": "xxx"} in keys and len(keys) == 2


def test_issuer_key_from_env_and_file(tmp_path):
    a = m.load_issuer(env={"MESH_ISSUER_KEY": "11" * 32}, key_file=tmp_path / "k")
    assert a.kid == m.Issuer(bytes.fromhex("11" * 32)).kid
    b1 = m.load_issuer(env={}, key_file=tmp_path / "k")
    b2 = m.load_issuer(env={}, key_file=tmp_path / "k")
    assert b1.kid == b2.kid and (tmp_path / "k").exists()


@pytest.mark.skipif(not shutil.which("node") or not CLIENT_IDENTITY.exists(), reason="需要 node 和客户端代码")
def test_client_accepts_cloud_cert():
    iss = issuer()
    cert, _ = m.issue_cert(iss, user_id=1001, device_id="dev-a", endpoint_id=EP, name="中文名")
    js = (
        f"const id=require({json.dumps(str(CLIENT_IDENTITY))});"
        f"const r=id.checkPeer({json.dumps(cert)},{{issuerKeys:[{json.dumps(iss.public_key)}],"
        f"remoteEndpointId:{json.dumps(EP)},selfUserId:'1001'}});"
        "process.stdout.write(JSON.stringify(r));"
    )
    out = json.loads(subprocess.run(["node", "-e", js], capture_output=True, text=True, check=True).stdout)
    assert out["ok"] is True and out["claims"]["name"] == "中文名"
