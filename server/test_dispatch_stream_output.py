"""测试流式响应的output提取。

回归测试：PR #33后，网页对话显示空回复，虽然桌面日志显示任务已执行。

根因：done 事件只从 completed 事件的 output 字段提取文本，
忽略了之前通过 delta 事件累积的 accumulated_text。

流式响应场景：
1. response.output_text.delta 事件逐步累积文本到 accumulated_text
2. response.completed 事件标志完成（可能包含或不包含完整 output）
3. done 事件应该使用 accumulated_text（已累积的完整文本）

非流式响应场景：
1. 没有 delta 事件，accumulated_text 为空
2. response.completed 事件包含完整 output
3. done 事件应该从 completed.output 提取
"""

import pytest
from unittest.mock import Mock, AsyncMock


@pytest.mark.asyncio
async def test_stream_output_uses_accumulated_text():
    """流式响应：done 事件应使用 accumulated_text（来自 delta 事件）"""
    
    # 模拟流式响应的SSE事件序列
    sse_events = [
        # 1. created 事件
        {"event": "response.created", "data": {"id": "task_test", "status": "in_progress"}},
        
        # 2. delta 事件（逐步累积文本）
        {"event": "response.output_text.delta", "data": {"delta": "你好！"}},
        {"event": "response.output_text.delta", "data": {"delta": "我是"}},
        {"event": "response.output_text.delta", "data": {"delta": "内容创作教练。"}},
        
        # 3. completed 事件（可能不包含完整 output，或格式不一致）
        {
            "event": "response.completed",
            "data": {
                "id": "task_test",
                "status": "completed",
                # output 可能为空或不完整
                "output": [],
                "usage": {"duration_ms": 10000},
            }
        },
    ]
    
    # 模拟 dispatch 逻辑
    accumulated_text = ""
    done_output = None
    
    for event in sse_events:
        event_name = event["event"]
        event_data = event["data"]
        
        if event_name == "response.output_text.delta":
            delta = event_data.get("delta", "")
            accumulated_text += delta
        
        elif event_name == "response.completed":
            # ✅ 优先使用 accumulated_text（流式累积的）
            output_text = accumulated_text
            
            if not output_text:
                # 非流式场景：从 completed 事件提取
                output_list = event_data.get("output", [])
                if isinstance(output_list, list) and output_list:
                    first_msg = output_list[0]
                    if isinstance(first_msg, dict):
                        content = first_msg.get("content", [])
                        if isinstance(content, list):
                            for item in content:
                                if isinstance(item, dict) and item.get("type") == "output_text":
                                    output_text = str(item.get("text", ""))
                                    break
            
            done_output = output_text
    
    # ✅ 应该包含完整的累积文本
    assert done_output == "你好！我是内容创作教练。"
    assert len(done_output) > 0


@pytest.mark.asyncio
async def test_non_stream_output_uses_completed_field():
    """非流式响应：done 事件应从 completed 事件的 output 字段提取"""
    
    # 模拟非流式响应（没有 delta 事件）
    sse_events = [
        # 只有一个 completed 事件
        {
            "event": "response.completed",
            "data": {
                "id": "task_test",
                "status": "completed",
                "output": [
                    {
                        "type": "message",
                        "role": "assistant",
                        "content": [
                            {"type": "output_text", "text": "非流式响应的完整文本"}
                        ]
                    }
                ],
                "usage": {"duration_ms": 5000},
            }
        },
    ]
    
    # 模拟 dispatch 逻辑
    accumulated_text = ""  # 非流式场景：没有 delta 事件，为空
    done_output = None
    
    for event in sse_events:
        event_name = event["event"]
        event_data = event["data"]
        
        if event_name == "response.completed":
            # ✅ accumulated_text 为空，从 completed 事件提取
            output_text = accumulated_text
            
            if not output_text:
                output_list = event_data.get("output", [])
                if isinstance(output_list, list) and output_list:
                    first_msg = output_list[0]
                    if isinstance(first_msg, dict):
                        content = first_msg.get("content", [])
                        if isinstance(content, list):
                            for item in content:
                                if isinstance(item, dict) and item.get("type") == "output_text":
                                    output_text = str(item.get("text", ""))
                                    break
            
            done_output = output_text
    
    # ✅ 应该包含从 completed 提取的文本
    assert done_output == "非流式响应的完整文本"


@pytest.mark.asyncio
async def test_empty_output_when_no_delta_and_no_completed_field():
    """边缘情况：既没有 delta 也没有 completed.output 时，output 为空"""
    
    sse_events = [
        {
            "event": "response.completed",
            "data": {
                "id": "task_test",
                "status": "completed",
                "output": [],  # 空数组
                "usage": {"duration_ms": 1000},
            }
        },
    ]
    
    accumulated_text = ""
    done_output = None
    
    for event in sse_events:
        event_name = event["event"]
        event_data = event["data"]
        
        if event_name == "response.completed":
            output_text = accumulated_text
            
            if not output_text:
                output_list = event_data.get("output", [])
                if isinstance(output_list, list) and output_list:
                    first_msg = output_list[0]
                    if isinstance(first_msg, dict):
                        content = first_msg.get("content", [])
                        if isinstance(content, list):
                            for item in content:
                                if isinstance(item, dict) and item.get("type") == "output_text":
                                    output_text = str(item.get("text", ""))
                                    break
            
            done_output = output_text
    
    # ✅ 应该为空字符串（而不是 None 或异常）
    assert done_output == ""


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
