"""
测试远程/雇佣调用的产物处理

场景：
1. 远程调用（通过 /api/agent-tasks）应该调用 _apply_artifacts 处理产物
2. 本地路径应该被改写为可访问的 /media/agent URL
3. 本地直接调用（不经过 dispatch_agent.py）不应该处理产物

边界：
- 默认远程API和网页 = 雇佣调用 = 需要artifact上传和路径改写
- 本机直接调用 = 保留本地路径
"""
import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from dispatch_agent import iter_agent_task_sse, handle_agent_task


@pytest.mark.asyncio
async def test_remote_call_applies_artifact_processing():
    """远程调用应该处理产物：上传文件，改写路径"""
    
    # 模拟返回包含本地路径的 artifacts
    gateway_events = [
        {
            "event": "response.completed",
            "data": {
                "id": "resp_remote123",
                "status": "completed",
                "output": [
                    {
                        "type": "message",
                        "role": "assistant",
                        "content": [
                            {
                                "type": "output_text",
                                "text": "生成的图片：![image](/tmp/agent_output/image.png)",
                            }
                        ],
                    }
                ],
                "artifacts": [
                    {
                        "type": "image",
                        "path": "/tmp/agent_output/image.png",
                        "name": "image.png",
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
        mock_worker.worker_id = "w_remote"
        mock_pool.pick_agent_workers.return_value = [mock_worker]
        
        mock_db.deduct_credits = AsyncMock(return_value=(True, 100.0))
        mock_db.award_credits = AsyncMock()
        
        async def mock_gateway_stream(*args, **kwargs):
            for evt in gateway_events:
                yield evt
        mock_stream.return_value = mock_gateway_stream()
        
        # Mock artifact processing: 改写本地路径为可访问URL
        def mock_artifact_fn(task_id, output, raw_artifacts):
            processed_output = output.replace(
                "/tmp/agent_output/image.png",
                f"/media/agent/{task_id}/image.png"
            )
            public_artifacts = [
                {
                    "type": "image",
                    "url": f"/media/agent/{task_id}/image.png",
                    "name": "image.png",
                }
            ]
            return processed_output, public_artifacts
        
        mock_artifacts.side_effect = mock_artifact_fn
        
        events = []
        async for sse in iter_agent_task_sse(
            assistant_id="remote-agent",
            prompt="生成图片",
            consumer_user_id=1,
            app_id="web-chat",  # 网页调用
        ):
            events.append(sse)
        
        # 验证：_apply_artifacts 应该被调用
        assert mock_artifacts.called, "_apply_artifacts should be called for remote calls"
        
        # 验证：done 事件应该包含改写后的路径和 artifacts
        done_events = [e for e in events if '"event": "done"' in e]
        assert len(done_events) == 1
        
        done_event = done_events[0]
        # 本地路径应该被改写
        assert "/tmp/agent_output/image.png" not in done_event
        assert "/media/agent/" in done_event
        # 应该包含 artifacts
        assert '"artifacts"' in done_event


@pytest.mark.asyncio
async def test_remote_call_without_artifacts():
    """远程调用但无产物：不应该失败"""
    
    gateway_events = [
        {
            "event": "response.completed",
            "data": {
                "id": "resp_noart",
                "status": "completed",
                "output": [
                    {
                        "type": "message",
                        "role": "assistant",
                        "content": [
                            {
                                "type": "output_text",
                                "text": "纯文本回复，没有图片或文件",
                            }
                        ],
                    }
                ],
                # 没有 artifacts 字段
            },
        },
    ]
    
    with patch("dispatch_agent.pool") as mock_pool, \
         patch("dispatch_agent.db") as mock_db, \
         patch("dispatch_agent.invoke_worker_gateway_stream") as mock_stream, \
         patch("dispatch_agent._apply_artifacts") as mock_artifacts:
        
        mock_worker = MagicMock()
        mock_worker.user_id = 1
        mock_worker.worker_id = "w_remote"
        mock_pool.pick_agent_workers.return_value = [mock_worker]
        
        mock_db.deduct_credits = AsyncMock(return_value=(True, 100.0))
        mock_db.award_credits = AsyncMock()
        
        async def mock_gateway_stream(*args, **kwargs):
            for evt in gateway_events:
                yield evt
        mock_stream.return_value = mock_gateway_stream()
        
        # 无产物时返回原样
        mock_artifacts.return_value = ("纯文本回复，没有图片或文件", [])
        
        events = []
        async for sse in iter_agent_task_sse(
            assistant_id="text-agent",
            prompt="回答问题",
            consumer_user_id=1,
        ):
            events.append(sse)
        
        # 应该成功完成
        done_events = [e for e in events if '"event": "done"' in e]
        assert len(done_events) == 1
        
        done_event = done_events[0]
        assert '"ok": true' in done_event
        assert "纯文本回复" in done_event


@pytest.mark.asyncio
async def test_nonstreaming_remote_call_artifacts():
    """非流式远程调用也应该处理产物"""
    
    with patch("dispatch_agent.pool") as mock_pool, \
         patch("dispatch_agent.db") as mock_db, \
         patch("dispatch_agent.invoke_worker_gateway") as mock_gateway, \
         patch("dispatch_agent._apply_artifacts") as mock_artifacts:
        
        mock_worker = MagicMock()
        mock_worker.user_id = 1
        mock_worker.worker_id = "w_remote"
        mock_pool.pick_agent_workers.return_value = [mock_worker]
        
        mock_db.deduct_credits = AsyncMock(return_value=(True, 100.0))
        mock_db.award_credits = AsyncMock()
        
        # Mock Gateway 返回包含本地路径的响应
        mock_gateway.return_value = {
            "id": "resp_batch",
            "status": "completed",
            "output": [
                {
                    "type": "message",
                    "role": "assistant",
                    "content": [
                        {
                            "type": "output_text",
                            "text": "文件：[下载](/home/user/output.pdf)",
                        }
                    ],
                }
            ],
            "artifacts": [
                {
                    "type": "file",
                    "path": "/home/user/output.pdf",
                    "name": "output.pdf",
                }
            ],
        }
        
        def mock_artifact_fn(task_id, output, raw_artifacts):
            processed_output = output.replace(
                "/home/user/output.pdf",
                f"/media/agent/{task_id}/output.pdf"
            )
            public_artifacts = [
                {
                    "type": "file",
                    "url": f"/media/agent/{task_id}/output.pdf",
                    "name": "output.pdf",
                }
            ]
            return processed_output, public_artifacts
        
        mock_artifacts.side_effect = mock_artifact_fn
        
        result = await handle_agent_task(
            assistant_id="file-agent",
            prompt="生成PDF",
            consumer_user_id=1,
        )
        
        # 验证：_apply_artifacts 应该被调用
        assert mock_artifacts.called
        
        # 验证：结果应该包含改写后的路径
        assert "/home/user/output.pdf" not in result["output"]
        assert "/media/agent/" in result["output"]
        assert "artifacts" in result
        assert result["artifacts"][0]["url"].startswith("/media/agent/")
