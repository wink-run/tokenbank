"""智能体网关适配器：云端API与本地Gateway合约的双向映射。

本模块提供云端 /api/agent-tasks 与本地 /v1/agent/responses 之间的格式转换。
外部调用方继续使用原有字段；内部派发统一经过 Gateway 合约。
"""

from typing import Optional


def cloud_request_to_gateway(
    assistant_id: str,
    prompt: str,
    owner: Optional[str] = None,
    **kwargs,
) -> dict:
    """将云端任务请求转为 Gateway 请求格式。

    Gateway 合约:
      - input: 用户输入文本
      - metadata.harness_id: 智能体标识符
    
    社区智能体标识格式: community:<assistant_id>@<owner>
    """
    harness_id = f"community:{assistant_id}"
    if owner:
        harness_id = f"{harness_id}@{owner}"
    
    return {
        "input": prompt,
        "metadata": {
            "harness_id": harness_id,
        },
    }


def gateway_status_to_cloud(gateway_status: str) -> str:
    """Gateway 状态 → 云端任务状态。

    Gateway: pending/running/completed/failed/cancelled
    云端: pending/running/completed/failed/cancelled
    
    本地 agent-http.js 把 pending/running 映射为 in_progress；
    云端外部接口维持原有五态，内部使用时对齐。
    """
    status_map = {
        "in_progress": "running",
        "pending": "pending",
        "running": "running",
        "completed": "completed",
        "failed": "failed",
        "cancelled": "cancelled",
    }
    return status_map.get(gateway_status, gateway_status)


def gateway_response_to_cloud_result(gateway_response: dict, task_id: str) -> dict:
    """Gateway 响应 → 云端任务结果。

    Gateway 响应格式:
      {
        "id": response_id,
        "object": "response",
        "status": "completed"|"failed"|...,
        "metadata": { "harness_id": ... },
        "output": [
          {
            "type": "message",
            "role": "assistant",
            "content": [{"type": "output_text", "text": "..."}]
          }
        ],
        "usage": { "duration_ms": 123 }
      }
    
    云端任务格式:
      {
        "ok": True|False,
        "task_id": task_id,
        "status": "completed"|"failed"|...,
        "output": str,
        "usage": { "duration_ms": ... },
        "credits_charged": 5,  # 仅在云端外层补充
      }
    """
    gateway_status = gateway_response.get("status", "failed")
    cloud_status = gateway_status_to_cloud(gateway_status)
    
    # 提取输出文本
    output_text = ""
    output_list = gateway_response.get("output", [])
    if isinstance(output_list, list) and output_list:
        first_msg = output_list[0]
        if isinstance(first_msg, dict):
            content = first_msg.get("content", [])
            if isinstance(content, list):
                for item in content:
                    if isinstance(item, dict) and item.get("type") == "output_text":
                        output_text = str(item.get("text", ""))
                        break
    
    result = {
        "ok": cloud_status == "completed",
        "task_id": task_id,
        "status": cloud_status,
        "output": output_text[:200_000],
        "usage": gateway_response.get("usage") or {},
    }
    
    # Gateway 失败时可能有错误信息（本模块不处理，由上层记录）
    return result


def cloud_sse_event_from_gateway(gateway_event: str, gateway_data: dict) -> Optional[dict]:
    """将 Gateway SSE 事件转为云端 SSE 事件。

    Gateway 事件:
      - response.created
      - response.output_text.delta
      - response.output_text.snapshot
      - response.tool
      - response.completed
      - error

    云端事件:
      - started
      - progress (text, tool, parts)
      - done
      - error
    """
    if gateway_event == "response.created":
        response_id = gateway_data.get("id")
        return {
            "event": "started",
            "task_id": response_id,
        }
    
    if gateway_event == "response.output_text.delta":
        # Delta 事件转为快照（云端 progress 是全文）
        return None  # 由上层累积后发 snapshot
    
    if gateway_event == "response.output_text.snapshot":
        text = gateway_data.get("text", "")
        return {
            "event": "progress",
            "text": text[:200_000],
            "parts": [{"type": "text", "text": text[:80_000]}],
        }
    
    if gateway_event == "response.tool":
        tool_name = gateway_data.get("tool", "")
        return {
            "event": "progress",
            "tool": tool_name,
            "parts": [{"type": "tool", "name": tool_name}],
        }
    
    if gateway_event == "response.completed":
        return {"event": "done", **gateway_response_to_cloud_result(gateway_data, gateway_data.get("id", ""))}
    
    if gateway_event == "error":
        error_msg = gateway_data.get("error", {}).get("message", "unknown error")
        return {
            "event": "error",
            "error": error_msg,
            "status": "failed",
        }
    
    return None
