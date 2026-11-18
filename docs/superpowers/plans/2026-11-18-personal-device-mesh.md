# 本人设备纳管 + 模型与智能体统一入口 · 实现方案

> 状态：**方案，待评审，未开始开发**
> 基线：`main` @ 17ee836
> 设计：[个人设备对等互联设计](../specs/2026-11-18-personal-device-mesh-design.md)（以下简称「设计」）

**目标**：本人名下的所有设备组成一张对等网络。任何一台设备的本地网关都是统一入口，用同一套接口调用任何一台设备上的模型和智能体，调用方不用关心东西装在哪台机器上。

**做法一句话**：设备之间建一条加密隧道，隧道里跑的就是**现有本地网关的 HTTP 接口**。调用别的设备，等于调用那台设备自己的 `:11430`。

**技术栈**：Electron 主进程 / CLI 网关（Node 22）、`@number0/iroh`（napi）、better-sqlite3、React 18、`node:test`。

---

## 0. 结合最新代码的判断

### 0.1 现有能力（main @ 17ee836）

| 能力 | 位置 | 对本方案的意义 |
|---|---|---|
| 模型统一入口 `/v1/chat/completions`、`/v1/messages`、`/v1/models` | `local-gateway.js:4479` 起 | 直接作为远端执行接口 |
| 智能体统一入口 `/v1/agent/responses`、`/v1/agent/harnesses` | `agent-http.js` | 同上 |
| **异步任务**：`background: true` 立即返回任务号，`GET /v1/agent/responses/{id}` 查结果，幂等键重放 | `agent-http.js`（17ee836 新增） | 跨设备长任务直接用它，**不必另写任务协议** |
| 空闲超时 + 硬超时、`onStep` / `onProgress` 回调 | `agent-executor.js:1002` | 发起端等远端任务的语义现成 |
| 任务持久化（`agent_tasks` 表）、`listTodayTasks` | `agent-executor.js` | 远端任务记录天然在执行设备上 |
| 虚拟供给源模式：P2P 源在 `enabledProviders()` 里动态生成 `base_url` 和模型清单 | `local-gateway.js:660` | 「我的设备」照这个模式加一类源 |
| 防转发回环头 `x-p2p-hop` | `local-gateway.js:4598` | 照这个模式加 `x-tb-mesh-hop` |
| 外部智能体（Muse、GrokBot）配对后来本机网关取任务 | `external-agents.js`、`/v1/agent/external/*` | 保持现状。接入任一设备后，就能经设备网络把活派到其他设备 |
| 智能体专属 Key（`tbk_…`）、网关 Key（`_agentApiKey`）、应用 Key | `agent-keys.js`、`local-gateway.js:4618` | 隧道请求用新增的「设备网络 Key」鉴权 |
| 设备盘点心跳 | `useDeviceReporter.js`、`device_router.py` | 加字段，承载地址簿 |

### 0.2 对设计的两处简化

1. **设计 §8.3 的自定义任务帧，改为「HTTP 走隧道」**。远端收到隧道请求后，原样转给自己的本地网关。提交、进度（SSE）、取消、查询、幂等全部复用 `agent-http.js`；模型流式输出复用 `proxyRequest`。新写的代码集中在隧道、身份、目录、调度四块。
2. **设计 §8.4 的产出操作，改为远端网关新增几个 HTTP 接口**（`/v1/agent/responses/{id}/bundle`、`/v1/workspace/*`），同样走隧道。

设计文档的 §8.3 / §8.4.7 加注指向本方案，其余不变。

---

## 1. 架构

```
调用方（本机应用 / 外部智能体 / 游乐场 / MCP）
        │  同一套接口：/v1/models · /v1/chat/completions · /v1/agent/harnesses · /v1/agent/responses · /v1/devices
        ▼
设备 A 本地网关 :11430
  ├─ 模型路由：本机 → 我的设备 → 免费 → 社区 → 付费        （「我的设备」= mesh 虚拟源）
  ├─ 智能体：mine:<目标>[@设备] → 本地调度选设备
  └─ mesh 模块
        ├─ 回环代理 127.0.0.1:<随机端口>/peer/<device_id>/…  ← 网关把请求发到这里
        └─ iroh 节点 ══ QUIC（直连 / TokenBank 中继）══╗
                                                       ║
设备 B mesh 模块 ◀══════════════════════════════════════╝
  └─ 校验证书 → 加上 X-TB-Mesh-From、设备网络 Key、x-tb-mesh-hop:1 → 转给本机 127.0.0.1:11430
设备 B 本地网关：本人模式执行（完整权限）
```

**关键约束**

- 隧道只转发到对端的 `127.0.0.1:<网关端口>`，并且只放行白名单路径（§3.3），不能当通用代理。
- 带 `x-tb-mesh-hop` 的请求在对端不再进入设备网络（模型路由跳过「我的设备」，`mine:` 目标直接拒绝），杜绝回环。

---

## 2. 文件结构

**新建**

| 文件 | 职责 |
|---|---|
| `client/electron/mesh/index.js` | 生命周期：`start({ getConfig, getUserJwt, gatewayPort })` / `stop()` / `status()` |
| `client/electron/mesh/identity.js` | 设备密钥、证书申请和续期、对端证书校验、吊销列表 |
| `client/electron/mesh/transport.js` | iroh endpoint、连接池、按 ALPN 分流；只有这个文件直接依赖 `@number0/iroh` |
| `client/electron/mesh/tunnel.js` | 发起侧回环代理；接收侧转发到本机网关；HTTP 帧与 QUIC 流互转（含 SSE） |
| `client/electron/mesh/directory.js` | 本机描述生成、`presence` 广播、对端描述合并、设备目录查询 |
| `client/electron/mesh/scheduler.js` | 纯函数：按目标、工作区、负载、延迟选设备 |
| `client/electron/mesh/workspaces.js` | 命名工作区读写、名字 → 路径、仓库标识 |
| `client/electron/mesh/policy.js` | 本机接活开关、并发、降权 |
| `client/electron/mesh/git-bundle.js` | 设计 §8.4.3：临时索引提交、生成和导入 bundle |
| `client/electron/__tests__/mesh-*.test.js` | 纯逻辑单测（见各任务） |
| `client/src/pages/Devices.jsx`（或 Profile 设备区块改版） | 设备纳管页 |
| `server/mesh_router.py` | `/mesh/cert`、`/mesh/revocations`、`/mesh/peers` |
| `server/mesh_cert.py` | 证书签发和校验（Ed25519） |
| `deploy/iroh-relay/`、`docker-compose.yml` 新增服务 | TokenBank 中继 |

**修改**

| 文件 | 改动 |
|---|---|
| `client/electron/local-gateway.js` | `enabledProviders()` 加 mesh 虚拟源；`/v1/models` 合并远端模型；`x-tb-mesh-hop` 跳过；设备网络 Key 进 `knownKey`；新增 `/v1/devices` |
| `client/electron/agent-http.js` | `listHarnesses()` 加 `mine:*`；`resolveHarness()` 识别 `mine:`；本人模式 `call_context=owner`；新增 bundle、workspace 接口 |
| `client/electron/agent-executor.js` | `_dispatchMeshAndWait()`（与 `_dispatchCommunityAndWait` 并列）；`mode:'mesh'` 传完整权限参数 |
| `client/electron/agent-routes.js` | 候选名单支持「我的设备」，默认纳入 |
| `client/electron/agent-dispatch-mcp.js` | `tb_list_agents` 含 `mine:*`；新增 `tb_list_devices` |
| `client/electron/main.js`、`client/cli/gateway.js` | 登录后启动 mesh，退出登录或删除设备时停止 |
| `client/electron/preload.js`、`ipc-handlers-*.js` | 设备页 IPC |
| `client/src/hooks/useDeviceReporter.js`、`server/device_router.py` | 心跳带 `mesh` 字段 |
| `client/electron/local-stats.js` | `route='mesh'`、`from_device` / `to_device` 列 |
| `server/server.py` | 挂载 `mesh_router` |

---

## 3. 统一入口：接口约定

### 3.1 模型

| 写法 | 行为 |
|---|---|
| `model: "qwen3-32b"` | 照常走降级链；本机没有时，在「我的设备」层找有这个模型的设备 |
| `model: "mine:mac-mini/qwen3-32b"` | 钉到指定设备，不降级 |

- `/v1/models` 额外列出远端独有的模型，`owned_by: "mine:<设备名>"`；同名模型只列一次。
- 「我的设备」层排在本机之后、免费层之前；不计费、不扣积分，`tier='mine'`。
- 流式输出：首个 token 到达前失败，自动换下一台设备；已经开始输出后失败，原样报错。

### 3.2 智能体

| `harness_id` | 行为 |
|---|---|
| `mine:codex` / `mine:claude-code` / … | 在装了这个应用的设备里自动选 |
| `mine:codex@mac-mini` | 指定设备 |
| `mine:assistant:<id>` | 某个智能体资源 |
| `mine:session:<agent>:<id>` | 续接某个会话，自动落到它所在的设备 |

请求体其余部分和现在一样，额外支持 `metadata.workspace`（工作区名字）。`background: true`、`stream: true`、幂等键、`GET /v1/agent/responses/{id}`、`/cancel` 全部照旧。

远端任务的任务号写成 `mesh:<device_id>:<远端任务号>`，查询和取消时据此找到那台设备。

### 3.3 设备

| 接口 | 说明 |
|---|---|
| `GET /v1/devices` | 设备目录：在线状态、连接方式、延迟、应用、智能体、模型、工作区、最近会话、负载 |
| `GET /v1/devices/{id}` | 单台设备详情 |

### 3.4 隧道白名单（对端只接受这些路径）

`/v1/models`、`/v1/chat/completions`、`/v1/messages`、`/v1/agent/harnesses`、`/v1/agent/responses`（含 `/{id}`、`/{id}/cancel`、`/{id}/bundle`）、`/v1/workspace/*`、`/mesh/presence`（内部）。

---

## 4. 任务分解

每个任务结束都要能单独验证。纯逻辑用 `node --test`；涉及 Electron、better-sqlite3、真实网络的，用两台设备手动验证（理由同 `2026-06-20-session-manager.md`：better-sqlite3 在纯 node 下加载不了）。

### M0 · 技术验证（约 1 周，产出验证报告，不进主干）

**Task 0.1　iroh 绑定能力验证**
- 在 macOS arm64、Windows x64、Linux x64 各跑一个最小程序，逐项确认：
  1. 自定义 ALPN；
  2. 指定中继地址（指向临时部署的 `iroh-relay`）；
  3. 关闭 n0 DNS 发现；
  4. 局域网 mDNS 发现；
  5. 读取连接方式（直连 / 中继）和往返延迟；
  6. 双向流吞吐（目标：局域网 ≥ 50 MB/s，中继 ≥ 5 MB/s）；
  7. 在 Electron 主进程里加载 napi 模块，并通过签名和公证。
- 判定：全部通过就用 napi 绑定；第 1、2、3、7 项任一不过，转后备方案（Rust 独立进程，见设计 §13.1）。

**Task 0.2　中继部署验证**
- `iroh-relay` 跑在现有服务器上，nginx 反代 443；验证「只允许持有效证书的 endpoint 接入」怎么实现（iroh-relay 的访问控制回调，或在 nginx 层按 token 拦）。

**Task 0.3　隧道原型**
- 两台设备之间，用 QUIC 流承载一次 `/v1/chat/completions` 流式请求和一次 `/v1/agent/responses`（`background: true` 再轮询）请求，确认 SSE 不被缓冲。

### M1 · 身份、入网、设备纳管

**Task 1.1　云端证书服务**（`server/mesh_cert.py`、`server/mesh_router.py`）
- `POST /mesh/cert`：JWT 鉴权；请求带 `device_id`、`endpoint_id`、challenge 签名；校验 `device_id` 属于该用户（复用 `db.get_device_owner`）；签发设计 §5.2 的证书（含预留字段，`scope` 固定为 `self`）。
- `GET /mesh/revocations`：返回签名后的吊销列表。
- `DELETE /device/{id}` 改为同时吊销该设备的 `endpoint_id`。
- 签名私钥从环境变量 `MESH_SIGNING_KEY` 读，公钥写死进客户端（支持多把）。
- 测试：`server/test_mesh_cert.py`，覆盖签发、过期、设备不属于本人、吊销。

**Task 1.2　设备身份**（`mesh/identity.js`）
- `loadOrCreateKey()`：`~/.tokenbank/mesh/secret.key`，0600。
- `ensureCert()`：没有证书或剩余有效期不足 2 天时去续。
- `verifyPeerCert(cert, handshakeEndpointId, selfUserId, revoked)`：纯函数。
- 测试：`mesh-identity.test.js`，覆盖签名错误、过期、`sub` 不同、`endpoint_id` 不匹配、未知 `scope`、已吊销。

**Task 1.3　传输与入网**（`mesh/transport.js`、`mesh/index.js`）
- 登录后启动：创建 endpoint（ALPN `tokenbank/mesh/1`，中继用 TokenBank 地址，关闭 n0 发现，打开 mDNS）。
- 连接后第一件事是交换证书，校验不过立即断开。
- 和本账号所有在线设备两两保持连接，断线指数退避重连。
- `main.js` 在登录成功后调用 `mesh.start()`，退出登录时调用 `mesh.stop()`；`cli/gateway.js` 同样处理。

**Task 1.4　地址簿**
- 心跳 `stats.mesh = { endpoint_id, relay_url, direct_addrs }`；`device_router.py` 存进设备记录。
- `GET /mesh/peers`：只返回本账号设备的这三项。
- 节点启动时、以及连接失败时拉一次。

**Task 1.5　设备目录**（`mesh/directory.js`）
- `buildSelfDescriptor()`：汇总 `executor.listAvailableAgents()`（应用、智能体）、本机模型清单（`buildDefaultModelList()` 去掉 P2P 和 mesh 来源）、工作区名字、`session-browser.listAllSessions()` 最近 20 条、当前负载、`policy.accepts`。**不含路径和密钥。**
- 连接建立时整份交换；本机变化时（装卸应用、改工作区、任务开始或结束）带 `seq` 推送增量；断线标离线，保留最后一次描述。
- 测试：`mesh-directory.test.js`，覆盖描述里不出现路径、`seq` 乱序丢弃、离线保留。

**Task 1.6　设备纳管页**
- 列出本人所有设备（盘点数据 ∪ 设备目录），每台显示：在线 / 离线（多久前）、连接方式（局域网直连 / 打洞 / 中继）、延迟、版本、应用、智能体、模型、工作区、正在跑的任务。
- 本机操作：改设备名、设优先级、接活开关、最大并发、降权、管理工作区（「从最近项目添加」）。
- 对其他设备：查看详情；删除（即吊销）。远程修改别的设备的配置不在一期范围。
- `/v1/devices` 和页面用同一份数据。

**M1 验收**：两台设备登录后 30 秒内互相出现在设备页；拔网线后另一台在 10 秒内显示离线；删除设备后，被删设备的连接被拒绝。

### M2 · 隧道与智能体统一入口

**Task 2.1　隧道**（`mesh/tunnel.js`）
- 发起侧：回环 HTTP 代理，监听 `127.0.0.1:0`；路径 `/peer/<device_id>/<原路径>`；每个请求开一条 QUIC 双向流，先发请求头帧，再流式转发请求体和响应体。
- 接收侧：校验路径白名单（§3.4）→ 加 `X-TB-Mesh-From: <对端 device_id>`、`Authorization: Bearer <设备网络 Key>`、`x-tb-mesh-hop: 1` → 转发到 `127.0.0.1:<本机网关端口>`。
- 设备网络 Key：每次启动随机生成，只存在内存里，由 `local-gateway.js` 的 `knownKey` 认可；外部拿不到。
- 测试：`mesh-tunnel.test.js`，用内存双工流代替 QUIC，覆盖白名单拦截、头部注入、SSE 分块不合并、对端断开时向调用方报 502。

**Task 2.2　本人模式**（`agent-http.js`、`agent-executor.js`）
- 带设备网络 Key 和 `X-TB-Mesh-From` 的请求：`call_context = 'owner'`，不过 `hire-guard`、不脱敏、不计积分。
- `mode: 'mesh'` 时按应用传完整权限参数（Claude Code `--permission-mode bypassPermissions`；Codex `--sandbox danger-full-access` 加不弹审批；其余应用用各自的全允许档），本机 `policy` 降权时改传对应档位。
- `metadata.workspace` → `workspaces.resolve(name)` 得到 `workingDir`；没传时用默认工作区，再没有就用家目录（设计 §9.1）。
- 带 `x-tb-mesh-hop` 的请求遇到 `mine:` 目标直接返回 409（防回环）。

**Task 2.3　调度**（`mesh/scheduler.js`）
- 纯函数 `pickDevice({ target, workspace, pinned, directory, selfId, priorities })`，规则见设计 §8.2：显式指定 > 会话所在设备 > 本机 > 优先级 > 负载 > 直连优先、延迟低优先。
- 没有可用设备时返回原因（离线、没装该应用、没有该工作区、满负载）。
- 测试：`mesh-scheduler.test.js`，逐条覆盖排序规则和失败原因。

**Task 2.4　`mine:` 寻址**（`agent-http.js`、`agent-executor.js`）
- `listHarnesses()`：对设备目录里每个在线设备的应用和智能体，输出 `mine:<id>` 和 `mine:<id>@<设备名>`，`kind: 'mine'`，带 `devices` 字段。
- `resolveHarness()`：`mine:` 前缀交给 `_dispatchMeshAndWait`。
- `_dispatchMeshAndWait()`：
  1. 调度选设备；选到本机就退回本地执行；
  2. 经隧道 `POST /peer/<id>/v1/agent/responses`，带 `background: true` 和幂等键；
  3. 任务号记成 `mesh:<device_id>:<远端任务号>`，写进本地 `agent_tasks`，便于 `GET /v1/agent/responses/{id}` 和游乐场展示；
  4. 等待：带 `stream: true` 时直接透传远端 SSE；否则按 `dispatchAndWait` 的空闲 / 硬超时轮询远端 `GET`，每次有新进展就推后空闲计时，并触发 `onStep` / `onProgress`；
  5. 隧道断了就重连后用同一幂等键续查；超过硬超时仍连不上，标记 `uncertain`。
- `GET /v1/agent/responses/mesh:…`、`/cancel`：按任务号前缀转到对应设备。

**Task 2.5　Agent 路由和 MCP**
- `agent-routes.js`：`candidates` 为 `null` 时包含 `mine:*`；路由编辑页可勾选「我的设备」。
- `agent-dispatch-mcp.js`：`tb_list_agents` 输出 `mine:*`，描述里写明「在你的其他设备上执行」；新增 `tb_list_devices`。
- 外部智能体（Muse 等）不改：它派到本机网关的任务，主智能体或路由照样可以用 `mine:` 派出去。

**Task 2.6　产出**（设计 §8.4）
- 小文本文件随 `task.result` 返回（远端 `collectWorkspaceArtifacts` 已有）。
- `mesh/git-bundle.js`：开工前记录 `base`；结束后用临时索引生成提交写入 `refs/tokenbank/mesh/<task_id>`；`GET /v1/agent/responses/{id}/bundle` 输出 bundle 流。
- 发起端「拉取改动」：按仓库标识找本机仓库 → `git bundle verify` → fetch 到 `tb/mesh/<task_id>` 分支。
- `GET /v1/workspace/{name}/fs?path=`、`/file?path=&offset=&limit=`、`/diff`、`/log`：只读，路径限定在工作区内（解析软链接之后再判断）。
- 测试：`mesh-git-bundle.test.js`，在临时仓库里验证工作区和暂存区不变、`.gitignore` 生效、bundle 可导入、缺少 `base` 时给出明确错误（命令序列已在 git 2.43 手动验证过）。

**Task 2.7　统计**
- `local-stats` 新增 `route='mesh'`、`from_device`、`to_device`；两端各记一条，用任务号关联。
- 网关页路由明细显示「→ mac-mini」。

**M2 验收**
1. 在 A 上 `POST /v1/agent/responses`，`harness_id: "mine:codex@mac-mini"`、`metadata.workspace: "tokenbank"`，B 在 `~/code/tokenbank` 里以完整权限执行。
2. 同一请求加 `background: true`，立刻拿到任务号；关掉 A 的网络 1 分钟再恢复，`GET` 能拿到完整结果。
3. 取消有效；B 上的进程被结束。
4. A 上「拉取改动」后出现 `tb/mesh/<task_id>` 分支，A 的当前分支不变。
5. 从 B 发往 A 的 `mine:` 请求同样可用（对等）。

### M3 · 模型统一入口

**Task 3.1　mesh 虚拟源**（`local-gateway.js`）
- `enabledProviders()` 增加 `type: 'mesh'` 的虚拟源，每台在线设备一个：`base_url = <回环代理>/peer/<device_id>/v1`、`models = 该设备本机的模型`、`token = 设备网络 Key`。
- 降级链排序：本机 → mesh → 免费 → 社区 P2P → 付费；`x-tb-mesh-hop` 请求跳过 mesh 源。
- `providerHasModel` 对 mesh 源用严格匹配（和 P2P 一样，不能因为清单为空就匹配任意模型）。
- 接收侧默认不接模型请求（`policy.accepts.model_requests=false`），设备页打开后才上报模型清单。

**Task 3.2　`/v1/models` 与钉设备**
- 合并远端模型；`mine:<设备>/<模型>` 写法直接选中该设备的 mesh 源。

**Task 3.3　失败切换**
- 复用 `isSourceLevelError` 和冷却逻辑（`gateway-cooldown`）：首个 token 前出错，换下一台设备或下一层。

**M3 验收**：A 没有的本地模型，在 A 上调用时由 B 返回，流式不卡顿；B 关机后自动落到下一层；路由明细能看到每次落在哪台设备。

### M4 · 体验增强（按需）

- `mine:session:` 续接会话（设备目录里已有会话列表，远端用 `continueSession` + `cliSessionId`）。
- 局域网专用模式：断网时只靠 mDNS，用证书剩余有效期离线校验。
- Dashboard「发起设备 → 执行设备」维度。
- 设备页远程修改其他设备配置（经隧道调用对端管理接口）。

---

## 5. 安全检查清单

- [ ] 证书校验失败、`sub` 不同、已吊销、未知 `scope`：连接立即断开，不回任何内容。
- [ ] 隧道只转发白名单路径，只到对端的 `127.0.0.1`，不能用来访问对端局域网的其他地址。
- [ ] 设备网络 Key 只在内存里，每次启动更换；普通调用方拿不到，也不能伪造 `X-TB-Mesh-From`（由接收侧在校验证书后填写，外来同名头一律剥掉）。
- [ ] 工作区和远程查看接口解析软链接之后再判断是否在工作区内。
- [ ] 设备目录和地址簿里不出现本机路径、密钥、prompt。
- [ ] 雇佣链路（贡献 worker）不受影响：圈子和社区仍按现有审查、沙箱、脱敏、积分执行。

---

## 6. 估算与排期（单人全职粗估）

| 阶段 | 工作量 | 可并行 |
|---|---|---|
| M0 | 1 周 | 0.1 / 0.2 / 0.3 可并行 |
| M1 | 2 周 | 云端（1.1、1.4）和客户端（1.2、1.3、1.5）并行，1.6 最后 |
| M2 | 2.5 周 | 2.1 → 2.2 / 2.3 并行 → 2.4 → 2.5 / 2.6 / 2.7 并行 |
| M3 | 1 周 | — |
| 合计 | 约 6.5 周到可用的 M3 | M4 另计 |

## 7. 待定（不阻塞开始 M0）

1. 设备纳管页做成独立页面，还是在现有 Profile「多设备盘点」区块上改版。
2. 产出文件是否在任务结束时另存快照（设计 §15 第 1 条）。
3. 跨境设备走单区域中继的延迟能否接受（设计 §15 第 2 条，M0 实测后再定）。
