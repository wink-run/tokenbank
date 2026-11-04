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
    redact_remaining_local_paths,
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
        "文件名换成地址后，别的文件 other.png 仍保留\n"
    )
    rewritten = rewrite_artifact_paths(text, stored)
    assert url in rewritten
    assert LOCAL not in rewritten
    assert "pelican_bicycle.png" not in rewritten.replace(url, "")
    assert "other.png" in rewritten
    # 旧客户端不带 localPath 时，仍按文件名收掉绝对路径
    bare = dict(stored[0])
    bare["local"] = ""
    assert LOCAL not in rewrite_artifact_paths(text, [bare])
    # 已经换成中转地址后再跑一遍，不能把 https:// 拼成 httphttps://
    twice = rewrite_artifact_paths(rewritten, stored)
    assert twice == rewritten
    assert "httphttps://" not in twice
    leftover = redact_remaining_local_paths(
        "还有 " + LOCAL.replace("pelican_bicycle.png", "notes.txt") + " 和 " + url
    )
    assert "/Users/wink" not in leftover
    assert "notes.txt" in leftover
    assert url in leftover
    public = public_artifacts(stored)
    assert "local" not in public[0]
    assert "dataUrl" not in public[0]
    assert public[0]["url"] == url


def test_chinese_filename_keeps_extension():
    tmp = tempfile.mkdtemp(prefix="tb-art-")
    tmp_path = Path(tmp)
    local = "/Users/wink/.tokenbank/contribute-workspaces/app_claude-code/u1/骑自行车的人.svg"
    stored = publish_agent_artifacts(
        "task_cn",
        [{
            "name": "骑自行车的人.svg",
            "mime": "image/svg+xml",
            "dataUrl": "data:image/svg+xml;base64," + base64.b64encode(b"<svg xmlns='http://www.w3.org/2000/svg'/>").decode(),
            "localPath": local,
        }],
        media_dir=tmp_path,
        origin="https://tokenbank.wink.run",
    )
    assert len(stored) == 1
    url = stored[0]["url"]
    assert url.endswith("/file.svg")
    assert not url.endswith("/svg")
    assert (tmp_path / "task_cn" / "file.svg").is_file()
    text = rewrite_artifact_paths("图：`" + local + "`", stored)
    assert url in text
    assert "/Users/wink" not in text
    assert stored[0]["name"] == "骑自行车的人.svg"


def test_video_and_relative_subtitle_become_proxy_urls():
    tmp = tempfile.mkdtemp(prefix="tb-art-")
    tmp_path = Path(tmp)
    video = "/Users/ully/.tokenbank/contribute-workspaces/res-assistant-video-gen-agent/u1/outputs/轻记账技能-宣传片-16x9.mp4"
    sub = "/Users/ully/.tokenbank/contribute-workspaces/res-assistant-video-gen-agent/u1/outputs/轻记账技能-宣传片-16x9.srt"
    blob = b"\x00" * (5 * 1024 * 1024)
    stored = publish_agent_artifacts(
        "task_vid",
        [
            {
                "name": "轻记账技能-宣传片-16x9.mp4",
                "mime": "video/mp4",
                "dataUrl": "data:video/mp4;base64," + base64.b64encode(blob).decode(),
                "localPath": video,
            },
            {
                "name": "轻记账技能-宣传片-16x9.srt",
                "mime": "text/plain",
                "dataUrl": "data:text/plain;base64," + base64.b64encode("1\n你好\n".encode()).decode(),
                "localPath": sub,
            },
        ],
        media_dir=tmp_path,
        origin="https://tokenbank.wink.run",
    )
    assert len(stored) == 2
    assert stored[0]["mime"] == "video/mp4"
    text = f"成片：{video} ： 1920×1080\n字幕：outputs/轻记账技能-宣传片-16x9.srt （13 条）"
    rewritten = rewrite_artifact_paths(text, stored)
    assert "/Users/ully" not in rewritten
    assert "outputs/" not in rewritten
    assert stored[0]["url"] in rewritten
    assert stored[1]["url"] in rewritten
    assert rewrite_artifact_paths(rewritten, stored) == rewritten
    assert "httphttps://" not in rewritten


def test_remote_hire_hides_local_folder_and_filenames():
    tmp = tempfile.mkdtemp(prefix="tb-art-")
    tmp_path = Path(tmp)
    names = ["01-分析有毒关系.png", "preview.png"]
    raw = []
    locals_ = []
    for name in names:
        local = f"/Users/wink/.tokenbank/contribute-workspaces/app/u1/final/{name}"
        locals_.append(local)
        raw.append({
            "name": name,
            "mime": "image/png",
            "dataUrl": DATA,
            "localPath": local,
        })
    stored = publish_agent_artifacts(
        "task_batch",
        raw,
        media_dir=tmp_path,
        origin="https://tokenbank.wink.run",
    )
    assert len(stored) == 2
    folder = locals_[0].rsplit("/", 1)[0]
    text = (
        "这 10 张图都在下面这个文件夹里，已经帮你在 Finder 里打开了：\n\n"
        "```\nfinal\n```\n\n"
        "1. `01-分析有毒关系.png`\n"
        "总览拼版： `preview.png`\n"
        f"目录：{folder}\n"
    )
    rewritten = redact_remaining_local_paths(rewrite_artifact_paths(text, stored))
    assert "/Users/" not in rewritten
    assert "final" not in rewritten
    assert "01-分析有毒关系.png" not in rewritten
    assert "`preview.png`" not in rewritten
    assert stored[0]["url"] in rewritten
    assert stored[1]["url"] in rewritten
    assert "```" not in rewritten
    # 再跑一遍不能把地址里的文件名拆坏
    assert rewrite_artifact_paths(rewritten, stored) == rewritten


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
