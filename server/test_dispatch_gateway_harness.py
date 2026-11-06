"""测试 Gateway dispatch 时 harness_id 的正确格式。

回归测试：PR #32 后出现无限循环，原因是云端发送
`community:assistant@owner` 给所有者的机器，导致客户端
把它当作远程雇佣智能体再次回云端。

修复：当 worker 本地拥有该 assistant 时，使用本地
harness_id（assistant_id），而不是 community: 格式。
"""

import pytest
from unittest.mock import Mock, AsyncMock
from dispatch_agent import handle_agent_task, handle_agent_task_stream


class MockWorker:
    def __init__(self, worker_id, user_id, agents):
        self.worker_id = worker_id
        self.user_id = user_id
        self.agents = agents
        self.owner_nickname = "test_owner"
        self.pending_gateway = {}
        self.active_requests = 0
    
    async def send(self, data):
        pass


@pytest.mark.asyncio
async def test_local_assistant_uses_local_harness_id(monkeypatch):
    """当 worker 本地拥有 assistant 时，应使用本地 harness_id（不加 community: 前缀）"""
    
    # Mock worker with local assistant
    local_assistant_id = "res-assistant-content-creator"
    worker = MockWorker(
        worker_id="worker-123",
        user_id=1,
        agents=[
            {"id": local_assistant_id, "name": "Content Creator", "visibility": "public"}
        ]
    )
    
    # Track gateway_body sent
    gateway_calls = []
    
    async def mock_invoke_gateway(*, worker, method, path, body, timeout_sec, initiator):
        gateway_calls.append({
            "method": method,
            "path": path,
            "body": body,
            "initiator": initiator,
        })
        return {
            "id": "task_test",
            "status": "completed",
            "output": [{"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "Test response"}]}],
            "usage": {"duration_ms": 100},
        }
    
    # Mock dependencies
    monkeypatch.setattr("dispatch_agent.pool.pick_agent_workers", lambda *args, **kwargs: [worker])
    monkeypatch.setattr("dispatch_agent.db.get_user_by_id", AsyncMock(return_value={"credits_balance": 1000}))
    monkeypatch.setattr("dispatch_agent.db.get_user_circle_ids", AsyncMock(return_value=[]))
    monkeypatch.setattr("dispatch_agent.db.deduct_credits", AsyncMock(return_value=(True, 900)))
    monkeypatch.setattr("dispatch_agent.db.award_credits", AsyncMock())
    
    # Mock gateway call
    import dispatch_agent
    original_invoke = None
    try:
        original_invoke = dispatch_agent.invoke_worker_gateway
    except AttributeError:
        pass
    
    # Patch at module level
    import sys
    sys.modules['gateway_over_websocket'] = Mock()
    sys.modules['gateway_over_websocket'].invoke_worker_gateway = mock_invoke_gateway
    
    # Execute
    result = await handle_agent_task(
        assistant_id=local_assistant_id,
        prompt="Test prompt",
        consumer_user_id=1,
        owner="test_owner",
    )
    
    # Verify
    assert len(gateway_calls) == 1
    gateway_call = gateway_calls[0]
    
    # ✅ harness_id 应该是本地 assistant_id，不是 community: 格式
    assert gateway_call["body"]["metadata"]["harness_id"] == local_assistant_id
    assert not gateway_call["body"]["metadata"]["harness_id"].startswith("community:")
    
    # ✅ 任务成功完成
    assert result["ok"] is True
    assert result["status"] == "completed"


@pytest.mark.asyncio
async def test_remote_assistant_uses_community_format(monkeypatch):
    """当 worker 不拥有该 assistant 时，应使用 community: 格式（真正的远程雇佣）"""
    
    # Mock worker WITHOUT the requested assistant (remote hire scenario)
    worker = MockWorker(
        worker_id="worker-456",
        user_id=2,
        agents=[
            {"id": "other-assistant", "name": "Other", "visibility": "public"}
        ]
    )
    
    # Track gateway_body sent
    gateway_calls = []
    
    async def mock_invoke_gateway(*, worker, method, path, body, timeout_sec, initiator):
        gateway_calls.append({
            "method": method,
            "path": path,
            "body": body,
            "initiator": initiator,
        })
        return {
            "id": "task_test",
            "status": "completed",
            "output": [{"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "Test response"}]}],
            "usage": {"duration_ms": 100},
        }
    
    # Mock dependencies
    monkeypatch.setattr("dispatch_agent.pool.pick_agent_workers", lambda *args, **kwargs: [worker])
    monkeypatch.setattr("dispatch_agent.db.get_user_by_id", AsyncMock(return_value={"credits_balance": 1000}))
    monkeypatch.setattr("dispatch_agent.db.get_user_circle_ids", AsyncMock(return_value=[]))
    monkeypatch.setattr("dispatch_agent.db.deduct_credits", AsyncMock(return_value=(True, 900)))
    monkeypatch.setattr("dispatch_agent.db.award_credits", AsyncMock())
    
    # Mock gateway call
    import sys
    sys.modules['gateway_over_websocket'] = Mock()
    sys.modules['gateway_over_websocket'].invoke_worker_gateway = mock_invoke_gateway
    
    # Execute - request assistant not on this worker
    result = await handle_agent_task(
        assistant_id="remote-assistant",
        prompt="Test prompt",
        consumer_user_id=1,
        owner="remote_owner",
    )
    
    # Verify
    assert len(gateway_calls) == 1
    gateway_call = gateway_calls[0]
    
    # ✅ harness_id 应该是 community: 格式（远程雇佣）
    assert gateway_call["body"]["metadata"]["harness_id"] == "community:remote-assistant@remote_owner"
    
    # ✅ 任务成功完成
    assert result["ok"] is True
    assert result["status"] == "completed"


@pytest.mark.asyncio
async def test_no_recursion_for_local_assistant(monkeypatch):
    """回归测试：确保本地 assistant 不会触发无限循环"""
    
    # Mock worker with local assistant
    local_assistant_id = "res-assistant-content-creator"
    worker = MockWorker(
        worker_id="worker-789",
        user_id=3,
        agents=[
            {"id": local_assistant_id, "name": "Content Creator", "visibility": "public"}
        ]
    )
    
    # Count gateway calls to detect loops
    gateway_call_count = [0]
    
    async def mock_invoke_gateway(*, worker, method, path, body, timeout_sec, initiator):
        gateway_call_count[0] += 1
        
        # ✅ 验证不会使用 community: 格式（那会导致客户端再次回云端）
        harness_id = body["metadata"]["harness_id"]
        assert harness_id == local_assistant_id, f"Expected local harness_id '{local_assistant_id}', got '{harness_id}'"
        assert not harness_id.startswith("community:"), "Should not use community: format for local assistant"
        
        # Simulate successful local execution
        return {
            "id": "task_test",
            "status": "completed",
            "output": [{"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "Local execution result"}]}],
            "usage": {"duration_ms": 100},
        }
    
    # Mock dependencies
    monkeypatch.setattr("dispatch_agent.pool.pick_agent_workers", lambda *args, **kwargs: [worker])
    monkeypatch.setattr("dispatch_agent.db.get_user_by_id", AsyncMock(return_value={"credits_balance": 1000}))
    monkeypatch.setattr("dispatch_agent.db.get_user_circle_ids", AsyncMock(return_value=[]))
    monkeypatch.setattr("dispatch_agent.db.deduct_credits", AsyncMock(return_value=(True, 900)))
    monkeypatch.setattr("dispatch_agent.db.award_credits", AsyncMock())
    
    # Mock gateway call
    import sys
    sys.modules['gateway_over_websocket'] = Mock()
    sys.modules['gateway_over_websocket'].invoke_worker_gateway = mock_invoke_gateway
    
    # Execute
    result = await handle_agent_task(
        assistant_id=local_assistant_id,
        prompt="介绍一下你的能力和适合的任务",
        consumer_user_id=1,
        owner="adam",
    )
    
    # ✅ 应该只调用一次 gateway（不会循环）
    assert gateway_call_count[0] == 1, f"Expected 1 gateway call, got {gateway_call_count[0]} (infinite loop detected?)"
    
    # ✅ 任务成功完成
    assert result["ok"] is True
    assert result["status"] == "completed"
    assert "Local execution result" in str(result.get("output", ""))


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
