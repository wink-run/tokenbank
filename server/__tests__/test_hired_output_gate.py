"""
hired模式输出门禁集成测试

验证需求（t205）：
1. 敏感词跨chunk不提前泄露：hired SSE流式执行中不发送原始text
2. 错误路径无原文：所有错误消息经过路径脱敏
3. 正常图文仍可用：artifacts处理不受影响
4. local流式不变：local模式保持原有行为

测试方法：
- 模拟gateway响应事件（delta/snapshot/tool/done/error）
- 验证hired模式SSE输出不包含原始内容
- 验证local模式SSE输出正常包含内容
- 验证路径脱敏生效
"""

import pytest
from unittest.mock import AsyncMock, Mock, patch
import json


class TestHiredOutputGate:
    """hired模式输出门禁测试"""

    @pytest.fixture
    def mock_db(self):
        """模拟数据库"""
        db = Mock()
        db.get_user_circle_ids = AsyncMock(return_value=[])
        db.award_credits = AsyncMock()
        db.deduct_credits = AsyncMock(return_value=(True, 1000))
        return db

    @pytest.fixture
    def mock_worker(self):
        """模拟worker"""
        return Mock(
            worker_id="w1",
            user_id="u1",
            base_url="http://localhost:8080",
            public_key="test_key",
        )

    @pytest.fixture
    def hired_request(self):
        """hired模式请求"""
        return {
            "assistant_id": "ast_test",
            "prompt": "test task",
            "call_context": "hired",
            "consumer_key": "ck_test",
        }

    @pytest.fixture
    def local_request(self):
        """local模式请求"""
        return {
            "assistant_id": "ast_test",
            "prompt": "test task",
            "call_context": "local",
        }

    @pytest.fixture
    def mock_gateway_stream(self):
        """模拟gateway SSE流"""
        def create_stream(events):
            async def stream():
                for event in events:
                    yield event
            return stream()
        return create_stream

    @pytest.mark.asyncio
    async def test_hired_sse_no_text_during_execution(
        self, mock_db, mock_worker, hired_request, mock_gateway_stream
    ):
        """hired SSE流式：执行中不发送原始text（防止敏感词跨chunk提前泄露）"""
        from server.dispatch_agent import agent_task_sse
        
        # 模拟gateway返回delta事件（包含敏感路径）
        sensitive_path = "/Users/test/.tokenbank/contribute-workspaces/ast_test/ck_test/sessions/abc123/secret.txt"
        gateway_events = [
            {
                "event": "response.output_text.delta",
                "data": {"delta": f"Processing file: {sensitive_path}\n"}
            },
            {
                "event": "response.output_text.delta",
                "data": {"delta": "API_KEY=sk-test123456789\n"}
            },
            {
                "event": "response.done",
                "data": {
                    "response": {
                        "id": "resp_1",
                        "output": [
                            {
                                "type": "message",
                                "content": [
                                    {"type": "output_text", "text": f"Processed: {sensitive_path}"}
                                ]
                            }
                        ],
                        "metadata": {
                            "session_root": "/Users/test/.tokenbank/contribute-workspaces/ast_test/ck_test/sessions/abc123"
                        }
                    }
                }
            }
        ]
        
        with patch("server.dispatch_agent.invoke_worker_gateway_stream") as mock_invoke:
            mock_invoke.return_value = mock_gateway_stream(gateway_events)
            
            with patch("server.dispatch_agent.db", mock_db):
                with patch("server.dispatch_agent._select_worker", return_value=mock_worker):
                    result_events = []
                    async for event in agent_task_sse(
                        assistant_id=hired_request["assistant_id"],
                        prompt=hired_request["prompt"],
                        consumer_user_id="user_1",
                        call_context="hired",
                        consumer_key=hired_request["consumer_key"],
                    ):
                        result_events.append(event)
        
        # 验证：progress事件不包含text（hired模式）
        progress_events = [e for e in result_events if b'"event": "progress"' in e]
        for event in progress_events:
            event_json = json.loads(event.decode().split("data: ", 1)[1])
            # hired模式progress事件应该只有status，没有text
            assert "text" not in event_json or event_json.get("text") == "", \
                f"hired progress event should not contain text, got: {event_json}"
            # 应该有status字段
            assert event_json.get("status") == "running"
        
        # 验证：done事件包含脱敏后的输出
        done_events = [e for e in result_events if b'"event": "done"' in e]
        assert len(done_events) == 1
        done_json = json.loads(done_events[0].decode().split("data: ", 1)[1])
        
        # 输出应该不包含完整路径，session root应该被脱敏
        output = done_json.get("output", "")
        assert sensitive_path not in output, "Full path should be sanitized"
        # 可能被脱敏为相对路径或[路径已脱敏]
        assert "secret.txt" in output or "[路径已脱敏]" in output

    @pytest.mark.asyncio
    async def test_local_sse_text_streaming_unchanged(
        self, mock_db, mock_worker, local_request, mock_gateway_stream
    ):
        """local SSE流式：正常发送text（行为不变）"""
        from server.dispatch_agent import agent_task_sse
        
        gateway_events = [
            {
                "event": "response.output_text.delta",
                "data": {"delta": "Hello "}
            },
            {
                "event": "response.output_text.delta",
                "data": {"delta": "World!"}
            },
            {
                "event": "response.done",
                "data": {
                    "response": {
                        "id": "resp_1",
                        "output": [
                            {
                                "type": "message",
                                "content": [
                                    {"type": "output_text", "text": "Hello World!"}
                                ]
                            }
                        ]
                    }
                }
            }
        ]
        
        with patch("server.dispatch_agent.invoke_worker_gateway_stream") as mock_invoke:
            mock_invoke.return_value = mock_gateway_stream(gateway_events)
            
            with patch("server.dispatch_agent.db", mock_db):
                with patch("server.dispatch_agent._select_worker", return_value=mock_worker):
                    result_events = []
                    async for event in agent_task_sse(
                        assistant_id=local_request["assistant_id"],
                        prompt=local_request["prompt"],
                        consumer_user_id="user_1",
                        call_context="local",
                    ):
                        result_events.append(event)
        
        # 验证：progress事件包含text（local模式）
        progress_events = [e for e in result_events if b'"event": "progress"' in e]
        assert len(progress_events) >= 2
        
        # 第一个progress应该包含"Hello "
        first_json = json.loads(progress_events[0].decode().split("data: ", 1)[1])
        assert "Hello" in first_json.get("text", "")
        
        # 最后一个progress应该包含完整文本
        last_json = json.loads(progress_events[-1].decode().split("data: ", 1)[1])
        assert "Hello World!" in last_json.get("text", "")

    @pytest.mark.asyncio
    async def test_hired_error_path_sanitized(
        self, mock_db, mock_worker, hired_request, mock_gateway_stream
    ):
        """hired模式错误路径脱敏：错误消息中的路径被脱敏"""
        from server.dispatch_agent import agent_task_sse
        
        error_path = "/Users/test/.tokenbank/contribute-workspaces/ast_test/ck_test/sessions/abc123/config.json"
        gateway_events = [
            {
                "event": "error",
                "data": {
                    "error": {
                        "message": f"File not found: {error_path}"
                    },
                    "response": {
                        "metadata": {
                            "session_root": "/Users/test/.tokenbank/contribute-workspaces/ast_test/ck_test/sessions/abc123"
                        }
                    }
                }
            }
        ]
        
        with patch("server.dispatch_agent.invoke_worker_gateway_stream") as mock_invoke:
            mock_invoke.return_value = mock_gateway_stream(gateway_events)
            
            with patch("server.dispatch_agent.db", mock_db):
                with patch("server.dispatch_agent._select_worker", return_value=mock_worker):
                    result_events = []
                    async for event in agent_task_sse(
                        assistant_id=hired_request["assistant_id"],
                        prompt=hired_request["prompt"],
                        consumer_user_id="user_1",
                        call_context="hired",
                        consumer_key=hired_request["consumer_key"],
                    ):
                        result_events.append(event)
        
        # 验证：error事件不包含完整路径
        error_events = [e for e in result_events if b'"event": "error"' in e]
        assert len(error_events) == 1
        error_json = json.loads(error_events[0].decode().split("data: ", 1)[1])
        
        error_msg = error_json.get("error", "")
        assert error_path not in error_msg, "Full path should be sanitized in error"
        # 应该被脱敏为相对路径或通用标记
        assert "config.json" in error_msg or "[路径已脱敏]" in error_msg

    def test_non_sse_hired_output_sanitized(self, mock_db, mock_worker):
        """非SSE hired模式：输出路径脱敏"""
        from server.dispatch_agent import agent_task
        
        # 模拟gateway响应
        session_root = "/Users/test/.tokenbank/contribute-workspaces/ast_test/ck_test/sessions/abc123"
        gateway_response = {
            "id": "task_1",
            "status": "completed",
            "output": [
                {
                    "type": "message",
                    "content": [
                        {
                            "type": "output_text",
                            "text": f"Created file at {session_root}/output.txt\nSession directory: {session_root}"
                        }
                    ]
                }
            ],
            "metadata": {
                "session_root": session_root
            }
        }
        
        with patch("server.dispatch_agent.invoke_worker_gateway", return_value=gateway_response):
            with patch("server.dispatch_agent.db", mock_db):
                with patch("server.dispatch_agent._select_worker", return_value=mock_worker):
                    # 使用同步包装器测试
                    import asyncio
                    result = asyncio.run(agent_task(
                        assistant_id="ast_test",
                        prompt="create file",
                        consumer_user_id="user_1",
                        call_context="hired",
                        consumer_key="ck_test",
                    ))
        
        # 验证：输出不包含完整session root路径
        output = result.get("output", "")
        assert session_root not in output, "Session root should be sanitized"
        # session root应该被替换为'.'
        assert "." in output or "[路径已脱敏]" in output

    def test_artifacts_still_work(self):
        """验证artifacts处理不受路径脱敏影响（图文仍可用）"""
        from server.dispatch_agent import _apply_artifacts
        
        # 模拟包含图片artifact的输出
        task_id = "task_test"
        output_text = "Here is the image: ![result](./output.png)"
        artifacts = [
            {
                "type": "image",
                "path": "/some/session/root/output.png",
                "name": "result"
            }
        ]
        
        # _apply_artifacts应该上传图片并改写URL
        with patch("server.dispatch_agent._upload_artifact_to_s3") as mock_upload:
            mock_upload.return_value = "https://s3.example.com/task_test/output.png"
            
            processed_text, public_artifacts = _apply_artifacts(task_id, output_text, artifacts)
        
        # 验证：图片URL被改写为公开URL
        assert "https://s3.example.com" in processed_text
        assert len(public_artifacts) == 1
        assert public_artifacts[0]["url"] == "https://s3.example.com/task_test/output.png"


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
