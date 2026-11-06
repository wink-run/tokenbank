"""
测试 Gateway 工具调用后的输出提取

场景：
1. 工具调用期间可能发送部分 delta 事件（accumulated_text 部分累积）
2. 工具完成后生成最终文本，但不发送新的 delta
3. response.completed 包含完整的 output
4. 应该使用 completed.output（更长的那个）
"""
import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from dispatch_agent import iter_agent_task_sse


@pytest.mark.asyncio
async def test_tool_output_extraction_prefers_longer():
    """工具调用后的输出：优先使用更长的 completed.output"""
    
    # 模拟 Gateway SSE 事件流：部分 delta + 工具调用 + 完整 completed
    gateway_events = [
        # 初始 delta（部分文本）
        {
            "event": "response.output_text.delta",
            "data": {"delta": "让我"},
        },
        {
            "event": "response.output_text.delta",
            "data": {"delta": "执行一个工具"},
        },
        # 工具调用
        {
            "event": "response.tool",
            "data": {"tool": "generate_image"},
        },
        # 完成（包含工具调用前后的完整文本）
        {
            "event": "response.completed",
            "data": {
                "id": "resp_test123",
                "status": "completed",
                "output": [
                    {
                        "type": "message",
                        "role": "assistant",
                        "content": [
                            {
                                "type": "output_text",
                                "text": "让我执行一个工具来生成图片。\n\n工具已完成，这是最终结果。",
                            }
                        ],
                    }
                ],
            },
        },
    ]
    
    # Mock dependencies
    with patch("dispatch_agent.pool") as mock_pool, \
         patch("dispatch_agent.db") as mock_db, \
         patch("dispatch_agent.invoke_worker_gateway_stream") as mock_stream, \
         patch("dispatch_agent._apply_artifacts") as mock_artifacts:
        
        # Setup mocks
        mock_worker = MagicMock()
        mock_worker.user_id = 1
        mock_worker.worker_id = "w123"
        mock_pool.pick_agent_workers.return_value = [mock_worker]
        
        mock_db.deduct_credits = AsyncMock(return_value=(True, 100.0))
        mock_db.award_credits = AsyncMock()
        
        # Mock gateway stream to yield our test events
        async def mock_gateway_stream(*args, **kwargs):
            for evt in gateway_events:
                yield evt
        mock_stream.return_value = mock_gateway_stream()
        
        # Mock artifact processing (no-op for this test)
        mock_artifacts.return_value = (
            "让我执行一个工具来生成图片。\n\n工具已完成，这是最终结果。",
            []
        )
        
        # Execute
        events = []
        async for sse in iter_agent_task_sse(
            assistant_id="test-agent",
            prompt="生成一张图片",
            consumer_user_id=1,
        ):
            events.append(sse)
        
        # Verify: done event should have the complete output from completed, not just accumulated
        done_events = [e for e in events if '"event": "done"' in e]
        assert len(done_events) == 1
        
        done_event = done_events[0]
        # 完整文本应该被使用（不仅仅是 "让我执行一个工具"）
        assert "工具已完成，这是最终结果" in done_event
        assert '"ok": true' in done_event


@pytest.mark.asyncio
async def test_tool_output_without_prior_deltas():
    """工具调用后的输出：没有 delta 时直接使用 completed.output"""
    
    # 模拟只有工具和 completed，没有任何 delta
    gateway_events = [
        {
            "event": "response.tool",
            "data": {"tool": "execute_command"},
        },
        {
            "event": "response.completed",
            "data": {
                "id": "resp_test456",
                "status": "completed",
                "output": [
                    {
                        "type": "message",
                        "role": "assistant",
                        "content": [
                            {
                                "type": "output_text",
                                "text": "命令执行完成，结果如下：\n\n已完成 51s",
                            }
                        ],
                    }
                ],
            },
        },
    ]
    
    with patch("dispatch_agent.pool") as mock_pool, \
         patch("dispatch_agent.db") as mock_db, \
         patch("dispatch_agent.invoke_worker_gateway_stream") as mock_stream, \
         patch("dispatch_agent._apply_artifacts") as mock_artifacts:
        
        mock_worker = MagicMock()
        mock_worker.user_id = 1
        mock_worker.worker_id = "w123"
        mock_pool.pick_agent_workers.return_value = [mock_worker]
        
        mock_db.deduct_credits = AsyncMock(return_value=(True, 100.0))
        mock_db.award_credits = AsyncMock()
        
        async def mock_gateway_stream(*args, **kwargs):
            for evt in gateway_events:
                yield evt
        mock_stream.return_value = mock_gateway_stream()
        
        mock_artifacts.return_value = (
            "命令执行完成，结果如下：\n\n已完成 51s",
            []
        )
        
        events = []
        async for sse in iter_agent_task_sse(
            assistant_id="test-agent",
            prompt="执行命令",
            consumer_user_id=1,
        ):
            events.append(sse)
        
        done_events = [e for e in events if '"event": "done"' in e]
        assert len(done_events) == 1
        
        done_event = done_events[0]
        # 应该有完整输出（不是空的）
        assert "命令执行完成" in done_event
        assert "已完成 51s" in done_event
