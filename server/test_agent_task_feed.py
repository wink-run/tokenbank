"""刷新后能从同一条任务流接上，进度快照只留最新一帧。"""
import asyncio

from dispatch_agent import (
    _AGENT_FEEDS,
    _ensure_agent_feed,
    _progress_tool_part,
    _public_progress_parts,
    _publish_agent_feed,
    iter_agent_feed_sse,
    share_session_binding,
)


def test_feed_replays_latest_progress_then_done():
    task = "at-testfeed01"
    _AGENT_FEEDS.pop(task, None)
    _ensure_agent_feed(task, 1)
    _publish_agent_feed(task, {"event": "started", "task_id": task})
    _publish_agent_feed(task, {"event": "progress", "task_id": task, "text": "a"})
    _publish_agent_feed(task, {"event": "progress", "task_id": task, "text": "ab"})
    _publish_agent_feed(task, {"event": "done", "ok": True, "task_id": task, "output": "ab"})
    _AGENT_FEEDS[task]["finished"] = True

    async def collect():
        out = []
        async for chunk in iter_agent_feed_sse(task):
            out.append(chunk)
        return out

    chunks = asyncio.run(collect())
    progress = [c for c in chunks if '"event": "progress"' in c]
    assert len(progress) == 1
    assert '"text": "ab"' in progress[0]
    assert any('"event": "done"' in c for c in chunks)
    _AGENT_FEEDS.pop(task, None)


def test_live_reader_sees_replaced_progress():
    """读过第一帧进度后，后盖上的工具步骤也要送到同一条连接。"""
    task = "at-testfeed02"
    _AGENT_FEEDS.pop(task, None)

    async def collect():
        _ensure_agent_feed(task, 1)
        _publish_agent_feed(task, {"event": "started", "task_id": task})
        _publish_agent_feed(task, {"event": "progress", "task_id": task, "text": "思考"})
        agen = iter_agent_feed_sse(task)
        first = []
        first.append(await agen.__anext__())
        first.append(await agen.__anext__())

        async def push_rest():
            await asyncio.sleep(0.05)
            _publish_agent_feed(task, {
                "event": "progress",
                "task_id": task,
                "text": "思考",
                "parts": [{"type": "tool", "name": "Bash", "detail": "gen.py"}],
            })
            await asyncio.sleep(0.05)
            _publish_agent_feed(task, {"event": "done", "ok": True, "task_id": task, "output": "ok"})
            _AGENT_FEEDS[task]["finished"] = True

        asyncio.create_task(push_rest())
        rest = []
        while True:
            chunk = await asyncio.wait_for(agen.__anext__(), timeout=2)
            rest.append(chunk)
            if '"event": "done"' in chunk:
                break
        return first, rest

    first, rest = asyncio.run(collect())
    assert any('"text": "思考"' in c for c in first)
    assert any('"name": "Bash"' in c for c in rest)
    assert any('"event": "done"' in c for c in rest)
    _AGENT_FEEDS.pop(task, None)


def test_share_followup_keeps_owner_session():
    """别人接着聊时回到发起人的目录，并续上已有 CLI 会话。"""
    fresh = share_session_binding(
        {"user_id": 1, "messages": "[]", "cli_session_id": ""},
        "g02629b4b482b",
    )
    assert fresh["consumer_key"] == "u1"
    assert fresh["continue_session"] is False

    prior = share_session_binding(
        {
            "user_id": 1,
            "messages": '[{"role":"user","content":"画故宫"},{"role":"assistant","content":"已出图"}]',
            "cli_session_id": "",
        },
        "g02629b4b482b",
    )
    assert prior["consumer_key"] == "u1"
    assert prior["continue_session"] is True
    assert prior["cli_session_id"] == ""

    resumed = share_session_binding(
        {"user_id": 7, "messages": "[]", "cli_session_id": "f6c3e7f5-82a3-417c-ab71-e36849da630b"},
        "u9",
    )
    assert resumed["consumer_key"] == "u7"
    assert resumed["continue_session"] is True
    assert resumed["cli_session_id"].startswith("f6c3e7f5")

    own = share_session_binding(None, "u3")
    assert own == {"consumer_key": "u3", "continue_session": False, "cli_session_id": ""}


def test_tool_part_done_stops_when_status_completed():
    running = _progress_tool_part("Bash", "tu1", "ls", "", "running")
    assert running.get("done") is not True
    done = _progress_tool_part("Bash", "tu1", "ls", "ok", "completed")
    assert done["done"] is True
    assert "error" not in done
    failed = _progress_tool_part("Bash", "tu1", "", "no", "error")
    assert failed["done"] is True and failed["error"] is True
    # 旧进度只带 status 时，公开分段也要标成结束
    parts = _public_progress_parts([{"type": "tool", "name": "Bash", "status": "completed"}])
    assert parts[0]["done"] is True
