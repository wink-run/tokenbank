"""云端回拨：只验证公网地址，回的 endpoint_id 对得上才算从外面连得到"""
import asyncio
import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import mesh_router


def test_public_filter():
    pub = lambda a: mesh_router._public(mesh_router._split_addr(a)[0])
    assert pub("8.8.8.8:41750")
    assert pub("[2408:8000::1]:41750")
    for a in ["192.168.1.2:1", "10.0.0.1:1", "100.100.1.1:1", "127.0.0.1:1", "[::1]:1", "[fe80::1]:1", "169.254.1.1:1"]:
        assert not pub(a), a
    assert mesh_router._split_addr("nope") is None


def test_dial_back_checks_endpoint(monkeypatch):
    class H(BaseHTTPRequestHandler):
        def do_GET(self):
            body = json.dumps({"endpoint_id": "ab" * 32}).encode() if self.path == "/mesh/ping" else b""
            self.send_response(200 if body else 404)
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *a):
            pass

    srv = HTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        monkeypatch.setattr(mesh_router, "_public", lambda ip: True)   # 测试里只有回环地址
        addr = f"127.0.0.1:{srv.server_port}"
        assert asyncio.run(mesh_router._dial_back([addr, "127.0.0.1:1"], "ab" * 32)) == [addr]
        assert asyncio.run(mesh_router._dial_back([addr], "cd" * 32)) == []
    finally:
        srv.shutdown()
