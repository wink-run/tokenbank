# Local LLM Proxy — 完整设计文档

> 状态：**已确认，待开发**
> 更新：2026-05-11

---

## 1. 项目定位

让用户能够在非局域网内访问局域网内才能授权访问的大模型接口。
本地 PC 主动向 VPS 建立 WebSocket 长连接，将自身内网 LLM 算力贡献到云端，
形成一个去中心化的 LLM 共享网络，贡献者可通过积分体系换取其他模型的使用权。

---

## 2. 整体架构

```
外部用户 / 贡献者 / 访客
    │
    ├─ POST /v1/*            调用 LLM（持 USER_API_KEY）
    ├─ GET  /dashboard       运营大屏（公开）
    ├─ GET  /                产品落地页（公开）
    └─ GET  /admin/ui        管理控制台（持 ADMIN_KEY）
    │
    ▼
┌──────────────────────────────────────────────────────┐
│                VPS — FastAPI (0.0.0.0:8000)           │
│                                                      │
│  用户 API      Worker 接入      Admin       大屏       │
│  /v1/*         /ws/worker       /admin/*    /dashboard│
│                                                      │
│  积分结算器（每 5 分钟批量运行）                         │
│                                                      │
│  SQLite  proxy.db                                    │
└──────────────────┬───────────────────────────────────┘
                   │ WebSocket（本地主动发起，穿透 NAT）
        ┌──────────┴──────────┐
        │                     │
  本地 PC A               本地 PC B
  llm-agent binary        llm-agent binary
  Premium LLM             Open LLM
```

---

## 3. 模型分层体系

**两层模型**，管理员可在后台配置每个模型的归属和积分率。

| 层级 | 名称 | 典型模型 |
|------|------|----------|
| Tier 0 | Premium | GPT-4o、Claude 3.5、Gemini 1.5 Pro |
| Tier 1 | Open | Qwen3-32B、DeepSeek-R1、Llama3、Qwen3-7B 等 |

### model_configs 表字段

| 字段 | 说明 |
|------|------|
| `name` | 模型名，与 Agent 上报一致 |
| `tier` | `premium` / `open` |
| `contribute_rate` | 每贡献 1K output token 获得积分数 |
| `consume_rate` | 每消费 1K token 扣除积分数 |
| `enabled` | 是否在用户侧可用 |
| `display_name` | 前台展示名（可选别名） |

### 默认积分率参考

| 行为 | 积分 |
|------|------|
| 贡献 1K output @ Premium | +50 |
| 贡献 1K output @ Open | +8 |
| 消费 1K token @ Premium | -40 |
| 消费 1K token @ Open | -5 |

> 管理员可在后台随时调整，调整后新结算周期生效。

---

## 4. 积分体系

### 4.1 单一积分货币

全平台使用统一积分，不区分 Premium / Open 子钱包，
贡献者用积分自由换购任意层级的消费额度（通过消费接口时扣除对应 consume_rate）。

### 4.2 积分来源

| 来源 | 触发时机 | 金额 |
|------|----------|------|
| 贡献处理 token | 每 5 分钟结算 | output_tokens × rate × quality_multiplier |
| 推荐新用户注册 | 注册完成时即时发放（一次性） | 管理员配置的固定值 |
| 新用户注册礼包 | 注册完成时即时发放 | 管理员配置的固定值 |
| 线下购买充值 | 管理员审批后手动发放 | 购买金额换算 |

### 4.3 积分消耗

- 每次 `/v1/chat/completions` 请求完成后，从用户余额扣除
  `(input_tokens + output_tokens) × model.consume_rate / 1000`
- 余额不足：返回 `402` 并提示充值
- 积分永不过期

---

## 5. 质量乘数（贡献加成）

```
quality_multiplier = 0.4×在线因子 + 0.4×延迟因子 + 0.2×稳定性因子
```

| 因子 | 计算方式 | 范围 |
|------|----------|------|
| 在线时长 | 结算周期内在线分钟数 / 总分钟数 | 0.5 ~ 1.3 |
| 平均延迟 | `min(500 / avg_ttfb_ms, 1.5)` | 0.6 ~ 1.5 |
| 稳定性 | 成功请求 / 总请求（成功率） | 0.5 ~ 1.2 |

**最终乘数范围**：0.5x ～ 1.5x（超出截断）

### 星级映射

| 质量乘数 | 星级 |
|----------|------|
| < 0.7 | ★☆☆☆☆ |
| 0.7 ~ 0.9 | ★★☆☆☆ |
| 0.9 ~ 1.1 | ★★★☆☆ |
| 1.1 ~ 1.3 | ★★★★☆ |
| ≥ 1.3 | ★★★★★ |

---

## 6. 用户账户体系

### 6.1 注册方式

邮箱自助注册，发送验证码确认。

### 6.2 users 表

| 字段 | 说明 |
|------|------|
| `id` | 主键 |
| `email` | 邮箱（唯一） |
| `nickname` | 昵称（大屏展示用） |
| `password_hash` | bcrypt |
| `credits_balance` | 当前余额 |
| `credits_earned` | 累计获得 |
| `credits_spent` | 累计消耗 |
| `referral_code` | 专属推荐码（REF-XXXXXX） |
| `referred_by` | 被谁推荐（user_id） |
| `show_on_wall` | 是否同意展示在鸣谢墙（默认 true） |
| `wall_display` | 展示方式：nickname / masked / hidden |
| `created_at` | 注册时间 |

---

## 7. 推荐分享体系

### 7.1 推荐链接

`https://vps.com/?ref=REF-ABC123`

新用户通过该链接注册时自动绑定推荐关系。

### 7.2 奖励规则（一次性）

| 事件 | 被推荐人 | 推荐人 |
|------|----------|--------|
| 注册完成 | +Q 积分（新人礼包） | +R 积分（推荐奖励） |

Q、R 由管理员在后台配置。

### 7.3 鸣谢用户墙

- 展示位置：产品落地页 `/`
- 排序：综合排名（贡献 token 量 × 0.5 + 推荐人数 × 0.3 + 在线天数 × 0.2）
- 展示人数：前 50 名
- 脱敏规则：

| 原始昵称 | 展示 |
|----------|------|
| 张三 | 张* |
| 李小明 | 李*明 |
| John Smith | Jo\*\* S\* |
| DESKTOP-ABC | DE\*\*\*\*BC |

- 用户可自选：显示昵称 / 脱敏 / 不展示

---

## 8. 购买充值流程

无在线支付网关，采用线下联系方式：

1. 用户在个人页点击「购买积分」，填写：期望积分数量 + 留言
2. 页面展示管理员联系方式（微信 / 邮箱，管理员在后台配置）
3. 线下完成转账后，管理员在 Admin UI「购买审批」页手动充值
4. 用户余额实时更新，交易记录写入 `transactions`

---

## 9. 运营大屏（/dashboard，公开）

### 9.1 布局

```
┌─────────────────────────────────────────────────────────────┐
│  🌐 LLM Proxy 运营大屏                    实时 SSE 推送      │
├────────────┬───────────────┬─────────────┬──────────────────┤
│ 在线贡献者  │ 今日处理量     │ 累计贡献者  │ 平台运行天数      │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  贡献者卡片网格（实时更新）                                    │
│                                                             │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐      │
│  │🟢 张*    │ │🟢 Jo** S*│ │🟡 DE***BC│ │⚫ 李**   │      │
│  │★★★★★    │ │★★★★☆    │ │★★★☆☆    │ │★★☆☆☆    │      │
│  │Premium   │ │Open      │ │Open      │ │Open      │      │
│  │今日 42K↑ │ │今日 18K↑ │ │今日 6K↑  │ │离线 2h   │      │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘      │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│ 📡 实时动态                                                   │
│  · He** 上线，贡献模型: qwen3-32b                             │
│  · 张* 今日贡献突破 50K tokens 🎉                              │
│  · Jo** S* 离线                                              │
└─────────────────────────────────────────────────────────────┘
```

### 9.2 在线状态

| 状态 | 图标 | 定义 |
|------|------|------|
| 在线 | 🟢 | WebSocket 连接活跃 |
| 空闲 | 🟡 | 连接正常但 >30min 无请求 |
| 离线 | ⚫ | 已断开，近 7 日内有贡献则保留展示 |

### 9.3 推送机制

- 服务端维护一个 SSE 广播器
- Worker 上线 / 下线 / 5 分钟结算完成 时广播事件
- 大屏前端订阅 `/dashboard/stream`（SSE）实时更新

### 9.4 动态滚动内容

仅展示：上线事件、下线事件、里程碑（今日 token 突破整万）
不展示：具体请求、积分数额、用户 ID

---

## 10. 用户个人看板

用户登录后可见以下模块：

```
【积分概览】
  今日贡献 / 累计贡献 / 余额 / 质量乘数

【我的 API Keys】（仅 can_create_apikey=true 时显示）
  ┌──────────────────────────────────────────────────────┐
  │ [+ 新建 Key]  备注输入框                              │
  │                                                      │
  │ Key             备注   状态  创建时间  操作            │
  │ sk-xxx…abc  测试用  启用  2026-05-09  复制|禁用|删除  │
  └──────────────────────────────────────────────────────┘
  · 每个 Key 消费时从本账户余额扣积分
  · 余额不足时 Key 自动返回 402

【贡献结算明细】（最近 N 次，5 分钟一条）
  时间 | 模型 | Token量 | 基础积分 | 质量乘数 | 实得积分

【质量乘数构成】
  在线时长 X h → 因子 a（权重 40%）
  平均延迟 X ms → 因子 b（权重 40%）
  成功率 X%    → 因子 c（权重 20%）
  合计乘数: Y x

【积分流水】
  时间 | 类型（贡献/消费/推荐/充值）| 模型 | 变动 | 余额

【购买积分】
  填写期望积分数 + 留言 → 展示管理员联系方式
```

---

## 11. Admin 控制台新增模块

| 模块 | 功能 |
|------|------|
| 模型管理 | 增删改模型配置（层级、积分率、启停） |
| 用户管理 | 用户列表、余额查看、手动调整积分 |
| 购买审批 | 查看线下购买申请，手动充值，充值后可一键开启该用户的 API Key 生成权限 |
| 积分配置 | 推荐奖励 Q/R、新人礼包、联系方式 |
| 流水明细 | 全局交易记录，可按用户 / 类型筛选 |

---

## 12. 数据库完整 Schema

### users
```sql
CREATE TABLE users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    email         TEXT UNIQUE NOT NULL,
    nickname      TEXT DEFAULT '',
    password_hash TEXT NOT NULL,
    credits_balance REAL DEFAULT 0,
    credits_earned  REAL DEFAULT 0,
    credits_spent   REAL DEFAULT 0,
    referral_code TEXT UNIQUE NOT NULL,
    referred_by   INTEGER REFERENCES users(id),
    show_on_wall  INTEGER DEFAULT 1,
    wall_display  TEXT DEFAULT 'masked',   -- nickname / masked / hidden
    can_create_apikey INTEGER DEFAULT 0,   -- 管理员开启后用户可自助生成 API Key
    created_at    TEXT DEFAULT (datetime('now'))
);
```

### model_configs
```sql
CREATE TABLE model_configs (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT UNIQUE NOT NULL,
    display_name    TEXT DEFAULT '',
    tier            TEXT NOT NULL,         -- premium / open
    contribute_rate REAL NOT NULL,         -- 积分/1K output tokens
    consume_rate    REAL NOT NULL,         -- 积分/1K tokens
    enabled         INTEGER DEFAULT 1,
    created_at      TEXT DEFAULT (datetime('now'))
);
```

### transactions
```sql
CREATE TABLE transactions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id),
    type        TEXT NOT NULL,    -- contribute / consume / referral / purchase / adjust
    model_name  TEXT,
    tokens      INTEGER,
    base_credits REAL,
    multiplier  REAL DEFAULT 1.0,
    delta       REAL NOT NULL,    -- 正=收入 负=支出
    balance     REAL NOT NULL,    -- 变动后余额
    note        TEXT DEFAULT '',
    created_at  TEXT DEFAULT (datetime('now'))
);
```

### worker_sessions
```sql
CREATE TABLE worker_sessions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER REFERENCES users(id),
    worker_id   TEXT NOT NULL,
    name_masked TEXT NOT NULL,
    models      TEXT NOT NULL,    -- JSON 数组
    connected_at TEXT,
    disconnected_at TEXT,
    total_requests  INTEGER DEFAULT 0,
    success_requests INTEGER DEFAULT 0,
    total_output_tokens INTEGER DEFAULT 0,
    avg_latency_ms REAL DEFAULT 0
);
```

### settlement_logs
```sql
CREATE TABLE settlement_logs (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    worker_id    TEXT NOT NULL,
    user_id      INTEGER REFERENCES users(id),
    period_start TEXT NOT NULL,
    period_end   TEXT NOT NULL,
    online_mins  REAL DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    avg_latency  REAL DEFAULT 0,
    success_rate REAL DEFAULT 0,
    multiplier   REAL DEFAULT 1.0,
    credits_awarded REAL DEFAULT 0,
    created_at   TEXT DEFAULT (datetime('now'))
);
```

### purchase_orders
```sql
CREATE TABLE purchase_orders (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id),
    amount_credits REAL NOT NULL,
    note        TEXT DEFAULT '',
    status      TEXT DEFAULT 'pending',   -- pending / approved / rejected
    admin_note  TEXT DEFAULT '',
    created_at  TEXT DEFAULT (datetime('now'))
);
```

### api_keys（原表扩展）
```sql
-- 在原表基础上增加：
ALTER TABLE api_keys ADD COLUMN user_id INTEGER REFERENCES users(id);
-- user_id = NULL 表示管理员直接创建的全局 Key（不受积分限制）
-- user_id != NULL 表示用户自助生成的 Key（消费时扣除该用户积分）
```

### system_config
```sql
CREATE TABLE system_config (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
-- 存储：referral_reward, newcomer_reward, contact_info 等管理员配置项
```

---

## 13. 文件结构（最终）

```
local-llm-proxy/
├── server/
│   ├── server.py           主程序 + WebSocket 接入 + 落地页
│   ├── worker_pool.py      Worker 连接池（内存）
│   ├── database.py         SQLite 基础操作
│   ├── dispatch.py         请求路由 + 流式转发
│   ├── admin_router.py     管理 API
│   ├── user_router.py      用户注册/登录/个人看板 API
│   ├── dashboard_router.py 运营大屏 + SSE 推送
│   ├── settler.py          5 分钟积分结算器（asyncio 后台任务）
│   ├── static/
│   │   ├── admin.html      管理控制台（Vue 3）
│   │   ├── dashboard.html  运营大屏（Vue 3）
│   │   ├── dev.html        首页 / 开发者概览
│   │   └── app.html        用户前台（注册/登录/看板）
│   └── requirements.txt
├── agent/
│   ├── agent.py            本地 PC 客户端 + CLI
│   ├── requirements.txt
│   └── build.sh
├── tests/
│   └── mock_llm.py
├── docker-compose.yml
└── .env.example
```

---

## 14. 技术栈

| 层次 | 技术 |
|------|------|
| 服务端框架 | FastAPI + uvicorn |
| 数据库 | SQLite + aiosqlite |
| 实时推送 | SSE（大屏）/ asyncio.Queue（Worker 消息） |
| 认证 | JWT（用户）/ Bearer ADMIN_KEY（管理员）/ Worker Key `wk-…`（Agent WebSocket，按用户存库）|
| 前端 | Vue 3 CDN + 无构建步骤 |
| 密码 | bcrypt |
| Agent 分发 | PyInstaller 单文件二进制 |
| 容器化 | Docker Compose |
