# Provider Pricing & Model List Update Log

## 2026-10-28: 完整验证更新 (DeepSeek, xAI, ZhiPu, Anthropic, Gemini)

### 🔹 **DeepSeek** (已验证 2026-10-28)
**官方来源**: https://api-docs.deepseek.com/quick_start/pricing/

**off-peak 空闲时段定价**（USD per M tokens）：
- `deepseek-flash` (V4-Flash)
  - Input: $0.15 (CNY 1 ÷ 7)
  - Output: $0.60 (CNY 4 ÷ 7)
  - Cache Read: $0.003 (CNY 0.02 ÷ 7)
  - **不含 cacheWrite**（官方页面未列 cache write 价格，删除该字段）

- `deepseek-v4-pro`
  - Input: $0.66
  - Output: $1.98
  - Cache Read: $0.022
  - **不含 cacheWrite**

**说明**: 采用 off-peak 价格（peak 为 2× off-peak）。删除先前错误的 $0.28/$0.42 虚构价格。

---

### 🔹 **xAI (Grok)** (已验证 2026-10-28)
**官方来源**: https://docs.x.ai/docs/models

**Text API 表格**当前列出的模型（USD per M tokens）：
- `grok-4.7`: Input $2.00, Output $6.00, Cache Read $0.50
- `grok-4.6`: Input $2.00, Output $6.00, Cache Read $0.50
- **`grok-4.5` (新增)**: Input $2.00, Output $6.00, Cache Read $0.30
- **`grok-4.3` (新增)**: Input $1.25, Output $2.50, Cache Read $0.20
- ~~grok-4~~: 官方未列，已删除
- ~~grok-3-mini~~: 官方未列，已删除

**说明**: 不含 cacheWrite。

---

### 🔹 **ZhiPu AI (GLM)** (已验证 2026-10-28)
**官方来源**: https://docs.z.ai/guides/overview/pricing

**Z.AI USD 价格表** (per M tokens)：
- **`glm-5.3` (更新)**: Input $1.40, Output $4.40, Cached Input $0.26
  - 原: $1.14/$3.99/$0.29
- **`glm-5.3-flash` (新增)**: Input $0.15, Output $0.50, Cached Input $0.03
- **`glm-5.3-flashx` (新增)**: Input $0.37, Output $1.25, Cached Input $0.075
- **`glm-5.2` (更新)**: Input $1.40, Output $4.40, Cached Input $0.26
  - 原: $1.14/$3.99/$0.29
- **`glm-5.1` (更新)**: Input $1.40, Output $4.40, Cached Input $0.26
  - 原: $0.86/$3.42/$0.19
- **`glm-5` (更新)**: Input $1.00, Output $3.20, Cached Input $0.20
  - 原: $0.57/$2.57/$0.14
- **`glm-4.7` (更新)**: Input $0.60, Output $2.20, Cached Input $0.11
  - 原: $0.29/$1.14/$0.06
- **`glm-4.6` (更新)**: Input $0.60, Output $2.20, Cached Input $0.11
  - 原: $0.86/$3.14/$0.16

**说明**: Z.AI USD 表格与 open.bigmodel.cn CNY 表格有差异，采用 Z.AI USD 官方刊例价。未列 cacheWrite。

---

### 🔹 **Anthropic Claude** (已验证 2026-10-28)
**官方来源**: https://docs.anthropic.com/en/docs/about-claude/pricing

**新增 Claude 5.x 系列** (USD per M tokens)：
- **`claude-fable-5-1` (新增)**:
  - Base Input: $10.00
  - Output: $50.00
  - Cache Hits: $0.25 (0.025× 基准)
  - 5m Cache Writes: $12.50

- **`claude-opus-5-5` (新增)**:
  - Base Input: $4.00
  - Output: $20.00
  - Cache Hits: $0.20 (0.05× 基准)
  - 5m Cache Writes: $5.00

- **`claude-sonnet-5-5` (新增)**:
  - Base Input: $2.00
  - Output: $10.00
  - Cache Hits: $0.10 (0.05× 基准)
  - 5m Cache Writes: $2.50

- **`claude-haiku-5-5` (新增)**:
  - Base Input (≤100K tokens): $0.10
  - Base Input (>100K tokens): $0.50
  - Output (≤100K): $0.50
  - Output (>100K): $2.50
  - Cache Hits (≤100K): $0.01
  - Cache Hits (>100K): $0.05
  - 5m Cache Writes (≤100K): $0.125
  - 5m Cache Writes (>100K): $0.625
  - **注**: 配置中采用 ≤100K 价格档

**保留 Claude 4.x 系列**：
- `claude-opus-4-6`: $5/$25, cache $0.50/$6.25
- `claude-sonnet-4-6`: $3/$15, cache $0.30/$3.75
- `claude-sonnet-4-5`: $3/$15, cache $0.30/$3.75
- `claude-haiku-4-5`: $1/$5, cache $0.10/$1.25

**说明**: cacheWrite 为 5-minute cache 写入价格；cacheRead 为 cache hits 价格。

---

### 🔹 **Google Gemini** (已验证 2026-10-28)
**官方来源**: https://ai.google.dev/gemini-api/docs/pricing

**新增模型** (USD per M tokens, 当前促销价)：
- **`gemini-4-argon` (新增)**:
  - Input: $2.00 (通过 2026-11-30; 之后 $4.00)
  - Output: $10.00 (通过 2026-11-30; 之后 $20.00)
  - Context Caching: $0.10 (通过 2026-11-30; 之后 $0.20)
  - **注**: Implicit caching only; 仅 Paid tier 可用
  
- **`gemini-3.8-flash` (新增)**:
  - Input: $0.75 (通过 2026-12-31; 之后 $1.50)
  - Output: $3.75 (通过 2026-12-31; 之后 $7.50)
  - Context Caching: $0.075 (通过 2026-12-31; 之后 $0.15)

- **`gemini-3.6-flash` (新增)**:
  - Input: $0.75 (通过 2026-12-31; 之后 $1.50)
  - Output: $3.75 (通过 2026-12-31; 之后 $7.50)
  - Context Caching: $0.075 (通过 2026-12-31; 之后 $0.15)

**保留已有模型**：
- `gemini-2.5-pro`: $1.25/$10.00, cache $0.125/$1.56
- `gemini-2.5-flash`: $0.30/$2.50, cache $0.03/$0.38
- `gemini-2.0-flash`: $0.075/$0.30, cache $0.0075/$0.094

**说明**: 配置中采用当前促销价格（有效期至2026年底或2027年初）。

---

## 其他供应商状态

### ❌ **Volcengine / Volcengine-ark**
**官方来源**: https://www.volcengine.com/ 文档
- 未找到官方 `kimi-k3.1-pro` 模型名称的明确文档
- 官方curl检索无结果
- **结果**: 保持现有 `kimi-k3` 名称，不做重命名

### ❌ **Agnes AI**
**官方来源**: https://github.com/AgnesAI-Labs/AgnesAI-Models (MODEL_CATALOG.md, 2026-07-30)
- 官方模型目录显示: `agnes-1.5-flash`, `agnes-2.0-flash`, `agnes-2.5-flash`
- Wiki 文档显示新增: `agnes-3.0-flash` (HuggingFace 预览版), `agnes-2.5-pro`, `agnes-3.0-pro` (即将推出)
- **无官方定价页面**
- **结果**: 无法验证定价，跳过更新。现有配置如有价格则保留，否则不添加。

---

## 更新文件清单
✅ `server/static/defaults/providers.registry.yaml` (providers + billing_sources)
✅ `client/electron/config/providers.registry.yaml` (providers + billing_sources)
✅ `client/electron/pricing.js` (PRICING 全局映射表)
✅ `PRICING_UPDATE_LOG.md` (本文档)

---

## 校验总结
| 供应商 | 状态 | 官方URL | 备注 |
|--------|------|---------|------|
| DeepSeek | ✅ 已验证并更新 | https://api-docs.deepseek.com/quick_start/pricing/ | 采用 off-peak 价格 |
| xAI (Grok) | ✅ 已验证并更新 | https://docs.x.ai/docs/models | 新增 4.5/4.3，删除 4/3-mini |
| ZhiPu AI | ✅ 已验证并更新 | https://docs.z.ai/guides/overview/pricing | 新增 5.3-flash/flashx，全面更新 USD 价格 |
| Anthropic | ✅ 已验证并新增 | https://docs.anthropic.com/en/docs/about-claude/pricing | 新增完整 Claude 5.x 系列 |
| Google Gemini | ✅ 已验证并新增 | https://ai.google.dev/gemini-api/docs/pricing | 新增 4-argon/3.8-flash/3.6-flash |
| Volcengine | ⚠️ 跳过 | https://www.volcengine.com/docs/ | 无 kimi-k3.1-pro 官方证据 |
| Agnes AI | ⚠️ 跳过 | https://github.com/AgnesAI-Labs/AgnesAI-Models | 官方无定价页面 |

**最后更新**: 2026-10-28
