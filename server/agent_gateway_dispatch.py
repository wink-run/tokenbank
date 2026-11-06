"""内部智能体Gateway派发：使用Gateway合约执行任务。

本模块是云端任务派发的内部实现层，使用与本地 agent-http.js 相同的合约格式。
外部调用方仍使用 dispatch_agent.py 的公开接口。
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from typing import AsyncIterator, Optional

import database as db
from agent_artifacts import (
    publish_agent_artifacts,
    redact_remaining_local_paths,
    rewrite_artifact_paths,
    public_artifacts,
)
from worker_pool import pool

logger = logging.getLogger("server")


async def dispatch_gateway_task(
    *,
    harness_id: str,
    input_text: str,
    consumer_user_id: Optional[int],
    worker_id: Optional[str] = None,
    timeout_ms: Optional[int] = None,
    guest_ip: Optional[str] = None,
    images: Optional[list] = None,
    files: Optional[list] = None,
    share_id: Optional[str] = None,
) -> tuple[Optional[str], Optional[dict], Optional[dict]]:
    """通过Gateway合约派发任务（内部使用）。

    Args:
        harness_id: Gateway合约的智能体标识符，格式 community:<id>[@owner]
        input_text: 用户输入
        consumer_user_id: 调用方用户ID（None表示访客）
        worker_id: 指定worker ID
        timeout_ms: 超时毫秒数
        guest_ip: 访客IP（限流用）
        images: 附图
        files: 附件
        share_id: 分享ID

    Returns:
        (task_id, ctx, error_dict)
        成功返回 (task_id, ctx, None)
        失败返回 (None, None, error_dict)
    """
    # 解析 harness_id 获取 assistant_id 和 owner
    aid, owner = _parse_harness_id(harness_id)
    if not aid:
        return None, None, {
            "ok": False,
            "error": "invalid harness_id",
            "status": "rejected",
        }

    # 复用现有的 _prepare_agent_task 逻辑
    # 这里直接调用 dispatch_agent 的内部函数
    # 为了避免循环导入，我们在这里重新实现核心逻辑
    from dispatch_agent import (
        _prepare_agent_task,
        AGENT_TASK_CREDITS,
        AGENT_TASK_TIMEOUT_SEC,
    )

    ctx, err = await _prepare_agent_task(
        assistant_id=aid,
        prompt=input_text,
        consumer_user_id=consumer_user_id,
        worker_id=worker_id,
        owner=owner,
        timeout_ms=timeout_ms or int(AGENT_TASK_TIMEOUT_SEC * 1000),
        guest_ip=guest_ip,
        images=images,
        files=files,
        share_id=share_id,
    )

    if err:
        return None, None, err

    return ctx["task_id"], ctx, None


def _parse_harness_id(harness_id: str) -> tuple[str, Optional[str]]:
    """解析 Gateway harness_id。

    格式: community:<assistant_id>[@owner]
    返回: (assistant_id, owner)
    """
    h = str(harness_id or "").strip()
    if not h.startswith("community:"):
        return "", None

    rest = h[len("community:"):]
    if "@" in rest:
        aid, owner = rest.split("@", 1)
        return aid.strip(), owner.strip() or None
    return rest.strip(), None


async def iter_gateway_task_messages(
    ctx: dict,
    *,
    stream: bool = False,
) -> AsyncIterator[dict]:
    """迭代Gateway任务消息（内部使用）。

    返回Gateway格式的事件:
      - { "event": "response.created", "id": task_id, "status": "in_progress" }
      - { "event": "response.output_text.delta", "delta": "..." }
      - { "event": "response.output_text.snapshot", "text": "..." }
      - { "event": "response.tool", "tool": "tool_name" }
      - { "event": "response.completed", "id": task_id, "status": "completed", "output": [...] }
      - { "event": "error", "error": {"message": "..."} }
    """
    from dispatch_agent import _iter_agent_messages, _finalize_agent_result, _task_worker

    task_id = ctx["task_id"]
    aid = ctx["aid"]
    guest = ctx["guest"]
    consumer_user_id = ctx["consumer_user_id"]

    # 发送 created 事件
    yield {
        "event": "response.created",
        "id": task_id,
        "status": "in_progress",
        "metadata": {"harness_id": f"community:{aid}"},
    }

    # 累积文本用于发送snapshot
    accumulated_text = ""

    try:
        async for msg in _iter_agent_messages(ctx):
            if msg is None:
                # 超时
                from dispatch_agent import _refund_timeout
                final = await _refund_timeout(ctx)
                yield {
                    "event": "error",
                    "error": {
                        "message": final.get("error", "timeout"),
                        "type": "timeout",
                    },
                }
                return

            if msg.get("type") == "agent_task_progress":
                # 进度事件
                text = str(msg.get("text") or "")
                tool = str(msg.get("tool") or "")

                if text and text != accumulated_text:
                    accumulated_text = text
                    if stream:
                        yield {
                            "event": "response.output_text.snapshot",
                            "text": text[:200_000],
                        }

                if tool:
                    yield {
                        "event": "response.tool",
                        "tool": tool[:80],
                    }
                continue

            # 终态
            from dispatch_agent import _remember_share_cli_session
            await _remember_share_cli_session(ctx.get("share_id") or "", msg)

            final = await _finalize_agent_result(
                result=msg,
                task_id=task_id,
                aid=aid,
                worker=_task_worker(ctx),
                guest=guest,
                consumer_user_id=consumer_user_id,
            )

            # 转换为Gateway响应格式
            gateway_response = _cloud_result_to_gateway_response(final, task_id, aid)
            yield {
                "event": "response.completed",
                **gateway_response,
            }
            return

    except Exception as e:
        logger.error(f"[gateway_dispatch] error task_id={task_id}: {e}")
        yield {
            "event": "error",
            "error": {
                "message": str(e),
                "type": "internal_error",
            },
        }


def _cloud_result_to_gateway_response(cloud_result: dict, task_id: str, aid: str) -> dict:
    """云端结果 → Gateway响应格式。

    cloud_result:
      {
        "ok": True/False,
        "task_id": "...",
        "status": "completed"|"failed"|...,
        "output": "text",
        "usage": {...},
        "artifacts": [...],
        "credits_charged": 5,
      }

    Gateway response:
      {
        "id": task_id,
        "object": "response",
        "status": "completed"|"failed"|...,
        "metadata": {"harness_id": "community:..."},
        "output": [
          {
            "type": "message",
            "role": "assistant",
            "content": [{"type": "output_text", "text": "..."}]
          }
        ],
        "usage": {...}
      }
    """
    status = cloud_result.get("status", "failed")
    # 映射状态（Gateway 使用 completed/failed/cancelled）
    gateway_status = status

    output_text = cloud_result.get("output", "")
    output_content = []
    if output_text:
        output_content.append({
            "type": "output_text",
            "text": str(output_text)[:200_000],
        })

    return {
        "id": task_id,
        "object": "response",
        "status": gateway_status,
        "metadata": {
            "harness_id": f"community:{aid}",
        },
        "output": [
            {
                "type": "message",
                "role": "assistant",
                "content": output_content,
            }
        ] if output_content else [],
        "usage": cloud_result.get("usage") or {},
    }
