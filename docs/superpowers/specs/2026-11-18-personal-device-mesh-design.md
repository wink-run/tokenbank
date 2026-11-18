# 个人设备对等互联（Device Mesh）· 设计文档

日期：2026-11-18
状态：**方向已定，待评审**（确认后再出实现计划，确认前不写业务代码）
基线代码：`main` @ 17ee836（已合入 `claude/agent-plaza-page-design-y1ph18`）
参考：[reason-network](https://github.com/reason-machines/reason-network)（iroh P2P、会话目录、投递语义）、[gary-ai-link](https://github.com/garycaogan/gary-ai-link)（命名工作区、权限由主人定、`uncertain` 状态）
相关：[贡献武将 WS 接单](./2026-07-26-contribute-agents-ws-design.md)

---

## 1. 背景

### 1.1 现状

- 每台设备都有本地网关 `:11430`：模型走 `/v1/chat/completions`，Agent 任务走 `/v1/agent/responses`，用 `harness_id` 选目标（`agent-http.js`）。
- 设备盘点（`/device/register` + 心跳）已经把同账号的设备汇到云端，但只有用量快照和账户配置，没有执行能力和在线状态。
- 跨设备执行只有一条路：设备开启「贡献」→ 贡献 worker 连云端 `/ws/worker` → 云端公共调度池派单。

### 1.2 问题

想把活派到**自己的另一台设备**，只能走出租链路：

| # | 卡点 | 代码位置 |
|---|---|---|
| 1 | 可见范围只有 `public` / `circle`，自用也得先勾选出租 | `contribute-assistants.js:53`、`worker_pool.py:1162` |
| 2 | 按昵称寻址，本机要先「雇佣」自己的智能体；Agent 路由默认不收雇来的 | `worker_pool.py:1014`、`hired-community-agents.js`、`agent-routes.js` |
| 3 | 任务只能在按调用方隔离的沙箱目录执行，本人任务也过审查和脱敏 | `agent-worker.js:979`（`ensureContributeWorkspace`、`hire-guard`） |
| 4 | 盘点（登录 token）和执行（worker_key）是两套身份 | `device_router.py`、`server.py:1750` |
| 5 | 所有任务和内容都经云端中转 | `dispatch.py`、`dispatch_agent.py` |

### 1.3 目标一句话

> **同一账号的设备组成对等网络：每台设备装同一套节点，任何一台都能发起、都能执行；任务和内容在设备之间直连传输，云端只管身份和找路。**

---

## 2. 已定决策

| # | 决策点 | 结论 |
|---|---|---|
| 1 | 拓扑 | 设备对等，没有主节点；调度在**发起设备本地**完成 |
| 2 | 云端角色 | 只做登录、签发设备证书、地址簿、加密中继；**不经手任务和内容** |
| 3 | 中继 | 由 TokenBank 服务端提供，不做用户自建 |
| 4 | 云端助手 / 外部 Agent | 保持现状：通过某台设备的本地 App（`:11430` 网关或本地 MCP）接入，再由该设备进入设备网络。不新增云端入口 |
| 5 | 本人任务权限 | **完整权限**：不审查、不脱敏，执行时不弹审批 |
| 6 | 社区 / 圈子调用 | 沿用现有雇佣链路和权限（审查、沙箱、脱敏、积分），不进设备网络 |
| 7 | 公共出租市场 | 不变；和设备网络完全分开，贡献 worker 照旧可选 |
| 8 | 设备证书 | 一期只认本人；证书格式预留圈子和团队字段 |
| 9 | 平台 | 不支持 Intel Mac；网络栈用 iroh 的 Node 绑定 `@number0/iroh` |
| 10 | 一期范围 | Agent 任务 + 命名工作区；模型请求放在 M3；手机放二期 |

---

## 3. 目标与非目标

**目标（一期）**

1. 同账号设备登录后自动入网，设备页能看到每台设备是否在线、是直连还是走中继、有哪些能力。
2. 任一设备通过 `mine:<目标>[@设备]` 把 Agent 任务派到自己的另一台设备，在那台设备的**真实项目目录**里执行，有进度、能取消、断线后能续上。
3. 任务和内容不经过 TokenBank 服务器（中继只转发密文）。
4. 本人任务默认完整权限；设备主人可以在本地关掉接活，或者给某台设备收紧权限。

**非目标（一期不做）**

- 圈子成员或团队之间经设备网络互派（证书已预留字段，见 §5.2、§12）。在那之前，别人调用你的设备仍走现有雇佣链路。
- 手机和网页作为节点。
- 把消息注入别人正在交互的会话（Reason 的 push/turn 投递）。一期只做「新起进程」和「`--resume` 续接已有会话」。
- 远程 MCP 入口、拉取型云端助手。

---

## 4. 总体架构

```
          ┌──────────── TokenBank 云端（只有控制面）────────────┐
          │  登录 · 设备证书签发 · 吊销列表 · 地址簿 · 加密中继   │   公共市场（不变）
          └──────▲──────────────────────────────▲─────────────┘
                 │ 证书 / 地址（无任务、无内容）   │
┌─ 设备 A（发起）─┴──────────────┐        ┌─ 设备 B（执行）─┴──────────────┐
│ 入口：网关 :11430 · 本地 MCP     │        │ 入口：网关 :11430 · 本地 MCP     │
│ 调度器（读本地设备目录选目标）    │        │ 调度器                          │
│ mesh 节点（iroh · 设备密钥）◀────┼─QUIC──▶│ mesh 节点                       │
│ 执行器 · 命名工作区              │ 直连/中继│ 执行器 · 命名工作区 → ~/code/xx │
└────────────────────────────────┘        └────────────────────────────────┘
```

两台设备装的是同一套代码，「发起」和「执行」只是这一次任务里的角色。

**节点内的新模块**（`client/electron/mesh/`，Electron 主进程和 CLI 网关共用）：

| 模块 | 职责 |
|---|---|
| `mesh-identity.js` | 设备密钥、设备证书的申请、续期和校验 |
| `mesh-transport.js` | iroh endpoint、连接管理、帧编解码（见 §13 技术选型） |
| `mesh-directory.js` | 本机描述的生成与广播，对端描述的合并；设备目录 |
| `mesh-scheduler.js` | 按目标、工作区、策略和负载选设备 |
| `mesh-tasks.js` | 任务状态机（发起侧发件箱 + 执行侧任务表，SQLite） |
| `mesh-executor.js` | 执行侧：策略检查 → `agent-executor.execute()` |
| `mesh-policy.js` | 本机接活策略和命名工作区（`~/.tokenbank/mesh/`） |

---

## 5. 身份与信任

### 5.1 设备密钥

- 首次启用时生成 iroh 密钥（ed25519），保存在 `~/.tokenbank/mesh/secret.key`（0600）。公钥 `endpoint_id` 就是这台设备在网络里的身份。
- 和现有 `device_id`（`client/shared/device-id.js`）一一绑定，不替换它。

### 5.2 设备证书（由云端签发）

登录后，节点调 `POST /mesh/cert`（用户 JWT 鉴权，带 `device_id`、`endpoint_id`、对私钥做签名的 challenge 响应），云端返回一张紧凑 JWS：

```json
{ "typ": "tokenbank-mesh-cert", "ver": 1, "iss": "https://<server>/mesh",
  "sub": "<user_id>", "device_id": "dev-…", "endpoint_id": "<ed25519 pk>",
  "name": "Mac mini", "iat": 1763424000, "exp": 1764028800,
  "scope": "self", "circles": [], "team": null }
```

- `scope`、`circles`、`team` 是**预留字段**。一期只签 `scope: "self"`，`circles` 为空，`team` 为空；校验方遇到不认识的 `scope` 一律拒绝连接，保证以后扩展时旧客户端不会误放行。
- 以后开放圈子时：`scope: "circle"`，`circles` 填该设备愿意接活的圈子 ID（由云端按圈子成员关系核实后签入）。权限按发起者区分，见 §12。

- 签名算法 Ed25519。客户端**内置**云端公钥（可以带多把，方便轮换），离线校验，不用联网问云端。参考 reason-network 的 sign-in proof。
- 有效期 7 天，节点在剩 2 天时自动续。
- 云端要先确认 `device_id` 属于这个用户（复用 `db.get_device_owner`），才签发。

### 5.3 准入

- 建立连接时双方先交换证书，校验：签名有效、没过期、`endpoint_id` 和 QUIC 握手证明的公钥一致、`sub` 和本机用户相同、不在吊销列表里。任何一条不满足就直接断开，不回任何信息。
- **吊销**：在设备页删除设备时，云端把它的 `endpoint_id` 加进吊销列表。节点每次续证书时拉取一次吊销列表，并通过设备网络转发给其他在线设备，所以一台设备离线也不影响其他设备拿到最新列表。再加上证书只有 7 天有效期，吊销最迟 7 天内生效。

---

## 6. 发现与连接

| 场景 | 方式 |
|---|---|
| 同一局域网 | 联网时：地址簿里本来就带每台设备的局域网地址，iroh 自动优先走局域网直连。断网时：局域网广播发现（Node `dgram`，UDP 组播 `239.255.77.77` + 广播兜底，每 5 秒一次；内容是 `endpoint_id`、iroh 端口、设备证书；收到后先校验证书，是本账号设备才拨号）。Node 绑定没有 mDNS 接口，原型已验证这种做法可行 |
| 跨网络 | 云端地址簿：节点在心跳里上报 `endpoint_id`、home relay、直连地址提示；`GET /mesh/peers` 只返回本账号的设备 |
| 打不通 | 走中继。中继只转发 QUIC 密文 |

- **中继**：由 TokenBank 服务端提供，和现有服务一起部署 `iroh-relay`（443 端口，可以复用现有 nginx 和证书）。中继只允许持有效证书的 `endpoint_id` 接入。不使用 n0 的公共中继，也不提供用户自建选项。
- **地址发现**：只用 TokenBank 地址簿和局域网 mDNS，关闭 iroh 默认的 n0 DNS 发现，设备地址不外泄给第三方。
- **连接拓扑**：本账号所有在线设备之间两两保持连接（一个人的设备数量很少，全连接没压力）。
- **协议**：ALPN `tokenbank/mesh/1`；每条消息用「4 字节长度 + JSON」分帧，和 reason-network 一样。附件和产出文件用单独的流传输（§8.4）。
- 设备页显示每台设备的连接方式：`直连 · 局域网` / `直连 · 打洞` / `中继`，以及往返延迟。

---

## 7. 设备目录

每个节点维护本机描述，在建立连接时整份交换，之后有变化就推送（`presence` 帧，带递增 `seq`）：

```json
{
  "device_id": "dev-…", "name": "Mac mini", "platform": "darwin", "version": "0.9.x",
  "seq": 42, "load": { "running": 1, "max": 2 },
  "agents": [ { "id": "claude-code", "version": "2.x" }, { "id": "codex", "version": "0.16x" } ],
  "assistants": [ { "id": "res-assistant-…", "name": "写诗专家" } ],
  "models": [ "qwen3-32b" ],
  "workspaces": [ { "name": "tokenbank", "repo": "github.com/wink-run/tokenbank", "agents": ["claude-code","codex"] } ],
  "sessions": [ { "agent": "claude-code", "id": "…", "workspace": "tokenbank", "title": "修登录", "busy": false, "updated_at": 1763424000 } ],
  "accepts": { "agent_tasks": true, "model_requests": false }
}
```

- **只放名字，不放路径和密钥。** 工作区只有名字和仓库标识，路径只存在本机。
- `agents` 复用 `detect-tools.js`；`assistants` 复用 `resource-manager`；`sessions` 复用 `session-browser.js` 的 `listAllSessions`，只带最近活跃的 20 条。
- 断开连接即把这台设备标为离线，保留最后一次的描述和时间，界面显示「x 分钟前在线」。
- 设备页和云端盘点合并显示：盘点那边照旧上报用量；在线状态和能力以设备网络为准。

---

## 8. 任务

### 8.1 寻址

`harness_id`（`/v1/agent/responses` 的 `metadata.harness_id`，或者 MCP `tb_dispatch_agent` 的 `agent_id`）新增 `mine:` 前缀：

| 写法 | 含义 |
|---|---|
| `mine:codex` | 在我任意一台装了 Codex 的设备上跑，自动选 |
| `mine:codex@mac-mini` | 指定设备（按设备名，重名时用 `device_id`） |
| `mine:assistant:<id>` | 跑某个智能体资源 |
| `mine:session:<agent>:<id>` | 续接某台设备上的这个会话（`--resume`），自动落在它所在的设备和工作区 |

工作区通过 `metadata.workspace` 传名字。不传时：续接会话的任务用会话所在的工作区；其他任务用目标设备的默认工作区，没配就拒绝，不偷偷落到沙箱。

### 8.2 调度（在发起设备本地完成）

1. **过滤**：在线、证书有效、`accepts.agent_tasks` 为真、有目标能力、有指定的工作区（按名字或仓库标识匹配）、没满负载。
2. **排序**：
   1. 显式指定的设备；
   2. 会话所在的设备（`mine:session:`）；
   3. 本机能做就在本机做（不跨设备）；
   4. 用户设定的设备优先级；
   5. 负载低的；
   6. 直连优先于中继，延迟低的优先。
3. 都不满足时返回明确原因，例如「mac-mini 离线」「没有设备配了工作区 tokenbank」。**不会回落到公共市场。**

接入现有入口：
- `agent-http.js` 的 `resolveHarness` 识别 `mine:`；`agent-executor.js` 新增 `_dispatchMeshAndWait`，和现有 `_dispatchCommunityAndWait`（`agent-executor.js:1147`）并列。
- 异步调用直接复用 main 新加的 `background: true`：`POST /v1/agent/responses` 立即返回任务号，调用方用 `GET /v1/agent/responses/{id}` 查进度和结果。发起端的 mesh 任务表（§8.5）就是这个查询的数据来源，不用另开接口。
- 等待语义复用 main 新加的「空闲超时 + 硬超时」（`dispatchAndWait` 的 `idleMs` / `hardMs`，`agent-executor.js:1002`）：执行端每推一次进度，发起端就把空闲计时往后推，长任务只要一直有进展就不会被误判超时。进度回调用新加的 `onStep` / `onProgress`。
- `agent-routes.js` 的候选名单加入「我的设备」，默认开启（不扣积分）。
- 派发 MCP（`agent-dispatch-mcp.js`）的 `tb_list_agents` 列出 `mine:*` 目标；新增 `tb_list_devices`。

### 8.3 协议

> **实现调整（见 [实现方案](../plans/2026-11-18-personal-device-mesh.md) §0.2）**：下面的帧是逻辑语义。实际实现时，隧道里承载的是现有本地网关的 HTTP 接口：提交是 `POST /v1/agent/responses`（`background: true` + 幂等键），进度是 SSE，查询是 `GET /v1/agent/responses/{id}`，取消是 `/cancel`。§8.4.7 的帧同样落成远端网关的 HTTP 接口。

每个任务一条双向流：

```
发起端                                      执行端
task.submit{task_id, client_id, target,  ─▶
            workspace, prompt, continue,
            timeout_ms, attachments[] }
                                          ◀─ task.ack{accepted | rejected, reason}
                                          ◀─ task.progress{parts, cli_session_id}  (多次)
task.cancel{task_id}                      ─▶ (可选)
                                          ◀─ task.result{status, output, artifacts[], cli_session_id, usage}
```

- `task_id` 用 ULID。`client_id` 是幂等键：同一个 `(发起设备, client_id)` 重复提交时返回原任务，内容不同就拒绝（409 语义）。
- 进度帧复用 `agent-worker.js` 现有的分段结构（`parts`：文本、思考、工具），网页和游乐场的展示代码可以直接用。

### 8.4 附件和产出

任务在执行设备的真实目录里跑，产出天然留在那台设备上。设备网络里没有云端中转，所以产出要么留在原地供查看，要么由发起端按需拉回。

参考：reason-network 只传消息和小文本文件（≤10 个、合计 512 KB），代码改动交给 git 和远程仓库同步，不传二进制。TokenBank 的场景是本人的设备之间、完整权限，所以在它的基础上加了 git 数据直传、大文件按需拉取和远程查看。

#### 8.4.1 附件（发起端 → 执行端）

- `task.submit` 里只放清单（名字、大小、sha256），内容走单独的单向流。单个 25 MB、单个任务 100 MB 封顶。
- 执行端存到工作区下的 `.tokenbank-uploads/<task_id>/`，沿用 `agent-executor.js` 现有的 `materializeAttachedImages` / `materializeAttachedFiles`。

#### 8.4.2 产出分层

| 产出类型 | 怎么回到发起端 | 限额 |
|---|---|---|
| 文字结论 | `task.result.output` 正文 | 200 KB（同现有贡献链路） |
| 小文本文件 | 直接附在 `task.result.files[]` 里 | 最多 10 个，合计 512 KB，只限 UTF-8 文本 |
| 代码改动（工作区是 git 仓库） | git 数据直传，见 8.4.3 | 单个 bundle 50 MB |
| 大文件、二进制 | 结果里只放清单，发起端按需拉取，见 8.4.4 | 单个 200 MB |
| 想直接看 | 远程只读查看，见 8.4.5 | 单次读取 1 MB |

「这轮新增或改过的文件」沿用 `snapshotWorkspace` / `collectWorkspaceArtifacts` 的判定：开工前拍快照，结束后对比。

#### 8.4.3 代码改动：git 数据直传

**执行端**

1. 开工前记下 `base = HEAD` 的提交号和当前分支。
2. 任务结束后：
   - Agent 自己提交过：取 `base..HEAD` 之间的提交。
   - 工作区还有未提交的改动：用临时索引生成一个提交，**不动用户的分支、暂存区和工作区**：
     ```
     GIT_INDEX_FILE=<临时文件> git read-tree HEAD
     GIT_INDEX_FILE=<临时文件> git add -A          # 遵守 .gitignore
     tree=$(GIT_INDEX_FILE=<临时文件> git write-tree)
     commit=$(git commit-tree "$tree" -p HEAD -m "tokenbank mesh <task_id>")
     git update-ref refs/tokenbank/mesh/<task_id> "$commit"
     ```
   - 两者都有时，临时提交接在 Agent 的最后一个提交后面。
3. `task.result` 里带 `git: { repo, base, head, branch, commits, files_changed, insertions, deletions }`，外加 `git diff --stat` 摘要。bundle 不随结果发送，等发起端来要。

**发起端**

1. 用工作区的 `repo` 标识（§9.1 的 git 远程地址）在本机找同一个仓库：先找设备目录里登记过的工作区，再找 `session-browser.js` 的最近项目。
2. 用户点「拉取改动」，或者调用方在请求里带了 `fetch_changes: true`，就发 `git.bundle{task_id}`。执行端运行 `git bundle create - base..refs/tokenbank/mesh/<task_id>`，通过流发回来。
3. 发起端运行 `git bundle verify`，然后 `git fetch <bundle> refs/tokenbank/mesh/<task_id>:refs/heads/tb/mesh/<task_id>`（按 bundle 里的引用名取，不按提交号）。**只新建这个分支，不合并、不切换**，合不合并由用户决定。

已在 git 2.43 上验证：临时索引生成提交前后，执行端的 `git status` 完全一致，`.gitignore` 里的文件不会进提交；bundle 能写到标准输出；发起端 fetch 后当前分支不变。
4. 本机仓库里没有 `base` 提交（bundle 的前置条件不满足）时，提示先 `git fetch` 远程仓库；或者让执行端改发从共同祖先开始的完整 bundle，体积超限就拒绝。
5. 本机找不到这个仓库时，把 bundle 文件存进收件箱（8.4.6），用户可以自己 `git clone` 它。

**可选：推到远程仓库**

两台设备都连着同一个远程仓库时，可以在执行端的工作区配置里打开 `push_to_remote`。打开后，执行端在任务结束时运行 `git push origin refs/tokenbank/mesh/<task_id>:refs/heads/tb/mesh/<task_id>`，发起端从远程拉。默认关闭，因为它会把内容推到第三方（GitHub 等）。

**清理**：`refs/tokenbank/mesh/*` 保留 7 天，到期删除；用户已经合并的不受影响。

**不是 git 仓库的工作区**：退回 8.4.4，按文件清单处理。

#### 8.4.4 大文件和二进制：按需拉取

- `task.result.artifacts[]` 只放清单：`{ path（相对工作区）, size, sha256, mime }`。
- 发起端要哪个就发 `blob.get{task_id, path, sha256}`，执行端校验文件还在、sha256 没变才发送；文件后来被改过就回 `changed`，不发错的内容。
- 图片默认自动拉取缩略图（长边 512 像素），方便在结果里直接预览。
- 以后可以换成 iroh 自带的内容寻址传输组件 iroh-blobs（支持断点续传、多源下载），协议上的清单格式不用改。

#### 8.4.5 远程只读查看（仅本人模式）

本人完整权限下，发起端可以像打开那台电脑上的工作区一样直接查看，不必先拉回来：

| 操作 | 说明 |
|---|---|
| `fs.list{workspace, path}` | 列目录 |
| `fs.read{workspace, path, offset, limit}` | 读文件，单次 1 MB |
| `git.diff{task_id \| workspace, path?}` | 看本次任务或当前工作区的 diff |
| `git.log{workspace, limit}` | 看最近提交 |

- 路径限定在工作区根目录之内（解析软链接之后再判断）。
- 只读，不提供写操作：要改东西就再派一个任务。
- 以后开放圈子时（§12），这组操作不对圈子成员开放。

#### 8.4.6 发起端的落地位置

- 小文本文件和拉回来的文件放进 `~/.tokenbank/mesh/inbox/<task_id>/`：目录 0700、文件 0600，不加执行权限，不自动打开，并标记来源（macOS 隔离属性、Windows Internet 区域）。做法沿用 reason-network。
- 代码改动进本机仓库的 `tb/mesh/<task_id>` 分支（8.4.3），找不到仓库时 bundle 文件放进收件箱。
- 收件箱的内容保留 30 天，或者用户手动清理。

#### 8.4.7 新增的帧

| 方向 | 帧 | 用途 |
|---|---|---|
| 发起 → 执行 | `git.bundle{task_id}` | 拉代码改动 |
| 发起 → 执行 | `blob.get{task_id, path, sha256}` | 拉单个文件 |
| 发起 → 执行 | `fs.list` / `fs.read` / `git.diff` / `git.log` | 远程只读查看 |
| 执行 → 发起 | `stream.data` / `stream.end{sha256}` / `stream.error{reason}` | 以上请求的响应，各开一条单向流 |

所有请求都要校验：任务确实是这台发起设备派的（`from_device` 匹配），或者是本人模式下的工作区查看。

### 8.5 状态机与断线

```
发起端：pending ──ack──▶ running ──result──▶ completed | failed | cancelled
                  │                │
                  │ 被拒绝           │ 断线后重连不上，且超过 timeout
                  ▼                ▼
               rejected         uncertain（不自动重试）
```

- 两端都把任务落到本地 SQLite（`~/.tokenbank/mesh/tasks.db`）。
- **执行端不因为断线就停**：发起端掉线时任务照跑，结果保留 7 天。
- 发起端重连后发 `task.attach{task_id}`，执行端先补发最近一次进度，再继续推送。
- `uncertain` 是事实陈述：结果未知。界面提供「查看那台设备上的会话」和「手动重试」，不自动重试。这一点借鉴 gary-ai-link。
- 模型请求（M3）是无状态的：首个 token 到达前失败，可以自动换一台设备重试。

### 8.6 防止循环

`task.submit` 带 `hops` 字段。通过设备网络收到的任务，执行时默认不能再派给设备网络（`hops` 上限为 1）。Agent 路由的主智能体确实需要再派活时，上限放宽到 2。

---

## 9. 执行端

### 9.1 命名工作区

本机配置 `~/.tokenbank/mesh/workspaces.json`：

```json
{
  "default": "tokenbank",
  "workspaces": {
    "tokenbank": { "path": "~/code/tokenbank" },
    "notes":     { "path": "~/Documents/notes" }
  }
}
```

- 工作区在本人模式下**只用来寻址**（把名字翻译成本机路径），不是权限边界。
- 发起端只传名字，路径不出本机。这一点借鉴 gary-ai-link。
- 设置页提供「从最近项目添加」：从 `session-browser.js` 的项目列表里挑；自动读 git 远程地址作为 `repo`，方便跨设备按仓库匹配。
- 发起端没传工作区、执行设备也没配默认工作区时，在执行设备的家目录下运行（本人完整权限，和自己坐在那台电脑前一样）。

### 9.2 本人模式（完整权限）

设备网络里的任务都来自同一账号，按「本人坐在这台电脑前」处理：

| 项 | 做法 |
|---|---|
| 安全审查 | 不过 `hire-guard`、`agent_boundary`，不做关键词拦截 |
| 脱敏 | 不脱敏，产出原样返回 |
| 权限模式 | 完整权限：Claude Code `bypassPermissions`，Codex `danger-full-access` 且不弹审批，其他 Agent 用各自的「全部允许」档 |
| 交互审批 | 不会出现，因为已经是完整权限 |
| 积分 | 不计 |

执行入口：`agent-executor.execute(target, prompt, { mode: 'mesh', workingDir, continueSession, cliSessionId, images, files })`。这些参数现在都已支持（`agent-executor.js:316` 起），需要新增的是按 `mode: 'mesh'` 传完整权限参数。

### 9.3 设备本地开关（`mesh-policy.js`）

完整权限是默认值，但设备主人可以在本机收紧，远程请求改不了：

| 项 | 默认 |
|---|---|
| 接 Agent 任务 | 开 |
| 接模型请求（M3） | 关 |
| 最大并发 | 2 |
| 降低权限（例如某台放公司数据的电脑只接只读任务） | 不降 |

### 9.4 别人调用你的设备

社区和圈子成员调用你的设备，**照旧走现有雇佣链路**：云端调度池 → 贡献 worker → 沙箱目录 → `hire-guard` 审查 → 脱敏 → 积分结算。设备网络一期不接受别人的连接（证书 `sub` 不同直接断开）。

main 上的 `hire-guard` 已经升级（17ee836）：审查会判断命令碰的路径是否在本单的工作目录内，进度里的工具输出也会脱敏，拦截通知会写明雇佣者是谁。以后圈子成员经设备网络调用时（§12），执行端直接调用同一套 `screenTask` / `reviewTask` / `screenStep` / `redact`，传入该任务的工作目录即可。

### 9.5 和贡献 worker 的关系

完全独立：设备网络的任务不经过云端，也不进入公共市场；贡献 worker 照旧，开关互不影响。两边共用 `agent-executor`，并发上限合并计算。

---

## 10. 云端改动（最小化）

| 接口 / 组件 | 说明 |
|---|---|
| `POST /mesh/cert` | 签发和续期设备证书（§5.2） |
| `GET /mesh/revocations` | 吊销列表（带签名） |
| 设备心跳加字段 | `endpoint_id`、home relay、直连地址提示、连接方式统计 |
| `GET /mesh/peers` | 返回本账号设备的地址提示（地址簿） |
| `iroh-relay` 部署 | 和现有服务一起部署（docker-compose 新增一个服务，nginx 反代 443）；只允许持有效证书的 `endpoint_id` 接入 |
| 删除设备 | 同时把它加进吊销列表 |

云端**不新增**任何任务、调度、结果相关的接口。

---

## 11. 统计

- `local-stats` 新增 `route = 'mesh'`，并记录 `from_device` / `to_device`。两端各记一条：发起端记「派出」，执行端记「执行」，用 `task_id` 关联。
- 盘点心跳只上报汇总数字（次数、成功率、耗时分位），不报 prompt 和产出。
- Dashboard 增加「发起设备 → 执行设备」维度。

---

## 12. 扩展口（不在一期）

- **圈子 / 团队经设备网络互派**：证书签 `scope: "circle"` 和 `circles`；准入从「`sub` 和本机相同」放宽到「双方证书里有共同圈子」。执行侧按发起者区分权限：本人走 §9.2 完整权限，圈子成员套用现有雇佣权限（沙箱目录、`hire-guard`、脱敏、积分），积分结算仍由云端记账。证书格式现在已经预留，不用再改。
- **手机**：作为某台设备的远程客户端，经设备网络中继连接，不当执行节点。
- **向会话注入消息**：参考 reason-network 的投递级别。
- **局域网专用模式**：完全离线，只靠 mDNS，不连云端（证书在有效期内仍可校验）。

---

## 13. 技术选型与风险

### 13.1 iroh 在 Node 里怎么用

**选定：`@number0/iroh`**（napi 绑定，1.2.0，基于 iroh-ffi），在 Electron 主进程和 CLI 网关里直接调用。

- 平台：macOS arm64、Windows x64 / arm64、Linux x64 / arm64 都有预编译包。不支持 Intel Mac（已确认不需要）。
- M0 已验证（原型）：自定义 ALPN、关闭 n0 DNS 发现、局域网直连、获取连接方式和延迟。Node 绑定没有 mDNS 接口，局域网发现改用 Node `dgram` 广播实现，已验证可行。待验证：指定中继和跨网打洞成功率（需要先部署 TokenBank 中继）、在 Electron 里加载和签名公证。
- 局域网直连和跨网打洞都由 iroh 内核完成，Node 绑定底下就是同一套 Rust 代码，**不需要另写 Rust**。只有吞吐（绑定用 JS 数组传字节，本机实测约 15.7 MB/s）成为瓶颈时，才考虑后备方案。
- 后备方案：如果 M0 发现缺的接口没法绕过，改用 Rust 写的独立进程 `tokenbank-meshd`（直接用 iroh，Node 通过本地 socket 调用），做法同 reason-network。只在验证失败时启用。

### 13.2 其他风险

| 风险 | 应对 |
|---|---|
| 打洞失败率高（对称 NAT、公司网络） | 中继兜底；设备页显示连接方式，`doctor` 给出诊断 |
| 中继成本 | 只转发打洞失败的流量；按账号限速 |
| 完整权限下远程任务误改文件 | 本人自担（等同自己操作）；产出清单附 diff 摘要；设备主人可在本机降权（§9.3）；M4 可选加本机弹窗确认 |
| 设备密钥或证书被盗用后拿到完整权限 | 密钥文件 0600；证书 7 天有效；设备页删除即吊销并经设备网络扩散 |
| 两端同时续写同一个会话 | 执行端对同一个 CLI 会话加锁，第二个任务排队或被拒绝 |
| 一台设备被盗 | 在设备页删除即吊销；证书最长 7 天有效 |

---

## 14. 里程碑

| 阶段 | 内容 | 完成标准 |
|---|---|---|
| M0 · 验证（约 1 周） | 验证 `@number0/iroh` 的接口（§13.1）；两台设备完成证书准入、局域网直连、跨网络打洞、经 TokenBank 中继 | macOS arm64、Windows x64、Linux x64 跑通；否则启用后备方案 |
| M1 · 入网和目录 | 设备密钥和证书（含预留字段）、云端 `/mesh/*`、中继部署、设备目录、设备页展示 | 登录即入网；设备页显示在线、连接方式和能力 |
| M2 · Agent 任务 | `mine:` 寻址、本地调度、任务协议和状态机、命名工作区、本人完整权限执行、Agent 路由和 MCP 接入 | 在 A 上用 `mine:codex@mac-mini` 改 B 上的真实项目；断线重连后能续上进度；取消有效 |
| M3 · 模型请求 | 网关增加「我的设备」层；流式转发；首 token 前失败自动换设备 | 降级链变成 本机 → 我的设备 → 免费 → 社区 → 付费 |
| M4 · 体验 | `mine:session:` 续接会话、局域网专用模式、Dashboard 设备维度 | — |
| 后续 | 圈子成员经设备网络互派（§12） | — |

---

## 15. 已确认与剩余问题

已确认（2026-11-18）：不支持 Intel Mac；中继由 TokenBank 服务端提供；本人任务完整权限；社区和圈子沿用现有雇佣权限；证书预留圈子和团队字段。

剩余（不阻塞方案，实现计划阶段再定）：

1. 按需拉取（§8.4.4）依赖执行端的文件还在原处。文件后来被改了会回 `changed`；是否需要在任务结束时把产出另存一份快照，保证 7 天内一定拉得到？
2. TokenBank 服务端只有一个区域时，跨境设备走中继的延迟是否可以接受，还是要加第二个中继节点？
