# 本人设备互联 · 需求与任务清单

> 更新：2026-11-19
> 分支：`claude/personal-device-mesh-prototype`（基于 `main` @ 17ee836，8 个提交，**尚未推送**）
> 相关：[设计](../specs/2026-11-18-personal-device-mesh-design.md) · [实现方案](./2026-11-18-personal-device-mesh.md) · [原型说明](../../client/electron/mesh/README.md) · [界面原型](https://claude.ai/artifact/TwJj1AJ8ePH6N5JNHfrhAa)

状态：✅ 原型已完成　🟡 部分完成　⬜ 未开始　❓ 待决定

---

## 一、已定的决定

| # | 决定 |
|---|---|
| D1 | 本人设备对等互联：每台设备装同一套节点，任何一台都能发起、都能执行；调度在发起设备本地完成 |
| D2 | 云端只做控制面：登录、设备证书、地址簿、加密中继；任务和内容不经过云端 |
| D3 | 中继由 TokenBank 服务端提供；不用 n0 公共中继和发现，不做用户自建 |
| D4 | 不支持 Intel Mac；网络层用 `@number0/iroh`（napi），局域网发现用 Node `dgram` 补，不写 Rust |
| D5 | 本人任务完整权限：不审查、不脱敏、不计积分；社区和圈子沿用现有雇佣链路和权限 |
| D6 | 设备证书预留 `scope` / `circles` / `team`，一期只签 `self` |
| D7 | 云端助手（Muse、GrokBot）保持现状：经某台设备的本地 App 接入 |
| D8 | 隧道里承载现有本地网关的 HTTP 接口，调别的设备 = 调那台设备的 `:11430` |
| D9 | 界面不加新页面、不加新概念：哪里列出模型或智能体，就在那里加「所在设备」 |
| D10 | 每台设备只有一个「设备名称」（交易页原「供给名称」），盘点、派活（`@名称`）、出租共用 |
| D11 | 智能体路由里用 `/名字[@设备]` 点名执行者，路由明细显示「指定」 |
| D12 | 协作完成大任务：在现有智能体接口上做，不加「群」；一个大任务 = 一个主任务 + 挂在它下面的子任务 |
| D13 | 没有依赖的子任务并行执行 |

---

## 二、原型里已完成的

| 需求 | 状态 | 提交 |
|---|---|---|
| 设备之间 iroh 直连、证书准入、隧道（路径白名单、换鉴权头） | ✅ | cc45d8f |
| `mine:<应用>[@设备]` 派智能体任务；`mesh:<设备>:<任务号>` 查询、取消；异步、流式、幂等 | ✅ | cc45d8f |
| 模型：`mine:<设备>/<模型>` 钉设备；本机没有的模型交给有它的设备（简化版） | 🟡 | cc45d8f |
| 命名工作区；本人模式（完整权限） | ✅ | cc45d8f |
| `/v1/devices` 设备目录；`/v1/models`、`/v1/agent/harnesses` 带上其他设备的 | ✅ | cc45d8f |
| 局域网广播发现（断网也能找到本账号设备） | ✅ | f9b9032 |
| 路由里 `/xx` 点名执行者；路由明细显示「指定」和执行设备 | ✅ | 842e318 |
| 设备名称统一：交易页、盘点「改名」、`@名称`、设备心跳上报 | ✅ | 7285a23 |
| 端到端演示 `scripts/mesh-demo.js`（33 项）、单测 | ✅ | 各提交 |
| 设计文档、实现方案、界面原型（基于最新版真实界面） | ✅ | 18d9128 等 |

---

## 三、待办

优先级：P0 不做就不能上线　P1 一期要有　P2 可以后做。估算按一个人全职。

### E1 · 设备网络正式化（从原型到可上线）

| ID | 任务 | 要改的地方 | 验收 | 优先级 | 估算 |
|---|---|---|---|---|---|
| E1-1 | 云端签发设备证书 `POST /mesh/cert`、吊销列表 `GET /mesh/revocations`；删除设备即吊销 | `server/mesh_cert.py`、`server/mesh_router.py`、`device_router.py` | 登录后自动拿到证书；删除设备后它的连接被拒 | P0 | 3 天 |
| E1-2 | 地址簿：心跳带 `endpoint_id`、中继地址、直连地址；`GET /mesh/peers` | `useDeviceReporter.js`、`shared/device-reporter.js`、`device_router.py`、`mesh/glue.js` | 不手写 `peers`，两台跨网设备能找到彼此 | P0 | 2 天 |
| E1-3 | 部署 `iroh-relay`（和现有服务一起，nginx 443），只放行持有效证书的设备 | `docker-compose.yml`、`nginx/` | 禁掉直连后仍能经中继完成演示全流程 | P0 | 2 天 |
| E1-4 | 跨网打洞实测：家宽 + 热点、两地宽带、公司网络 | 测试记录 | 有成功率、耗时、走中继比例和延迟的数据 | P0 | 2 天 |
| E1-5 | Electron 主进程接入：登录后 `startFromConfig`，退出登录 / 退出应用时 `stop`；打包 napi 模块、签名公证 | `electron/main.js`、`package.json`（electron-builder `asarUnpack`） | 桌面版 macOS arm64、Windows x64 能入网 | P0 | 3 天 |
| E1-6 | 设备上报真实负载（`runningTasks`），并发上限可配置 | `mesh/glue.js`、`agent-executor.js` | 自动选设备时把任务分散开 | P1 | 1 天 |
| E1-7 | 清理 `package-lock.json` 里与 iroh 无关的改动；`docs/` 被 `.gitignore` 忽略的问题 | `client/package-lock.json`、`.gitignore` | 合并前 diff 干净 | P1 | 0.5 天 |
| E1-8 | 吞吐评估：napi 用 JS 数组传字节，本机约 15.7 MB/s | 基准测试 | 决定大文件 / bundle 是否需要优化或后备方案 | P2 | 1 天 |

### E2 · 统一入口完善

| ID | 任务 | 要改的地方 | 验收 | 优先级 | 估算 |
|---|---|---|---|---|---|
| E2-1 | 执行器认识 `mine:` 目标：MCP `tb_dispatch_agent`、游乐场（IPC）都能派到其他设备 | `agent-executor.js`（新增 `_dispatchMeshAndWait`）、`ipc-handlers-agent.js` | 主智能体在本机经 MCP 把子任务派到 studio；游乐场 `/codex@studio` 生效 | P0 | 3 天 |
| E2-2 | 模型「我的设备」层排进降级链：本机 → 我的设备 → 免费 → 社区 → 付费；首 token 前失败换设备 | `local-gateway.js`（`enabledProviders` 加 mesh 虚拟源）、`gateway-cooldown` | 设计 §14 M3 验收 | P1 | 3 天 |
| E2-3 | 统计：`local-stats` 记 `route='mesh'`、发起设备、执行设备 | `local-stats.js`、`agent-http.js` | 盘点能按「发起 → 执行」看 | P2 | 1 天 |

### E3 · 界面「所在设备」（原型里是截图注入，要写成真实代码）

| ID | 任务 | 要改的地方 | 验收 | 优先级 | 估算 |
|---|---|---|---|---|---|
| E3-1 | 网关 · 通用 / 专业 / 外部智能体三张表加「所在设备」列；只在其他设备上的应用也列出来 | `Gateway.jsx`、`GatewayAgents.jsx` | 和界面原型一致 | P1 | 2 天 |
| E3-2 | 模型 · 账户表加「所在设备」列；其他设备开放的源按原层级列出 | `Providers.jsx` | 同上 | P1 | 1.5 天 |
| E3-3 | 游乐场智能体列表带设备标签，多台设备列多项 | `Debug.jsx` | 同上；点了能派到那台设备（依赖 E2-1） | P1 | 1.5 天 |
| E3-4 | 本机设置入口：接不接活、开放模型（一个开关）、工作区管理 | 待定（不加新页面） | — | ❓ | — |

### E4 · 协作完成大任务（在现有智能体接口上做）

| ID | 任务 | 要改的地方 | 验收 | 优先级 | 估算 |
|---|---|---|---|---|---|
| E4-1 | 任务树：请求可带 `metadata.parent_id`（MCP 派活自动带）；`GET /v1/agent/responses/{id}` 返回 `children`，`?tree=1` 返回整棵树；`GET /v1/agent/responses?parent_id=` | `agent-http.js`、`agent-executor.js`（`agent_tasks.context.parentTaskId` 已有） | 主任务能看到所有子任务和状态，包括其他设备上的 | P1 | 2 天 |
| E4-2 | 新状态 `requires_input`：子任务用 MCP `tb_ask(question)` 停下提问；主任务在检查点停下等人；用 `previous_response_id` 回答后接着做 | `agent-http.js`（`taskToResponse`）、`agent-dispatch-mcp.js`、`agent-executor.js` | 子任务提问 → 主智能体回答 → 子任务续上原会话完成 | P1 | 2 天 |
| E4-3 | MCP 异步派活：`tb_dispatch_agent` 加 `background`、`previous_task_id`；新增 `tb_task_status(ids, wait:"any")` | `agent-dispatch-mcp.js`、`agent-dispatch-server.js` | 主智能体一次派出 3 个无依赖子任务，并行执行，等任意一个完成再派依赖它的 | P1 | 2 天 |
| E4-4 | 并行隔离：并行子任务默认各用一个 git worktree 和分支 `tb/collab/<父任务>/<子任务>`；请求可带 `metadata.branch`；只读子任务共用工作区 | `mesh/workspaces.js`、`agent-http.js` | 3 个子任务同时改同一仓库互不覆盖 | P1 | 2 天 |
| E4-5 | 同一会话加锁：同时续同一个子任务时第二个排队或返回「进行中」 | `agent-executor.js` | 并发续同一任务不会同时 `--resume` | P1 | 0.5 天 |
| E4-6 | 产出回收：`GET /v1/agent/responses/{id}/bundle`、MCP `tb_collect`；取回到 `tb/mesh/<任务号>` 分支（设计 §8.4.3，命令已在 git 2.43 验证） | `mesh/git-bundle.js`、`agent-http.js`、`tunnel.js` 白名单 | 主智能体收齐子任务改动合并、跑测试；合并到你的分支前停下等确认 | P1 | 3 天 |
| E4-7 | 游乐场：按 `children` 显示子任务状态卡（所在设备、状态），`requires_input` 高亮、可直接回复；路由明细详情显示父任务 | `Debug.jsx`、`Gateway.jsx` | 你能看着任务板插话、改派、叫停 | P1 | 2 天 |
| E4-8 | 调度考虑订阅账号并发（同一 Claude / Codex 账号上的并行数） | `mesh/scheduler.js` | 多个子任务优先分散到不同设备 / 账号 | P2 | 1 天 |

### E5 · 产出查看

| ID | 任务 | 要改的地方 | 验收 | 优先级 | 估算 |
|---|---|---|---|---|---|
| E5-1 | 远程只读查看：`/v1/workspace/{名字}/fs`、`/file`、`/diff`、`/log`（设计 §8.4.5），路径限定在工作区内 | `agent-http.js` 或新文件、`tunnel.js` 白名单 | 在 A 上看 B 工作区的 diff | P2 | 2 天 |
| E5-2 | 大文件按需拉取 `blob.get`（设计 §8.4.4） | `tunnel.js`、`agent-http.js` | 拉一个 50 MB 产物不出错 | P2 | 1.5 天 |

### E6 · 以后再做

| ID | 任务 | 说明 |
|---|---|---|
| E6-1 | 圈子成员经设备网络互派 | 证书已预留；圈子成员套用雇佣权限 |
| E6-2 | 手机作为远程客户端 | 不当执行节点 |
| E6-3 | 消息注入你正在交互的会话（hook） | 参考 reason-network 的投递级别 |
| E6-4 | 局域网专用模式（完全不连云端） | 证书有效期内离线校验 |

---

## 四、待你决定

| # | 问题 | 我的建议 |
|---|---|---|
| Q1 | 子任务之间只能经过主智能体中转，还是允许直接续上兄弟任务的会话 | 只经主智能体中转 |
| Q2 | 并行子任务默认每个一个 git worktree，还是由主智能体决定 | 默认 worktree |
| Q3 | 主任务的检查点：拆解完成后、合并前，还是都要 | 都要 |
| Q4 | 主持人固定用本机的主智能体，还是可以指定其他设备上的 | 固定本机 |
| Q5 | 本机设置（接活、开放模型、工作区）的界面放哪 | 先用配置文件，入口以后定 |
| Q6 | 产出文件是否在任务结束时另存快照 | 先不存，只留清单 |
| Q7 | 跨境设备走单区域中继的延迟能否接受 | E1-4 实测后再定 |
| Q8 | 分支推送：需要在会话设置里放开仓库写权限 | — |

## 五、已知问题

- 改设备名称后，盘点按「名字 + 系统」合并同一台电脑的多条记录，可能暂时分成两条。
- 出租接单上报的名称在 worker 重连后才更新。
- 交易页以前保存过带空格的名称：能显示，但不能用来 `@`，要改一次。
