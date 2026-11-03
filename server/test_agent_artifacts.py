"""远程成品落盘，并把正文里的本机路径换成中转地址。"""

import base64
import tempfile
from pathlib import Path

import os
import time

from agent_artifacts import (
    cleanup_agent_media,
    public_artifacts,
    publish_agent_artifacts,
    rewrite_artifact_paths,
)

PNG = base64.b64encode(b"\x89PNG\r\n").decode()
DATA = f"data:image/png;base64,{PNG}"
LOCAL = "/Users/wink/.tokenbank/contribute-workspaces/app_claude-code/u1/pelican_bicycle.png"


def test_publish_rewrites_local_path():
    tmp = tempfile.mkdtemp(prefix="tb-art-")
    tmp_path = Path(tmp)
    raw = [{
        "name": "pelican_bicycle.png",
        "mime": "image/png",
        "kind": "image",
        "dataUrl": DATA,
        "localPath": LOCAL,
    }]
    stored = publish_agent_artifacts(
        "task_abc",
        raw,
        media_dir=tmp_path,
        origin="https://tokenbank.wink.run",
    )
    assert len(stored) == 1
    url = "https://tokenbank.wink.run/media/agent/task_abc/pelican_bicycle.png"
    assert stored[0]["url"] == url
    assert (tmp_path / "task_abc" / "pelican_bicycle.png").is_file()
    text = (
        "PNG 图片：`" + LOCAL + "`\n"
        "文件名 pelican_bicycle.png 仍保留\n"
    )
    rewritten = rewrite_artifact_paths(text, stored)
    assert url in rewritten
    assert LOCAL not in rewritten
    assert "文件名 pelican_bicycle.png 仍保留" in rewritten
    # 旧客户端不带 localPath 时，仍按文件名收掉绝对路径
    bare = dict(stored[0])
    bare["local"] = ""
    assert LOCAL not in rewrite_artifact_paths(text, [bare])
    public = public_artifacts(stored)
    assert "local" not in public[0]
    assert "dataUrl" not in public[0]
    assert public[0]["url"] == url


def test_publish_rejects_outside_bytes():
    tmp = tempfile.mkdtemp(prefix="tb-art-")
    tmp_path = Path(tmp)
    stored = publish_agent_artifacts(
        "task_abc",
        [{"name": "a.png", "mime": "image/png", "dataUrl": "https://evil.example/a.png"}],
        media_dir=tmp_path,
        origin="https://tokenbank.wink.run",
    )
    assert stored == []


def test_cleanup_keeps_files_for_three_days():
    tmp = tempfile.mkdtemp(prefix="tb-art-")
    tmp_path = Path(tmp)
    stored = publish_agent_artifacts(
        "task_old",
        [{"name": "old.png", "mime": "image/png", "dataUrl": DATA, "localPath": LOCAL}],
        media_dir=tmp_path,
        origin="https://tokenbank.wink.run",
    )
    fresh = publish_agent_artifacts(
        "task_new",
        [{"name": "new.png", "mime": "image/png", "dataUrl": DATA}],
        media_dir=tmp_path,
        origin="https://tokenbank.wink.run",
    )
    assert stored and fresh
    old = tmp_path / "task_old" / "old.png"
    new = tmp_path / "task_new" / "new.png"
    # 4 天前的删掉，刚写入的留下
    day = 86400
    os.utime(old, (time.time() - 4 * day, time.time() - 4 * day))
    removed = cleanup_agent_media(tmp_path, ttl_sec=3 * day)
    assert removed == 1
    assert not old.exists()
    assert not old.parent.exists()
    assert new.is_file()
