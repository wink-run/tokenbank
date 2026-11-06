"""出租方重启：上架名单留着，进行中的任务可以在同一台设备上接着跑。"""

import asyncio
import time

from worker_pool import (
    AGENT_RESUME_PROMPT,
    WorkerConnection,
    WorkerPool,
    agent_resume_message,
)


class _FakeWs:
    def __init__(self):
        self.closed = False

    async def close(self, code=1000, reason=""):
        self.closed = True


def _worker(uid, device, agents=None, name="desk"):
    return WorkerConnection(
        ws=_FakeWs(),
        models=[],
        worker_id=f"w-{device}",
        name=name,
        user_id=uid,
        device_id=device,
        agents=list(agents or []),
    )


def test_restart_keeps_listed_agents():
    pool = WorkerPool()
    old = _worker(7, "dev-a", agents=[{"id": "poet", "display_name": "写诗"}])
    pool.add(old)
    # 重启后先带着空名单注册。旧连接被换掉时会把上架名单留下
    new = _worker(7, "dev-a", agents=[])
    pool.add(new)
    assert pool.restore_agent_cards(new) is True
    assert [c["id"] for c in new.agents] == ["poet"]
    # 另一台设备的名单不能串过来
    other = _worker(7, "dev-b", agents=[])
    assert pool.restore_agent_cards(other) is False
    assert other.agents == []


def test_explicit_unlist_is_not_restored():
    pool = WorkerPool()
    worker = _worker(7, "dev-a", agents=[{"id": "poet"}])
    pool.remember_agent_cards(worker)
    pool.forget_agent_cards(worker)
    restarted = _worker(7, "dev-a", agents=[])
    assert pool.restore_agent_cards(restarted) is False


def test_parked_task_resumes_on_same_device():
    pool = WorkerPool()
    old = _worker(3, "dev-a")
    q = asyncio.Queue()
    clock = {"deadline_at": time.time() + 30}
    box = {"worker": old}
    old.pending_agents["at-1"] = {
        "queue": q,
        "assistant_id": "poet",
        "prompt": "写首诗",
        "timeout_ms": 600_000,
        "consumer_key": "u9",
        "consumer_user_id": 9,
        "cli_session_id": "sess-1",
        "partial_output": "已经写了两句",
        "worker_box": box,
        "clock": clock,
    }
    before = clock["deadline_at"]
    parked = pool.park_agent_tasks(old)
    assert parked and parked["key"]
    assert old.pending_agents == {}
    assert clock["deadline_at"] >= before + 90
    # 再 park 一次不能把任务弄丢，也不能重复计时
    assert pool.park_agent_tasks(old) is None

    new = _worker(3, "dev-a")
    adopted = pool.adopt_parked_agent_tasks(new)
    assert [tid for tid, _ in adopted] == ["at-1"]
    assert box["worker"] is new
    assert "at-1" in new.pending_agents
    assert new.active_requests == 1
    # 已经接走了，宽限到期不能再判一次失败
    assert pool.expire_parked_agent_tasks(parked["key"], parked["token"]) == {}
    msg = agent_resume_message("at-1", adopted[0][1])
    assert msg["continue_session"] is True
    assert msg["cli_session_id"] == "sess-1"
    assert msg["prompt"] == AGENT_RESUME_PROMPT
    assert "images" not in msg


def test_not_started_task_keeps_original_prompt():
    msg = agent_resume_message("at-2", {
        "assistant_id": "poet",
        "prompt": "写首诗",
        "timeout_ms": 1000,
        "images": ["data:image/png;base64,aa"],
        "continue_session": False,
    })
    assert msg["prompt"] == "写首诗"
    assert msg["continue_session"] is None
    assert msg["images"] == ["data:image/png;base64,aa"]


def test_other_device_does_not_take_the_task():
    pool = WorkerPool()
    old = _worker(3, "dev-a")
    old.pending_agents["at-1"] = {"queue": asyncio.Queue(), "assistant_id": "poet"}
    pool.park_agent_tasks(old)
    other = _worker(3, "dev-b")
    assert pool.adopt_parked_agent_tasks(other) == []
    assert pool.find_parked_agent("at-1") is not None


if __name__ == "__main__":
    test_restart_keeps_listed_agents()
    test_explicit_unlist_is_not_restored()
    test_parked_task_resumes_on_same_device()
    test_not_started_task_keeps_original_prompt()
    test_other_device_does_not_take_the_task()
    print("ok")
