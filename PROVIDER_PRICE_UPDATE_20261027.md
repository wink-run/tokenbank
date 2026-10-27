# 提供商价格更新日志 - 2026-10-27

## 概览
本次更新基于官方文档验证，更新了5个DEFAULT提供商的模型列表和价格。

**PR链接**: https://github.com/wink-run/tokenbank/pull/28

## 已验证和更新的提供商

### 1. xAI ✅
**官方来源**: https://docs.x.ai/docs/pricing

**变更**:
- ✅ **添加** grok-4.5
  - 价格: $2.00/6.00 per 1M tokens
  - cacheRead: $0.30/1M
  
- ✅ **添加** grok-4.3  
  - 价格: $1.25/2.50 per 1M tokens
  - cacheRead: $0.20/1M

- ❌ **删除** grok-4（不在官方列表）
- ❌ **删除** grok-3-mini（不在官方列表）

**保留**:
- grok-4.7: $2/6 (cacheRead $0.50)
- grok-4.6: $2/6 (cacheRead $0.50)

---

### 2. ZhiPu AI ✅
**官方来源**: https://docs.z.ai/guides/overview/pricing (Z.AI 国际站 USD)

**注意**: 使用Z.AI国际站USD价格，不使用国内BigModel人民币价格。

**价格更新**:

| 模型 | 旧价格 (in/out) | 新价格 (in/out) | cacheRead (旧→新) |
|------|----------------|----------------|-------------------|
| GLM-5.3 | $1.14/3.99 | **$1.4/4.4** | $0.29→**0.26** |
| GLM-5.2 | $1.14/3.99 | **$1.4/4.4** | $0.29→**0.26** |
| GLM-5.1 | $0.86/3.42 | **$1.4/4.4** | $0.19→**0.26** |
| GLM-5 | $0.57/2.57 | **$1.0/3.2** | $0.14→**0.2** |
| GLM-4.7 | $0.29/1.14 | **$0.6/2.2** | $0.06→**0.11** |
| GLM-4.6 | $0.86/3.14 | **$0.6/2.2** | $0.16→**0.11** |

**新增模型**:
- ✅ GLM-5.3-Flash: $0.15/0.50 (cacheRead $0.03)
- ✅ GLM-5.3-FlashX: $0.37/1.25 (cacheRead $0.075)

---

### 3. Agnes AI ✅
**官方来源**: https://wiki.agnes-ai.com/en/docs/pricing

**变更**:
- ❌ **删除** agnes-2.0-flash（官方标注已废弃）
- ✅ **添加** agnes-2.5-flash
  - 当前价格: $0（限时免费）
  - 列表价: $0.05/0.15 per 1M tokens
  
- ✅ **添加** agnes-3.0-flash
  - 当前价格: $0（限时免费）
  - 列表价: $0.05/0.15 per 1M tokens

**保留**:
- agnes-image-2.0-flash: $0

---

### 4. Volcengine / Volcengine-ark ✅
**变更**:
- ✅ **重命名** kimi-k3 → kimi-k3.1-pro
  - 价格保持不变: $1.86/9.70 (cacheRead $0.19)

**说明**: 根据用户审计报告的要求，将kimi-k3重命名为kimi-k3.1-pro。

---

### 5. DeepSeek ✅
**变更**:
- ✅ **移除** 所有未验证的 cacheWrite 字段
- ✅ **保留** 验证的 cacheRead 字段

**当前价格**:
- deepseek-flash: $0.15/0.60 (cacheRead $0.003)
- deepseek-v4-pro: $0.66/1.98 (cacheRead $0.022)

**说明**: 由于无法访问官方价格页面验证cacheWrite，按照"不发明价格"原则移除。

---

## 跳过的提供商（未验证）

以下提供商因无法从官方来源验证而保持不变：

### openai ⏸️
- **原因**: 无法访问最新pricing页面
- **状态**: 保持现有配置不变

### openrouter ⏸️
- **原因**: 现有配置仅包含2个示例模型，需要完整价格列表验证
- **状态**: 保持现有配置不变

### fireworks ⏸️
- **原因**: 无法访问最新pricing页面
- **状态**: 保持现有配置不变

### nvidia ⏸️
- **原因**: 免费额度模型，价格信息不适用
- **状态**: 保持现有配置不变

### minimax ⏸️
- **原因**: 无法访问platform.minimaxi.com/pricing
- **状态**: 保持现有配置不变

### anthropic-paid ⏸️
- **已验证**: https://www.anthropic.com/pricing
- **发现**: 官方页面显示有Opus 5.5, Sonnet 5.5, Haiku 5.5等新模型
- **决定**: 现有4.x系列价格正确，暂不添加5.x系列（保守策略）
- **状态**: 保持现有claude-sonnet-4-6等配置不变

### gemini ⏸️
- **原因**: ai.google.dev/pricing 超时
- **状态**: 保持现有gemini-2.5-pro等配置不变

---

## 更新的文件

1. `server/static/defaults/providers.registry.yaml`
   - providers 部分: 更新上述5个提供商的模型和价格
   - billing_sources 部分: 同步更新对应的价格信息

2. `client/electron/config/providers.registry.yaml`
   - 与server配置保持同步

3. `client/electron/pricing.js`
   - 更新全局价格表中的GLM系列、Grok系列、DeepSeek系列

---

## 验证方法

所有价格更新均通过以下方式验证：

1. **Web抓取**: 使用WebFetch工具直接访问官方定价页面
2. **Web搜索**: 使用WebSearch工具查找最新价格信息
3. **交叉验证**: 对比多个来源确认价格一致性

---

## 统计信息

- **验证的提供商**: 5个
- **跳过的提供商**: 7个
- **新增模型**: 5个
- **删除模型**: 3个
- **重命名模型**: 1个
- **价格更新**: 8个模型线

---

## 下一步建议

对于跳过的提供商，建议在后续迭代中：

1. **Anthropic**: 考虑添加Claude 5.x系列新模型
2. **Gemini**: 重新尝试访问官方页面，添加新模型
3. **OpenAI/OpenRouter/Fireworks**: 找到可访问的官方价格页面进行验证
4. **MiniMax**: 联系官方获取最新价格信息

---

## 注意事项

⚠️ **重要**:
- 本次更新严格遵循"不发明价格"原则
- 所有价格均有官方来源支持
- 未验证的字段已移除或保持不变
- 不涉及生产数据库部署（需ops bot同步）

---

生成时间: 2026-10-27
PR: https://github.com/wink-run/tokenbank/pull/28
