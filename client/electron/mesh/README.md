# 设备网络（原型）

本人名下的设备组成对等网络。任何一台设备的本地网关都是统一入口：用同一套接口调到自己所有设备上的模型和智能体。

- 测试手册：`TESTING.md`
- 设计：`docs/superpowers/specs/2026-11-18-personal-device-mesh-design.md`
- 实现方案：`docs/superpowers/plans/2026-11-18-personal-device-mesh.md`

**状态：原型。** 默认关闭，不影响现有功能。只依赖 Node 自带的 `crypto` 和 `ws`，没有原生模块。

## 跑起来看

```bash
cd client
npm install
node scripts/mesh-demo.js            # 一台电脑上模拟三台设备 + 官方中继，跑完整流程，约 2 分钟（手写证书，不连云端）
MESH_CLOUD_SERVER=http://127.0.0.1:18000 node scripts/mesh-cloud-demo.js   # 云端模式：要本机跑着的服务端
node --test electron/__tests__/mesh-*.test.js
```

演示脚本用独立的 HOME 起三个 CLI 网关：
- A「macbook」：发起方，不给别人当中继；
- B「mini」：有模拟的本地模型 `demo-model`、模拟的 Claude Code、git 工作区 `demo`，自动当中继；
- C「phone」：不开入口（像在运营商 NAT 后面），只能经中继，有自己的模型 `phone-model`。

A 和 B 不写对端地址，靠局域网广播找到对方后直连；C 经 B 中继。脚本依次检查 67 项：入网和设备目录、模型统一入口、智能体统一入口（异步、流式、幂等、真实工作区、点名执行）、设备名称、MCP 派活和任务树、本机设置、防回环和伪造头、其他账号被拒、经 B 中继和经官方中继（两个中继都只看到密文）、手动改中继全账号同步、中继设备掉线回落官方中继。加 `--keep` 跑完不退出，可以继续手动 `curl` 或打开管理界面。

## 通道

设备之间只有一种通道：WebSocket，消息是 JSON。

```
直连：           A ──ws──▶ B 的入口 /mesh/ws
经我的设备中继：  A ──ws──▶ B（中继）◀──ws── C        B 按 to 转发
经官方中继：      A ──ws──▶ 官方中继 ◀──ws── C        和 B 上的中继是同一份代码（relay.js）
```

- **入口**：每台默认监听 `[::]:41750`（没开 IPv6 时退回 `0.0.0.0`），路径 `/mesh/ws`；`GET /mesh/ping` 给云端回拨验证用。`listen: false` 表示不开入口，只走中继。
- **接入**：连上后中继发 `challenge`，设备回 `register {cert, sig}`（设备密钥签 `tb-mesh-register|<nonce>`）。设备上的中继只接本账号的设备；官方中继接所有账号，但只在同一账号的设备之间转发。
- **端到端加密**（`keys.js`）：两台设备之间先握手（各出一个临时 X25519 公钥，用设备密钥签名），再用 AES-256-GCM 收发。中继只看到密文。
- **上层**：`node.proxy(device, httpRequest)` 把一次 HTTP 请求交给那台设备的本机网关，流式响应原样回来（`http_request` / `http_head` / `chunk` / `done`）。

**选中继**（全账号同一个）：

1. 手动指定的以最近一次为准（经设备描述同步到所有设备）：某台设备，或官方中继。
2. 自动：在开着中继的设备里挑 device_id 最小的（大家算出来是同一台）。登录时只算云端回拨验证过、从外面连得到的设备；只在局域网里用时，开着入口就算。
3. 都没有，或者连不上选中的那台：官方中继。

每台另外挂着一条到官方中继的空闲连接当碰头点：哪怕两台一时选的中继不一样，也总能互相找到。数据还是先直连、再经我的设备中继，都不通才经官方中继。

**权限只看连接身份**：同账号证书 → 本人。消息里的字段不决定权限。雇佣社区智能体暂时还走原来的 `/ws/worker`，没有改。

## 统一入口

| 调用 | 写法 |
|---|---|
| 设备列表 | `GET /v1/devices`：每台带 `connection`（`self` / `direct` / `relay` / `offline`）、`addr_kind`（`lan` / `tailscale` / `ipv6` / `public`）、`via`（经哪个中继）、`relay`（这台在替哪些设备转发）；顶层 `relay` 是本机在用哪个中继 |
| 模型 | `model: "demo-model"`：本机除社区以外的供给源都没有时，交给有它的设备。`model: "mine:mini/demo-model"`：钉设备 |
| 智能体 | `metadata.harness_id: "mine:claude-code"`（自动选）/ `"mine:claude-code@mini"`（指定）；`metadata.workspace: "demo"` |
| 设备名称 | 和交易页「设备名称」是同一个。`PUT /v1/devices/{设备}/name` `{"name":"studio"}`，或盘点页「改名」 |
| 点名执行 | 调智能体路由时输入以 `/codex 修一下` 或 `/codex@mini 修一下` 开头：跳过主智能体，直接交给点名的智能体 |
| 远端任务 | 任务号是 `mesh:<device_id>:<远端任务号>`，查询、取消自动转到那台设备；本机另记一行镜像，重启后接着跟 |
| 子任务 / 任务树 | 请求带 `metadata.parent_id`；`GET /v1/agent/responses/{id}` 带 `children`，`?tree=1` 展开整棵树 |
| 主智能体派活（MCP） | `tb_dispatch_agent` 的 `agent_id` 可以是 `mine:codex@studio`；`background: true` 马上返回任务号；`tb_task_status(ids, wait)` 收结果 |
| 本机设置 | `GET/PUT /v1/devices/self/settings`：`accept_agent_tasks`、`accept_model_requests`、`max_tasks`、`default_workspace`、`relay_mode`（`auto` / `on` / `off`）、`relay_pref`（`auto` / `official` / 某台的 device_id）；工作区 `POST/DELETE /v1/devices/self/workspaces` |
| 新设备批准 | `GET /v1/devices/pending`；`POST /v1/devices/pending/{device_id}` `{"approve": true}` |
| 路由明细 | 交给别的设备的请求记 `device` 和 `mesh_path`（直连 / 经哪个中继） |

界面：盘点页选中本机时的设置条（中继、给其他设备当中继、批准新设备），设备胶囊上的「中继 · N」，各页「所在设备」的「经 X」，路由明细的「路径」。

## 模块

| 文件 | 职责 |
|---|---|
| `keys.js` | 设备密钥（Ed25519）、端到端会话（X25519 + HKDF + AES-GCM） |
| `identity.js` | 设备证书签发、校验和准入 |
| `relay.js` | 中继：接入校验、按 to 转发、在线设备列表、转发统计 |
| `relay-server.js` | 官方中继：`relay.js` 加一个 HTTP 服务，定时拉吊销列表 |
| `node.js` | 节点：入口、直连、选中继、握手、presence、`proxy()` |
| `tunnel.js` | 接收端：校验路径白名单、换鉴权头，转给本机网关 |
| `cloud.js` | 和云端打交道：领证书、报地址、地址簿、吊销列表、批准 |
| `directory.js` | 设备目录；描述里出现本机路径直接报错 |
| `scheduler.js` | 本地选设备（纯函数） |
| `workspaces.js` | 命名工作区 |
| `lan-discovery.js` | 局域网发现：UDP 组播 + 广播兜底，校验证书后交给节点拨号 |
| `glue.js` | 接进网关：`/v1/devices`、模型、智能体、本机设置、云端同步 |

## 云端模式（正式用法）

登录后在盘点页选中本机，打开「设备网络」即可：

1. 用设备密钥向云端领证书（`POST /mesh/cert`，30 天，剩 7 天时自动续）。账号的第一台直接通过；之后的新设备要一台已入网的设备批准（那台用设备密钥签名，只有登录令牌批准不了）。
2. 每分钟报一次地址（`POST /mesh/address`）：云端回拨公网地址验证能不能从外面连到（内网地址不验证），验证过的设备才会被自动选成中继。拉地址簿去直连，拉吊销列表，被吊销的马上断开。
3. 在云端删除设备 = 吊销它的证书；官方中继每分钟拉一次吊销列表（`/mesh/revoked-endpoints`）。
4. 退出登录时证书来自云端的设备网络一起停。

服务端：`server/mesh_router.py`、`server/mesh_cert.py`；部署见仓库根目录 `DEPLOY.md`「设备网络」。

## 配置（开发用，手写）

`~/.tokenbank/mesh/config.json`：

```json
{
  "enabled": true,
  "user_id": "1001",
  "cert": "<设备证书 JWS>",
  "issuer_keys": [{ "kid": "…", "x": "…" }],
  "port": 41750,
  "listen": "::",
  "public_addr": "203.0.113.5:41750",
  "peers": [{ "endpoint_id": "<对端公钥>", "direct_addrs": ["192.168.1.20:41750"] }],
  "relay_urls": ["wss://tokenbank.example/mesh/ws"],
  "relay_mode": "auto",
  "relay_pref": "auto",
  "lan_discovery": true,
  "accept_model_requests": false
}
```

`listen: false` 只走中继；`public_addr` 是做了端口映射时手填的公网地址。

## 原型和正式版的差距

- 签发方公钥现在随证书一起从云端下发；正式版要内置进客户端，防止被冒充的云端换掉。
- 打洞（两台都在 NAT 后面时直连）没做：这种情况走中继。
- 官方中继按账号限连接数，还没有按流量限速和计费。
- 雇佣社区智能体还走 `/ws/worker`；以后把设备间的消息换成同一套词汇（`agent_task` / `request`），雇佣只多一层计费和授权。
- Electron 主进程加载、签名公证没在 macOS / Windows 上验证。
