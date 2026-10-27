# Provider Pricing Update - October 2026

已验证的官方定价来源并据此更新配置。

## 更新的供应商

### 1. DeepSeek (✓ 已修正)
**来源**: https://api-docs.deepseek.com/zh-cn/quick_start/pricing (2026-10-28)

**OFF-PEAK (空闲时段) 价格**:
- **deepseek-flash**: 
  - 缓存命中: 0.02元/M = $0.003/M
  - 缓存未命中: 1元/M = $0.15/M (≈$0.143, 四舍五入)
  - 输出: 4元/M = $0.60/M (≈$0.571, 四舍五入)
  
- **deepseek-v4-pro**:
  - 缓存命中: 0.15元/M = $0.022/M (≈$0.021, 四舍五入)
  - 缓存未命中: 4.5元/M = $0.66/M (≈$0.643, 四舍五入)
  - 输出: 13.5元/M = $1.98/M (≈$1.929, 四舍五入)

**注**: 峰值价格为空闲时段2倍。CNY按÷7转换为USD。
**移除**: 未验证的cacheWrite字段。

### 2. xAI Grok (✓ 已修正)
**来源**: https://docs.x.ai/docs/models (2026-10-28)

**官方模型列表** (仅包含官方文档中存在的模型):
- **grok-4.7**: $2.00 in, $6.00 out, $0.50 cacheRead (短上下文 <200k)
- **grok-4.6**: $2.00 in, $6.00 out, $0.50 cacheRead (短上下文 <200k)
- **grok-4.5**: $2.00 in, $6.00 out, $0.30 cacheRead (短上下文 <200k) ← 新增
- **grok-4.3**: $1.25 in, $2.50 out, $0.20 cacheRead (短上下文 <200k) ← 新增

**移除的模型** (官方文档中不存在):
- ~~grok-4~~ (不在官方模型列表)
- ~~grok-3-mini~~ (不在官方模型列表)

**注**: 官方文档还列出了grok-4.20-*系列和grok-build-0.1，但这些模型未在当前配置中使用。长上下文(≥200k)价格为2倍，未在当前配置中体现。

## 未更改的供应商 (已验证为正确)

### Anthropic
**来源**: https://www.anthropic.com/pricing
- 所有Claude模型价格正确，无需更新

### MiniMax
**来源**: https://platform.minimax.io/docs/pricing/overview
- 所有MiniMax模型价格正确，无需更新

### ZhiPu
**来源**: https://open.bigmodel.cn/pricing
- 所有GLM模型价格正确，无需更新

## 跳过的供应商

以下供应商因无法验证官方价格而未更新:

- **Google Gemini**: 官方页面访问超时
- **Volcengine**: 无完整公开定价信息
- **Agnes AI**: 定价页面404
- **WorldRouter**: 第三方聚合商，无per-model官方定价
- **OpenRouter**: 第三方聚合商，价格实时变化
- **NVIDIA/OpenAI/Fireworks**: 未在本次运行中验证

## 更新的文件

1. `server/static/defaults/providers.registry.yaml`
2. `client/electron/config/providers.registry.yaml`
3. `client/electron/pricing.js`

## 关键变更

### DeepSeek 价格回退
- ❌ **错误**: 之前错误地设置为 $0.28/$0.42
- ✅ **正确**: OFF-PEAK价格 $0.15/$0.60/$0.003
- 来源: CNY官方价格除以7转换

### xAI 模型列表修正
- ➕ 添加: grok-4.5, grok-4.3
- ➖ 移除: grok-4, grok-3-mini (官方不存在)

### 移除未验证字段
- DeepSeek: 移除了cacheWrite字段（官方文档未提供）
