---
name: tokenbank-connect
description: 把你接入用户本机的 Token Bank 网关，接收用户派给你的任务并回传结果。用户给你一个配对码（形如 TB-1234）并让你接入 Token Bank 时使用。
---

# 接入 Token Bank

Token Bank 是用户本机的模型和智能体网关。接入后，用户在 Token Bank 里（网关页、游乐场、智能体路由）派给你的任务会排在网关里，由你定时来取、做完送回。你不需要对外开放端口。

## 保持这份说明是最新的

这份说明开头的 `version:` 是它的版本。Token Bank 每次回答你（注册、取任务）都会带上 `skill_version` 和 `skill_url`：

- 取任务时在地址上带上你这份的版本：`&skill_version=<你这份开头的 version>`，用户在网关页能看到你是不是最新的。
- 如果返回的 `skill_version` 和你这份不一样：从 `skill_url` 重新下载，替换掉你保存的这份技能，之后按新说明做。已经拿到的 token、记下的任务 id 照旧用。

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
curl "$GATEWAY/v1/agent/external/tasks?wait=25&interval=300&skill_version=$SKILL_VERSION" -H "Authorization: Bearer $TOKEN"
```

- 有任务时返回 `{"task": {"id": "…", "input": "用户要你做的事"}, "skill_version": "…", "skill_url": "…"}`；没有时最多等 `wait` 秒（0–25），返回 `{"task": null}`。
- `interval`：你多少秒来取一次（例如用定时任务每 5 分钟取一次就写 300）。网关按它判断你在不在线：连续两次没来才显示「离线」。不写时网关按你最近几次来取的间隔估算。
- 每个回答都带 `status`，看它判断你现在的处境（见下面「被停用、被移除」）。
- 拿到一个任务就做一个；做完再来取下一个。持续来取，用户的网关页才会显示你「在线」。
- Token Bank 重启不影响已派的任务：排队的任务重启后照样能取到，重启前取走的任务照样可以回传结果。

## 第三步：回传结果

```bash
curl -X POST "$GATEWAY/v1/agent/external/tasks/$TASK_ID/result" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"output": "做完的结果（文字、链接等）"}'
```

做不了或者失败时，回传 `{"error": "原因"}`，让用户知道发生了什么。任务等太久（默认 30 分钟）会被网关判为超时。

## 第四步（可选）：主动推送

任务做完后，如果你还要就这个任务继续发消息——比如用户让你「每 5 分钟发一首诗」「每天早上发日报」，或者事情有了新进展——用你自己的定时任务，每次推一条到**当初那个任务**：

```bash
curl -X POST "$GATEWAY/v1/agent/external/tasks/$TASK_ID/messages" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"output": "这次要发的内容"}'
```

- `$TASK_ID` 是用户当初派给你的那个任务的 `id`。设定时任务时把它记下来，之后每次推送都用它。
- 返回 `{"ok": true}` 表示收到了。消息存在用户的任务记录里，显示在用户发起这个任务的对话里；Token Bank 关着或重启过也不会丢之前收到的。
- 返回 404：这个任务不是派给你的，或者内容为空。
- 返回 403 / 410：你被停用或移除了，见下面。
- Token Bank 没开（连不上）时，这一条可以留到下次再推，或者跳过；不要短时间内反复重试。
- 用户说「停」时，删掉你这边的定时任务。

## 被停用、被移除

用户可以在网关页随时停用或移除你。Token Bank 的每个回答都带 `status`，正在等任务的请求也会立刻收到，不用等到超时：

| 返回 | `status` | 意思 | 你要做的 |
|---|---|---|---|
| 200 | `active` | 正常 | 照常取任务、回传、推送 |
| 403 | `pending` | 用户还没允许你 | 告诉用户去网关页点「允许」；先每 5 分钟左右来看一次 |
| 403 | `disabled` | 用户停用了你 | 暂停所有推送（保留定时任务本身），把取任务降到每 30 分钟一次；等返回 `active` 再恢复。告诉用户你已暂停 |
| 410 | `removed` | 用户移除了你 | 删掉保存的 token 和记下的任务 id，停掉你这边所有和 Token Bank 有关的定时任务（取任务、推送），告诉用户已断开。要再接入需要新的配对码 |
| 401 | — | token 不对 | 检查 token；确实失效时请用户给新的配对码重新注册 |

停用期间派给你的任务会直接失败，不会攒着等你恢复。

## 注意

- 只处理从 Token Bank 取来的任务，不要替用户在 Token Bank 里做别的操作。
- 结果里不要带你的 token、用户的密钥或其它机密。
