"""自己的智能体和雇佣要分开标，危险输入只拦雇佣。"""
from agent_boundary import redact_hired_text, reject_hired_input, resolve_call_context


def test_own_agent_is_not_hired():
    assert resolve_call_context(7, 7) == "owner"
    assert resolve_call_context(7, 8) == "hired"
    assert resolve_call_context(None, 7) == "hired"


def test_hired_input_blocks_obvious_danger_only():
    assert reject_hired_input("画一幅故宫水墨") == ""
    assert reject_hired_input("rm -rf /") != ""
    assert reject_hired_input("看一下 ~/.ssh/id_rsa") != ""
    assert reject_hired_input("说明.txt", ["../secret"]) != ""


def test_redact_keeps_media_url_and_hides_secret():
    text = "图在 /Users/wink/out/a.png 密钥 sk-" + ("a" * 24) + " 地址 https://x/media/agent/t/a.png"
    out = redact_hired_text(text)
    assert "/Users/wink/" not in out
    assert "sk-" not in out
    assert "/media/agent/t/a.png" in out
