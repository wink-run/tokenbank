"""云端转发的雇佣文件走 COS 引用：上限 500MB、私有随机路径、转发前核对。"""

import pytest

import hire_files
from web_public import normalize_agent_files, normalize_agent_images


def test_upload_url_random_private_path_and_cap():
    seen = {}

    def presign(key, ctype):
        seen["key"], seen["type"] = key, ctype
        return f"https://cos.example/{key}?sign=put"

    a = hire_files.new_upload("报告 v2.pdf", 1024, "application/pdf", presign=presign)
    b = hire_files.new_upload("报告 v2.pdf", 1024, "application/pdf", presign=presign)
    assert a["cos_key"].startswith("agent-media/hire/") and a["cos_key"] != b["cos_key"]
    assert hire_files._KEY_RE.match(a["cos_key"])
    assert a["headers"] == {"Content-Type": "application/pdf"}
    with pytest.raises(ValueError, match="too large"):
        hire_files.new_upload("big.mov", 500 * 1024 * 1024 + 1, "video/quicktime", presign=presign)
    hire_files.new_upload("ok.mov", 500 * 1024 * 1024, "video/quicktime", presign=presign)


def test_no_cos_means_fallback(monkeypatch):
    monkeypatch.setattr(hire_files.cos_media, "enabled", lambda: False)
    with pytest.raises(hire_files.CosUnavailable):
        hire_files.new_upload("a.png", 10, "image/png")


def test_resolve_ref_checks_object():
    key = "agent-media/hire/abcdefghijklmnopqrstuvwx/a.png"
    got = hire_files.resolve_ref(
        {"cos_key": key, "name": "图.png", "mime": "image/png"},
        size_of=lambda k: 2048, presign_get=lambda k: f"https://cos.example/{k}?sign=get",
    )
    assert got == {"name": "图.png", "mime": "image/png", "size": 2048, "url": f"https://cos.example/{key}?sign=get"}
    with pytest.raises(ValueError, match="not uploaded"):
        hire_files.resolve_ref({"cos_key": key}, size_of=lambda k: None, presign_get=lambda k: "x")
    with pytest.raises(ValueError, match="too large"):
        hire_files.resolve_ref({"cos_key": key}, size_of=lambda k: hire_files.HIRE_FILE_MAX_BYTES + 1, presign_get=lambda k: "x")
    with pytest.raises(ValueError, match="invalid"):
        hire_files.resolve_ref({"cos_key": "agent-media/task_x/a.png"}, size_of=lambda k: 1, presign_get=lambda k: "x")


def test_normalize_keeps_refs_and_base64():
    key = "agent-media/hire/abcdefghijklmnopqrstuvwx/a.png"
    imgs = normalize_agent_images([{"cos_key": key, "name": "a.png", "mime": "image/png", "size": 9}, {"dataUrl": "data:image/png;base64,AAAA"}])
    assert imgs[0] == {"cos_key": key, "name": "a.png", "mime": "image/png", "size": 9}
    assert imgs[1]["dataUrl"].startswith("data:image/png")
    files = normalize_agent_files([{"cos_key": key.replace("a.png", "b.zip"), "name": "b.zip"}])
    assert files[0]["cos_key"].endswith("b.zip")
    with pytest.raises(ValueError, match="invalid"):
        normalize_agent_files([{"cos_key": "secret/other-bucket-object"}])
    # 二次规范化不改引用
    assert normalize_agent_images(imgs[:1]) == imgs[:1]
