"""通过WebSocket调用worker的本地Agent Gateway。

本模块使云端能够调用worker机器上的本地 agent-http.js Gateway处理器，
而不是直接通过自定义的 agent_task 消息格式派发。

这确保：
1. Gateway统计记录在worker端
2. 网页聊天和API调用共享同一代码路径
3. 无需worker暴露公开HTTP端点
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from typing import AsyncIterator, Optional

logger = logging.getLogger("server")

# 等待Gateway响应的超时时间
GATEWAY_RESPONSE_TIMEOUT_SEC = 620


async def invoke_worker_gateway(
    *,
    worker,
    method: str,
    path: str,
    body: dict,
    headers: Optional[dict] = None,
    timeout_sec: Optional[int] = None,
    initiator: Optional[str] = None,
) -> dict:
    """通过WebSocket调用worker的Gateway（非流式）。

    Args:
        worker: WorkerConnection对象
        method: HTTP方法（如 "POST"）
        path: Gateway路径（如 "/v1/agent/responses"）
        body: 请求body（dict）
        headers: 请求headers
        timeout_sec: 超时秒数

    Returns:
        Gateway响应 dict: {
            "status": 200,
            "headers": {...},
            "body": {...}
        }
    """
    request_id = f"gw-{uuid.uuid4().hex[:12]}"
    q: asyncio.Queue = asyncio.Queue()
    
    # 注册请求队列
    if not hasattr(worker, "pending_gateway"):
        worker.pending_gateway = {}
    worker.pending_gateway[request_id] = {"queue": q, "stream": False}

    try:
        # 添加发起方标识到 metadata（如果提供）
        final_body = body.copy()
        if initiator:
            if "metadata" not in final_body:
                final_body["metadata"] = {}
            final_body["metadata"]["app_id"] = initiator
        
        # 发送Gateway请求
        await worker.send({
            "type": "gateway_request",
            "request_id": request_id,
            "method": method,
            "path": path,
            "headers": headers or {},
            "body": final_body,
        })
        logger.info(
            "[gateway_ws] request %s %s worker=%s",
            method, path, getattr(worker, "worker_id", ""),
        )

        # 等待响应
        timeout = timeout_sec or GATEWAY_RESPONSE_TIMEOUT_SEC
        try:
            msg = await asyncio.wait_for(q.get(), timeout=timeout)
        except asyncio.TimeoutError:
            raise TimeoutError(f"Gateway request timeout ({timeout}s)")

        if msg.get("type") == "gateway_response":
            status = msg.get("status", 500)
            response_body = msg.get("body", {})
            
            if status >= 400:
                error_msg = response_body.get("error", {}).get("message", f"HTTP {status}")
                raise Exception(f"Gateway error: {error_msg}")
            
            return response_body
        
        raise Exception("Unexpected response type")

    finally:
        worker.pending_gateway.pop(request_id, None)


async def invoke_worker_gateway_stream(
    *,
    worker,
    method: str,
    path: str,
    body: dict,
    headers: Optional[dict] = None,
    timeout_sec: Optional[int] = None,
    initiator: Optional[str] = None,
) -> AsyncIterator[dict]:
    """通过WebSocket调用worker的Gateway（流式）。

    Yields:
        Gateway SSE事件 dict: {
            "event": "response.created"|"response.output_text.delta"|...,
            "data": {...}
        }
    """
    request_id = f"gw-{uuid.uuid4().hex[:12]}"
    q: asyncio.Queue = asyncio.Queue()
    
    # 注册请求队列
    if not hasattr(worker, "pending_gateway"):
        worker.pending_gateway = {}
    worker.pending_gateway[request_id] = {"queue": q, "stream": True}

    try:
        # 添加发起方标识到 metadata（如果提供）
        stream_body = {**body, "stream": True}
        if initiator:
            if "metadata" not in stream_body:
                stream_body["metadata"] = {}
            stream_body["metadata"]["app_id"] = initiator
        
        # 发送Gateway请求（stream: true）
        await worker.send({
            "type": "gateway_request",
            "request_id": request_id,
            "method": method,
            "path": path,
            "headers": headers or {},
            "body": stream_body,
        })
        logger.info(
            "[gateway_ws] stream_request %s %s worker=%s",
            method, path, getattr(worker, "worker_id", ""),
        )

        # 迭代SSE事件
        timeout = timeout_sec or GATEWAY_RESPONSE_TIMEOUT_SEC
        deadline = time.time() + timeout
        
        while time.time() < deadline:
            remaining = max(0.1, deadline - time.time())
            try:
                msg = await asyncio.wait_for(q.get(), timeout=remaining)
            except asyncio.TimeoutError:
                raise TimeoutError(f"Gateway stream timeout ({timeout}s)")

            msg_type = msg.get("type")
            
            if msg_type == "gateway_sse":
                # SSE事件
                yield {
                    "event": msg.get("event"),
                    "data": msg.get("data", {}),
                }
            
            elif msg_type == "gateway_stream_end":
                # 流结束
                return
            
            elif msg_type == "gateway_response":
                # 非流式响应（worker可能不支持流式）
                status = msg.get("status", 500)
                response_body = msg.get("body", {})
                
                if status >= 400:
                    error_msg = response_body.get("error", {}).get("message", f"HTTP {status}")
                    yield {
                        "event": "error",
                        "data": {"error": {"message": error_msg}},
                    }
                else:
                    # 转为 completed 事件
                    yield {
                        "event": "response.completed",
                        "data": response_body,
                    }
                return

    finally:
        worker.pending_gateway.pop(request_id, None)


def handle_worker_gateway_message(worker, msg: dict) -> None:
    """处理worker发来的Gateway响应消息。

    在 WebSocket 消息循环中调用此函数。
    """
    msg_type = msg.get("type")
    if msg_type not in ("gateway_response", "gateway_sse", "gateway_stream_end"):
        return

    request_id = msg.get("request_id")
    if not request_id:
        return

    if not hasattr(worker, "pending_gateway"):
        return

    entry = worker.pending_gateway.get(request_id)
    if not entry:
        return

    q = entry.get("queue")
    if q is None:
        return

    # 将消息放入队列
    try:
        q.put_nowait(msg)
    except asyncio.QueueFull:
        logger.warning(
            "[gateway_ws] queue full request_id=%s worker=%s",
            request_id, getattr(worker, "worker_id", ""),
        )
