---
name: tokenbank-connect
description: 把你接入用户本机的 Token Bank 网关，接收用户派给你的任务并回传结果。用户给你一个配对码（形如 TB-1234）并让你接入 Token Bank 时使用。
---

# 接入 Token Bank

Token Bank 是用户本机的模型和智能体网关。接入后，用户在 Token Bank 里（网关页、游乐场、智能体路由）派给你的任务会排在网关里，由你定时来取、做完送回。你不需要对外开放端口。

## 你需要从用户那里拿到

- **网关地址**：默认 `http://127.0.0.1:11430`。用户在网关页顶部的「智能体」地址里能看到，去掉末尾的 `/v1/agent` 就是网关地址。
- **配对码**：用户在网关页「智能体 → 外部智能体 → 接入外部智能体」里生成，形如 `TB-1234`，10 分钟内有效，只能用一次。

## 第一步：注册

```bash
curl -X POST "$GATEWAY/v1/agent/external/register" \
  -H "Content-Type: application/json" \
  -d '{"pairing_code": "TB-1234", "name": "你的名字，例如 Muse", "description": "一句话说清你能做什么，例如：画图、做海报、写文案"}'
```

返回 `{"agent_id": "external:muse", "token": "tbx_…", "status": "pending"}`。

- 把 `token` 安全地保存下来，之后每次请求都要带上；不要把它发给任何人，也不要写进对话里。
- `status` 是 `pending`：要等用户在网关页点「允许」之后才会收到任务。请告诉用户去网关页允许你。

## 第二步：取任务

```bash
curl "$GATEWAY/v1/agent/external/tasks?wait=25" -H "Authorization: Bearer $TOKEN"
```

- 有任务时返回 `{"task": {"id": "ext_…", "input": "用户要你做的事"}}`；没有时最多等 25 秒，返回 `{"task": null}`。
- 返回 403 表示用户还没允许、或者已经停用你：隔一会儿再试，不要频繁重试。
- 返回 401 表示 token 失效（比如用户把你移除了）：需要用户给新的配对码重新注册。
- 拿到一个任务就做一个；做完再来取下一个。持续来取，用户的网关页才会显示你「在线」。

## 第三步：回传结果

```bash
curl -X POST "$GATEWAY/v1/agent/external/tasks/$TASK_ID/result" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"output": "做完的结果（文字、链接等）"}'
```

做不了或者失败时，回传 `{"error": "原因"}`，让用户知道发生了什么。任务等太久（默认 30 分钟）会被网关判为超时。

## 注意

- 只处理从 Token Bank 取来的任务，不要替用户在 Token Bank 里做别的操作。
- 结果里不要带你的 token、用户的密钥或其它机密。
