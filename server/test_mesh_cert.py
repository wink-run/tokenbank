"""设备网络证书：格式和客户端 identity.js 一致，客户端能离线校验。"""

import json
import shutil
import subprocess
from pathlib import Path

import tempfile
import unittest

import mesh_cert as m

EP = "ab" * 32
CLIENT_IDENTITY = Path(__file__).resolve().parent.parent / "client" / "electron" / "mesh" / "identity.js"


def issuer():
    return m.Issuer(bytes(range(32)))



class MeshCertTest(unittest.TestCase):
    def test_issue_and_verify_roundtrip(self):
        iss = issuer()
        cert, exp = m.issue_cert(iss, user_id=7, device_id="dev-a", endpoint_id=EP, name="macbook", now=1000)
        claims = m.verify_cert(cert, [iss.public_key], now=2000)
        assert claims["sub"] == "7" and claims["device_id"] == "dev-a" and claims["endpoint_id"] == EP
        assert claims["scope"] == "self" and claims["circles"] == [] and claims["team"] is None
        assert exp == 1000 + m.DEFAULT_TTL_SEC


    def test_rejects_wrong_key_expired_and_tampered(self):
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


    def test_bad_endpoint_id_is_refused(self):
        with self.assertRaises(ValueError):
            m.issue_cert(issuer(), user_id=1, device_id="dev-a", endpoint_id="not-hex")


    def test_kid_matches_client_rule(self):
        iss = issuer()
        assert iss.kid == m.from_b64url(iss.x)[:8].hex()


    def test_issuer_keys_include_rotation_keys(self):
        iss = issuer()
        keys = m.issuer_keys(iss, env={"MESH_ISSUER_OLD_KEYS": "old1:xxx, ,bad"})
        assert keys[0] == iss.public_key and {"kid": "old1", "x": "xxx"} in keys and len(keys) == 2


    def test_issuer_key_from_env_and_file(self):
        tmp_path = Path(tempfile.mkdtemp())
        a = m.load_issuer(env={"MESH_ISSUER_KEY": "11" * 32}, key_file=tmp_path / "k")
        assert a.kid == m.Issuer(bytes.fromhex("11" * 32)).kid
        b1 = m.load_issuer(env={}, key_file=tmp_path / "k")
        b2 = m.load_issuer(env={}, key_file=tmp_path / "k")
        assert b1.kid == b2.kid and (tmp_path / "k").exists()


    @unittest.skipIf(not shutil.which("node") or not CLIENT_IDENTITY.exists(), "需要 node 和客户端代码")
    def test_client_accepts_cloud_cert(self):
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


    @unittest.skipIf(not shutil.which("node") or not CLIENT_IDENTITY.exists(), "需要 node 和客户端代码")
    def test_client_accepts_cloud_hire_ticket(self):
        """云端签的雇佣票，客户端（中继和出租方）认得"""
        iss = issuer()
        ticket, exp = m.issue_hire_ticket(
            iss, task_id="at-1", assistant_id="app:claude-code", hirer_user=7, hirer_device="dev-h", hirer_endpoint="aa" * 32,
            worker_user=8, worker_device="dev-w", worker_endpoint="bb" * 32, consumer_key="u7",
        )
        js = (
            f"const id=require({json.dumps(str(CLIENT_IDENTITY))});"
            f"const r=id.verifyHireTicket({json.dumps(ticket)},[{json.dumps(iss.public_key)}]);"
            f"const bad=id.verifyHireTicket({json.dumps(ticket[:-4] + 'AAAA')},[{json.dumps(iss.public_key)}]);"
            "process.stdout.write(JSON.stringify({r, bad}));"
        )
        out = json.loads(subprocess.run(["node", "-e", js], capture_output=True, text=True, check=True).stdout)
        assert out["r"]["ok"] is True
        c = out["r"]["claims"]
        assert (c["tid"], c["sub"], c["wd"], c["ck"], c["exp"]) == ("at-1", "7", "dev-w", "u7", exp)
        assert out["bad"]["ok"] is False


    def test_hire_ticket_roundtrip_and_tamper(self):
        """后端内置中继用 Python 校验雇佣票：和客户端规则一致"""
        iss = issuer()
        ticket, exp = m.issue_hire_ticket(
            iss, task_id="at-2", assistant_id="a", hirer_user=1, hirer_device="h", hirer_endpoint="aa" * 32,
            worker_user=2, worker_device="w", worker_endpoint="bb" * 32,
        )
        keys = [iss.public_key]
        c = m.verify_hire_ticket(ticket, keys)
        assert c and c["tid"] == "at-2" and c["exp"] == exp
        assert m.verify_hire_ticket(ticket[:-4] + "AAAA", keys) is None
        assert m.verify_hire_ticket(ticket, keys, now=exp + 3600) is None
        cert, _ = m.issue_cert(iss, user_id=1, device_id="d", endpoint_id=EP)
        assert m.verify_hire_ticket(cert, keys) is None, "设备证书不能当雇佣票用"


    def test_builtin_relay_url_follows_request(self):
        import mesh_relay

        class R:
            def __init__(self, headers, scheme="http"):
                self.headers = headers
                self.url = type("U", (), {"scheme": scheme})()

        assert mesh_relay.own_relay_url(R({"host": "tb.example.com", "x-forwarded-proto": "https"})) == "wss://tb.example.com/mesh/ws"
        assert mesh_relay.own_relay_url(R({"host": "1.2.3.4:8000"})) == "ws://1.2.3.4:8000/mesh/ws"


if __name__ == "__main__":
    unittest.main()
