# OpenDecision 接入：可选场景分类与故障回退

TokenBank 只集成 HTTP 客户端，不打包 Python、模型权重或管理服务进程。
OpenDecision 需独立部署，建议仅监听 `127.0.0.1:18080`，避免与 SillyTavern
默认的 `8000` 冲突。此端口是 TokenBank 的接入约定，修改客户端并不会改变服务监听端口。

## 启用顺序

1. 独立部署服务并预热模型；确认 `/health` 以及真实 `/v1/systemone` 请求均成功。
   `/health` 成功只说明可达，不能证明权重已下载或推理已就绪。
2. 先保持 `engine: llm`，手动启用 `jev_shadow` 做旁路验证。
3. 使用实际中文、多轮和不同任务类型样本评估准确性与延迟，之后才改成 `systemone`。
   OpenDecision 不是 Jev 官方权重；分数不是校准后的正确率，`0.35` 只是可调初始值。

内置默认是 `engine: llm`、`jev_shadow.enabled: false`，未部署服务也不增加网络请求。
配置加载顺序：内置默认 < `~/.tokenbank/tokenbank.yaml` 的 routing 段
< `~/.llm-agent/config.json` 中显式存在的 routing 字段；后者保留旧版兼容。
修改文件后重启 TokenBank，或通过现有配置重载流程生效；不要假设文件会被实时监听。
以下是应合并到已有 YAML 的字段，不要用它覆盖整个用户配置文件：

```yaml
routing:
  decision_classifier:
    engine: llm
    enabled: true
    provider: opendecision
    endpoint: http://127.0.0.1:18080/v1/systemone
    fallback_llm: true
    min_confidence: 0.35
    timeout_ms: 1500
    llm_timeout_ms: 3000
    max_chars: 600
    health_check: true
    failure_threshold: 3
    cooldown_ms: 30000
    max_concurrent: 2
  jev_shadow:
    enabled: true
    provider: opendecision
    endpoint: http://127.0.0.1:18080/v1/systemone
    timeout_ms: 1500
```

只有含 `when.type: classifier` 的场景会调用分类器。输入取当前最后一条用户消息；
没有用户文本时放弃分类，不把系统提示或旧历史当作新意图。普通模型直连路径不受影响。
真实路由模式不额外发出 shadow 请求；两种模式的服务地址配置互相独立。

## 桌面管理面板

设置页的 **OpenDecision · 本地分类** 提供：

- 读取有效模式、地址、熔断状态；读取状态本身不会联网或修改配置。
- 检查连接与真实分类：只发送内置示例，不发送聊天记录，也不调用 LLM 回退。
  诊断请求不改动生产缓存、熔断器或路由统计。通过不代表分类准确率合格。
- 开启旁路：先检查，再保存 runtime routing 覆盖，保持 `engine: llm`。
- 关闭并回退：即使服务离线也可关闭真实决策和旁路，恢复原分类器；不停止独立服务进程。
- 查看本次进程的旁路可比较样本、一致率、错误数与回退事件。无有效双方类别的样本
  不计入一致率，重启清零；当前统计包含其他分类服务，不是请求成功率。

面板只管理 IP 为 `127.0.0.1` / `[::1]`、路径 `/v1/systemone` 的 HTTP OpenDecision；
不从界面探测任意远程地址。其他服务仍可通过配置文件管理。
本轮未提供开启正式路由的按钮；开启仍需按前述灰度评估流程修改配置。
面板操作立即保存，无需整页保存或重启网关；首次安装这版代码需重启桌面端以加载新 IPC。
浏览器或旧主进程会显示不支持，不会假装设置成功。

注意：面板关闭/旁路会显式设置 `decision_classifier.enabled: false`；以后若在文件中
开启正式路由，需要同时把该字段改回 `true`，不能只改 `engine`。

## 三级回退

```text
OpenDecision 分类
  → 异常/超时/无效类别/缺失或非法置信度/低分
场景 classifier.model 指定的原有 LLM 分类器（可用 fallback_llm=false 跳过）
  → 不可用/超时/无法输出精确类别
保留非分类规则的正常匹配结果 + 场景原有无条件默认步骤
```

分类放弃时，所有分类条件（包括 `not`）都不匹配；不会将空值误认为另一种类别。
至少配置一个符合你费用、来源、模型要求的无条件步骤才有最终默认链。例如场景结构：

```yaml
classifier:
  model: YOUR_CLASSIFIER_MODEL
  categories: [coding, general]
steps:
  - model: YOUR_CODING_MODEL
    when: {type: classifier, op: is, value: coding}
  - model: YOUR_DEFAULT_MODEL  # 没有 when，按正常场景执行器处理
```

占位模型须替换成已配置的真实模型；本次不会自动修改用户场景或指定一个替代供应商。
如果没有任何可执行的匹配规则或默认步骤，网关明确报错，不扩大候选范围。
默认步骤仍经过原有场景执行器的 provider/tier/scope 等限制，不能保证上游本身一定可用。

## 隔离与回滚

- System One 默认总预算 1500ms，包含健康检查、推理、完整响应体；超时取消请求。
  LLM 回退另有 3000ms 总预算，包含其内部重试。正常主模型生成不受这两个预算限制。
- 连续 3 次服务故障熔断 30 秒；冷却后仅放行一次试探，成功恢复，否则继续冷却。
  低分表示模型放弃决策，不计为服务故障；非法返回计入故障。
- 每个服务默认最多 2 个并发请求，全局最多 8 个，满载直接放弃，不排队。
  LLM 分类最多 4 个并发；相同的进行中分类请求合并，避免服务故障后放大 LLM 压力。
- 只缓存成功决策 5 分钟；System One 缓存隔离最终输入、类别、服务、模型、密钥及策略配置。
- 本地/custom 服务不再自动携带 TypeSafe 或 AI Gateway 的密钥。
  确需鉴权时显式指定 `api_key_env` 或 `api_key_file`；重定向不自动跟随。
- 日志位于 `~/.tokenbank/jev-shadow-log.jsonl`，区分 `fallback_llm`、`abstain`、
  `fallback_default`、`fallback_rules`、`no_default_route`，不记录输入原文。
  超过 5MiB 后滚动保留一份 `.1` 备份。

立即退出真实决策：把 `decision_classifier.engine` 改为 `llm`，或把
`decision_classifier.enabled` 改为 `false`。彻底不调用服务还需
`jev_shadow.enabled: false`。如果 runtime routing 中有覆盖，需同步修改该处。
无需卸载 OpenDecision、回退 Git 提交或改变明确选择的聊天模型。

注意：正常返回但分类错误不会自动触发回退，这是先旁路评估的原因。
本次只验证故障处理和接入逻辑，不宣称已验证实际模型准确性、冷启动延迟或生产可用性。
