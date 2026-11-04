"""刷新后能从同一条任务流接上，进度快照只留最新一帧。"""
import asyncio

from dispatch_agent import _AGENT_FEEDS, _ensure_agent_feed, _publish_agent_feed, iter_agent_feed_sse


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
