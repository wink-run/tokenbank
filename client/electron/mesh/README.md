# 设备网络（原型）

本人名下的设备组成对等网络。任何一台设备的本地网关都是统一入口，用同一套接口调用任何一台设备上的模型和智能体。

- 设计：`docs/superpowers/specs/2026-11-18-personal-device-mesh-design.md`
- 实现方案：`docs/superpowers/plans/2026-11-18-personal-device-mesh.md`

**状态：原型。** 覆盖方案的 M0（技术验证）和 M1 / M2 / M3 的主干。默认关闭，不影响现有功能。

## 跑起来看

```bash
cd client
npm install                          # @number0/iroh 是可选依赖
node scripts/mesh-demo.js            # 一台电脑上模拟两台设备，跑完整流程，约 1 分钟
node --test electron/__tests__/mesh-core.test.js electron/__tests__/mesh-tunnel.test.js
```

演示脚本会用两个独立的 HOME 起两个 CLI 网关：
- 设备 A「macbook」：发起方；
- 设备 B「mini」：有一个模拟的本地模型 `demo-model`、一个模拟的 Claude Code、一个 git 工作区 `demo`。

两台之间是真实的 iroh QUIC 连接。两台都**不写对端地址**，靠局域网广播找到对方后直连。脚本依次检查 23 项：局域网发现、入网和设备目录、模型统一入口（流式、钉设备）、智能体统一入口（异步、流式、幂等、真实工作区、路由里 /xx 点名执行）、防回环、伪造头、其他账号拒绝、断线。加 `--keep` 跑完不退出，可以继续手动 `curl` 设备 A。

## 统一入口

| 调用 | 写法 |
|---|---|
| 设备列表 | `GET /v1/devices` |
| 模型 | `model: "demo-model"`：本机除社区以外的供给源都没有时，交给有它的设备。`model: "mine:mini/demo-model"`：钉设备 |
| 智能体 | `metadata.harness_id: "mine:claude-code"`（自动选）/ `"mine:claude-code@mini"`（指定）；`metadata.workspace: "demo"` |
| 点名执行 | 调智能体路由时输入以 `/codex 修一下` 或 `/codex@mini 修一下` 开头：跳过主智能体，直接交给点名的智能体（见 `../agent-designation.js`） |
| 远端任务 | 任务号是 `mesh:<device_id>:<远端任务号>`，`GET /v1/agent/responses/{id}`、`/cancel` 自动转到那台设备 |
| 列表 | `/v1/models`、`/v1/agent/harnesses` 会带上其他设备的 |

## 模块

| 文件 | 职责 |
|---|---|
| `frames.js` | 一条流上的分帧（JSON 帧 + 字节帧） |
| `identity.js` | 设备密钥；证书签发、校验和准入（`scope` / `circles` / `team` 已预留） |
| `transport.js` | iroh 封装。只有它依赖 `@number0/iroh` |
| `tunnel.js` | HTTP 走隧道：发起端发请求；接收端校验白名单、换鉴权头，转给本机网关 |
| `directory.js` | 设备目录；描述里出现本机路径直接报错 |
| `scheduler.js` | 本地选设备（纯函数） |
| `workspaces.js` | 命名工作区 |
| `lan-discovery.js` | 局域网发现：UDP 组播 + 广播兜底，校验证书后交给节点拨号；断网也能用 |
| `node.js` | 节点：拨号、握手、presence、接收隧道请求、回环代理 |
| `glue.js` | 接进网关：`/v1/devices`、模型、智能体、本机描述 |

接入点：`local-gateway.js`（`/v1/models`、`/v1/devices`、模型请求、`knownKey`）、`agent-http.js`（`mine:` 寻址、`mesh:` 任务号、本人模式、工作区）、`cli/gateway.js`（启动和退出）。

## 配置（原型阶段手写）

`~/.tokenbank/mesh/config.json`：

```json
{
  "enabled": true,
  "user_id": "1001",
  "cert": "<设备证书 JWS>",
  "issuer_keys": [{ "kid": "…", "x": "…" }],
  "bind_addr": "0.0.0.0:41641",
  "peers": [{ "endpoint_id": "<对端公钥>", "direct_addrs": ["192.168.1.20:41641"] }],
  "lan_discovery": true,
  "lan_port": 41700,
  "relay_urls": [],
  "accept_model_requests": false
}
```

`~/.tokenbank/mesh/workspaces.json`：`{ "default": "tokenbank", "workspaces": { "tokenbank": { "path": "~/code/tokenbank" } } }`

## M0 验证结果（Linux x64，@number0/iroh 1.2.0）

| 项 | 结果 |
|---|---|
| 自定义 ALPN（`tokenbank/mesh/1`） | 通过 |
| 指定中继（`RelayMode.custom` + `authToken`） | 接口具备；未连真实中继验证 |
| 关闭 n0 发现（`applyMinimal`） | 通过：只靠配置的地址连接 |
| 局域网直连 | 通过：绑定 `0.0.0.0` 后，节点自动把本机网卡地址放进直连地址 |
| 局域网发现（mDNS） | 绑定里没有这个接口。**已用 Node `dgram` 补上**（`lan-discovery.js`）：组播 `239.255.77.77` + 广播兜底，每 5 秒一次，校验证书后才拨号。不需要 Rust |
| 跨网打洞 | iroh 内核支持，需要中继协助（Rust 版也一样）。绑定有自定义中继接口，待部署 TokenBank 中继后实测成功率 |
| 连接方式和延迟（`paths()`） | 通过：能区分 direct / relay，拿到 rtt |
| 双向流吞吐 | 本机回环约 **15.7 MB/s**，低于方案定的 50 MB/s 目标。原因是绑定用 JS 数组传字节。模型和智能体流量够用；大文件或 git bundle 要评估 |
| Electron 主进程加载、签名公证 | 未验证（本环境没有 macOS / Windows） |

## 原型和正式版的差距

- 证书由开发用签发方本地签发；正式版改成云端 `POST /mesh/cert`，签发方公钥内置进客户端。
- 同一局域网靠广播自动发现；跨网的对端地址目前写在配置里，正式版从云端地址簿 `GET /mesh/peers` 取，并在心跳里上报。
- 没有接中继，只验证了直连。
- 只接进了 CLI 网关；Electron `main.js` 还没接（接入方式相同：登录后 `startFromConfig`，退出时 `stop`）。
- 模型的「我的设备」层是简化版：只在本机除社区以外的供给源都没有这个模型时才用，还没排进 本机 → 我的设备 → 免费 → 社区 → 付费 的降级链。
- 设备描述里还没有会话列表（`mine:session:` 未实现）、负载是固定值。
- 产出：小文件随结果返回（现有逻辑），git bundle 和远程只读查看（设计 §8.4.3–8.4.5）未实现。
- 设备纳管页（UI）未做，数据接口 `/v1/devices` 已有。
- 统计里还没有 `route='mesh'`、`from_device` / `to_device`。
