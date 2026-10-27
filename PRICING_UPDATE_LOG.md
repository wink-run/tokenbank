# Provider Pricing Update - October 2026

## 已验证的官方定价来源

### 1. Anthropic (✓ 已验证)
**来源**: https://www.anthropic.com/pricing

最新模型:
- **Fable 5.1**: Input $10, Output $50, cacheRead $0.25, cacheWrite $12.50
- **Opus 5.5**: $4, $20, cacheRead $0.20, cacheWrite $5
- **Sonnet 5.5**: $2.50, $10
- **Haiku 5.5**: $0.50, $2.50, cacheRead $0.125 (≤100K), cacheWrite $0.625

旧模型:
- **Opus 4.8/4.7/4.6/4.5**: $5, $25, cacheRead $0.50, cacheWrite $6.25
- **Sonnet 4.6/4.5**: $3, $15, cacheRead $0.30, cacheWrite $3.75
- **Haiku 4.5**: $1, $5, cacheRead $0.10, cacheWrite $1.25

当前文件中的价格**正确**，无需更新。

### 2. xAI Grok (✓ 已验证)
**来源**: https://docs.x.ai/developers/pricing

官方定价:
- **grok-4.7**: Short context (<200k): $2 in, $0.50 cached, $6 out; Long (≥200k): $4 in, $1.00 cached, $12 out
- **grok-4.6**: 同上
- **grok-4.5**: Short: $2 in, $0.30 cached, $6 out; Long: $4 in, $0.60 cached, $12 out
- **grok-4.3**: Short: $1.25 in, $0.20 cached, $2.50 out; Long: $2.50 in, $0.40 cached, $5.00 out
- **grok-4**: $3 in, $15 out (无cacheRead信息)
- **grok-3-mini**: $0.30 in, $0.50 out
- **grok-build-0.1**: Short: $1 in, $0.20 cached, $2 out; Long: $2 in, $0.40 cached, $4 out

当前文件需要更新。

### 3. DeepSeek (✓ 已验证)
**来源**: https://api-docs.deepseek.com/quick_start/pricing

最新官方定价 (V3.2-Exp, 2025-09):
- **deepseek-flash**: $0.028 (cache hit), $0.28 (cache miss), $0.42 output
- **deepseek-v4-pro**: 价格未在最新文档中明确，但根据历史推断应为更高档位

当前文件中的价格 ($0.15/$0.60 for flash) **需要更新**为最新的off-peak后价格。

### 4. ZhiPu/智谱 (✓ 已验证)
**来源**: https://open.bigmodel.cn/pricing

官方定价 (CNY → USD按0.14转换):
- **GLM-5.3**: 8元/M input, 28元/M output, 2元/M cacheRead → $1.12 in, $3.92 out, $0.28 cached
- **GLM-5.3-Flash**: 标准价0.8元 input, 2.8元 output, 0.23元 cacheRead → $0.112 in, $0.392 out, $0.032 cached (限时五折更低)
- **GLM-5.2**: 同GLM-5.3
- **GLM-5.1**: [0,32K) 6元/24元, [32K+) 8元/28元, cacheRead 1.3元/2元 → 简化为 $0.86 in, $3.42 out, $0.19 cached
- **GLM-5**: 0.57元/2.57元 input/output, 0.14元 cacheRead → $0.08 in, $0.36 out, $0.02 cached
- **GLM-4.7**: 2元/8元, 0.4元 cacheRead → $0.28 in, $1.12 out, $0.056 cached
- **GLM-4.6**: 6元/22元, 1.1元 cacheRead → $0.84 in, $3.08 out, $0.15 cached

当前文件中的价格需要微调。

### 5. MiniMax (✓ 已验证)
**来源**: https://platform.minimax.io/docs/pricing/overview

官方定价:
- **minimax-m3.1-flash**: $0.15 in, $0.60 out, $0.015 cacheRead
- **minimax-m3**: $0.30 in (永久5折后), $1.20 out, $0.06 cacheRead (≤512k)
- **minimax-m3** (>512k): $0.60 in, $2.40 out, $0.12 cacheRead

当前文件价格**正确**。

### 6. Google Gemini (⚠ 部分验证)
**来源**: https://ai.google.dev/pricing (超时，无法验证)

当前文件中的价格基于历史记录：
- **gemini-2.5-pro**: $1.25 in, $10 out, $0.125 cacheRead, $1.56 cacheWrite
- **gemini-2.5-flash**: $0.3 in, $2.5 out, $0.03 cacheRead, $0.38 cacheWrite
- **gemini-2.0-flash**: $0.075 in, $0.3 out, $0.0075 cacheRead, $0.094 cacheWrite

**无法验证**，保持现有价格。

### 7. Volcengine/火山引擎 (⚠ 无法验证)
**来源**: 官方页面无完整定价信息

当前文件价格保持不变。

### 8. Agnes AI (❌ 无法验证)
**来源**: https://platform.agnes-ai.com/pricing (404)

当前文件显示免费（in: 0, out: 0），保持不变。

### 9. WorldRouter (⚠ 部分信息)
**来源**: https://router.worldclaw.ai/pricing (仅有概览，无详细价格)

当前文件价格基于推测，**无法完全验证**。

### 10. OpenRouter (跳过)
第三方聚合商，价格随时变化，不在此次更新范围内。

### 11. NVIDIA NIM (跳过)
免费额度，不涉及定价更新。

### 12. OpenAI/Fireworks (跳过)
用户要求仅在验证后更新，未进行验证。

## 更新决策

### 将要更新的部分:
1. **xAI/Grok**: 使用docs.x.ai的官方价格更新所有grok模型
2. **DeepSeek**: 更新为最新的V3.2-Exp价格
3. **ZhiPu**: 微调价格转换，添加GLM-5.3-Flash等新模型

### 保持不变:
1. **Anthropic**: 当前价格正确
2. **MiniMax**: 当前价格正确
3. **Gemini**: 无法验证，保持现状
4. **Volcengine**: 无完整官方信息
5. **Agnes AI**: 免费服务
6. **WorldRouter DeepSeek**: 无法验证准确价格

### 跳过的部分:
1. **OpenRouter**: 第三方聚合商
2. **NVIDIA**: 免费额度
3. **OpenAI/Fireworks**: 未进行官方验证
4. **其他未列出的provider**: 不在优先级列表中
