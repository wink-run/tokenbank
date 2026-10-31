# Token Bank 三国主题 V3 - 基于现有产品的正确方案

日期: 2026-07-26  
状态: **终稿 - 智能体即武将**  
基于: 产品已有 assistant/skill/prompt 资源体系

---

## 0. 产品现状确认

从代码看到的实际情况：

```javascript
// 产品已有三种资源类型
TYPE_OPTIONS = [
  { id: 'prompt', labelKey: 'resources.type.prompt' },
  { id: 'skill', labelKey: 'resources.type.skill' },
  { id: 'assistant', labelKey: 'resources.type.assistant' },  // ← 智能体
];

// 用户可以：
// 1. 从社区目录启用智能体
// 2. 投射到不同运行时（Cursor、Claude Code等）
// 3. 通过 MCP 点将：tb_get_resource(type='assistant')
```

**所以正确的映射是**：

```
✅ 智能体（assistant） = 武将
✅ Skill = 武将技能/兵器
✅ Prompt = 锦囊
✅ 模型 = 武将使用的内功/算力源（不是武将本身）
```

---

## 1. 正确的三国主题设计

### 1.1 核心概念

```
【资源页】= 武将殿堂
├─ 已纳管（已启用的智能体）
│  └─ 这些是你的武将
│
├─ 为你推荐（社区目录推荐）
│  └─ 可招募的武将
│
└─ 社区目录
   └─ 更多武将候选
```

### 1.2 具体示例

#### 场景1：启用智能体

```
【社区目录】发现智能体：
┌────────────────────────┐
│ 代码审查专家            │
│ 类型: assistant         │
│ 擅长: Bug发现、代码质量 │
│ 使用模型: Claude Sonnet │
│ 绑定技能: Git工具、测试  │
│                        │
│ [启用到我的库]          │
└────────────────────────┘

三国主题下：
┌────────────────────────┐
│ 🎯 代码审查专家         │
│ 类型: 武将              │
│ 擅长: Bug发现、代码质量 │
│ 内功: 🎨 Claude算力     │
│ 装备: ⚔️ Git • 🛡️ 测试 │
│                        │
│ [招募入营]             │
└────────────────────────┘
```

#### 场景2：已纳管的智能体

```
【已纳管】列表：
┌────────────────────────┐
│ 代码审查专家            │
│ ├─ 投射到: Cursor      │
│ ├─ 使用模型: Claude    │
│ ├─ 绑定技能: Git、测试  │
│ └─ 命中: 12次 | 最近: 2h│
│                        │
│ [点将] [详情] [退役]   │
└────────────────────────┘

三国主题下：
┌────────────────────────┐
│ 🎯 代码审查专家         │
│ ├─ 听令于: Cursor主公  │
│ ├─ 内功: 🎨 Claude     │
│ ├─ 装备: ⚔️ Git • 🛡️ 测试│
│ └─ 出战: 12次 | 最近: 2h│
│                        │
│ [点将] [详情] [休整]   │
└────────────────────────┘
```

#### 场景3：点将出战

```
用户在 Cursor 中输入：
"用代码审查专家检查这次改动"

系统执行：
1. tb_list_resources(type='assistant')
   → 返回已投射给Cursor的智能体列表
   → 包含"代码审查专家"

2. tb_get_resource(name='代码审查专家')
   → 返回该智能体的soul + 绑定的skills
   → 包含使用的模型（Claude Sonnet）

3. Cursor按这个context执行任务

反馈（三国主题）：
"代码审查专家出战！
 使用Claude算力，调用Git工具
 发现3处问题，耗费粮草3200"
```

---

## 2. 关键设计原则（修正版）

### 2.1 不做的事

| ❌ 不要 | 原因 |
|---|---|
| 给模型起武将名（claude=诸葛亮） | 模型不是武将，是武将的内功 |
| 强制术语翻译（Token→粮草） | 增加学习成本 |
| 创建复杂的武将属性系统 | 与实际功能脱节 |
| 过度游戏化（升级/羁绊） | 偏离产品核心 |

### 2.2 应该做的事

| ✅ 要做 | 价值 |
|---|---|
| 智能体卡片加武将视觉风格 | 增强识别度 |
| "启用"改为"招募"（可选） | 增加仪式感 |
| 点将成功时简短反馈 | 完成感 |
| 模型用颜色/图标区分 | 快速识别内功 |

---

## 3. 具体实施方案

### 3.1 资源页面适配

#### A. 已纳管列表

```jsx
// ResourceAssetCard 组件
function renderAssistantCard(assistant, theme) {
  const isSanguosha = theme === 'sanguosha';
  
  return (
    <div className={`asset-card ${isSanguosha ? 'general-card' : ''}`}>
      {/* 图标/头像 */}
      <div className="asset-icon">
        {isSanguosha ? (
          <div className="general-avatar">🎯</div>
        ) : (
          <ServiceIcon type="assistant" />
        )}
      </div>
      
      {/* 名称 */}
      <h3>{assistant.name}</h3>
      
      {/* 描述 */}
      <p className="description">
        {assistant.description}
      </p>
      
      {/* 使用的模型 */}
      <div className="model-info">
        {isSanguosha ? (
          <span className="inner-power">
            内功: {getModelIcon(assistant.model)} {assistant.model}
          </span>
        ) : (
          <span>
            模型: {assistant.model}
          </span>
        )}
      </div>
      
      {/* 绑定的技能 */}
      {assistant.skills?.length > 0 && (
        <div className="skills">
          {isSanguosha ? '装备:' : '技能:'}
          {assistant.skills.map(skill => (
            <span className="skill-tag">{skill}</span>
          ))}
        </div>
      )}
      
      {/* 投射状态 */}
      <div className="projection">
        {isSanguosha ? '听令于:' : '投射到:'}
        {assistant.projectedTo.map(agent => (
          <span className="agent-badge">{agent}</span>
        ))}
      </div>
      
      {/* 使用统计 */}
      <div className="stats">
        {isSanguosha ? (
          <span>出战 {assistant.useCount}次</span>
        ) : (
          <span>使用 {assistant.useCount}次</span>
        )}
      </div>
      
      {/* 操作按钮 */}
      <div className="actions">
        <button onClick={() => summon(assistant)}>
          {isSanguosha ? '点将' : '调用'}
        </button>
        <button onClick={() => unproject(assistant)}>
          {isSanguosha ? '休整' : '取消投射'}
        </button>
      </div>
    </div>
  );
}
```

#### B. 社区目录/推荐

```jsx
// 启用按钮文案适配
function getEnableButtonText(resourceType, theme) {
  if (theme !== 'sanguosha') {
    return '启用';
  }
  
  return {
    'assistant': '招募入营',
    'skill': '装备',
    'prompt': '习得'
  }[resourceType] || '启用';
}
```

### 3.2 点将反馈

```javascript
// 调用成功后的反馈
function showCallSuccess(assistant, result, theme) {
  if (theme === 'sanguosha') {
    return {
      title: `${assistant.name}出战告捷！`,
      content: [
        `使用${getModelDisplayName(assistant.model)}算力`,
        result.toolsUsed?.length > 0 ? 
          `调用装备: ${result.toolsUsed.join('、')}` : null,
        `耗费粮草: ${result.tokens}`
      ].filter(Boolean).join('\n')
    };
  } else {
    return {
      title: '调用成功',
      content: `Token: ${result.tokens}`
    };
  }
}
```

### 3.3 模型内功显示

```javascript
// 模型图标/颜色系统（不是武将名）
const MODEL_VISUALS = {
  'claude-sonnet-4': {
    icon: '🎨',  // 羽扇
    color: '#4a90e2',
    label: 'Claude算力'
  },
  'gpt-4': {
    icon: '📜',  // 卷轴
    color: '#10b981',
    label: 'GPT算力'
  },
  'ollama': {
    icon: '🏺',  // 陶罐
    color: '#8b5cf6',
    label: '本地算力'
  },
  'groq': {
    icon: '⚡',  // 闪电
    color: '#ef4444',
    label: '疾风算力'
  }
};

function getModelIcon(modelName) {
  for (const [key, visual] of Object.entries(MODEL_VISUALS)) {
    if (modelName.includes(key)) {
      return visual.icon;
    }
  }
  return '🔮'; // 默认
}
```

---

## 4. UI示例

### 4.1 资源页 - 已纳管

```
┌────────────── 武将殿堂 ──────────────┐
│                                      │
│ [在营武将] [可募武将] [社区目录]     │
│                                      │
│ 在营武将 (3)                          │
│                                      │
│ ┌─────────────┐  ┌─────────────┐   │
│ │   🎯        │  │   🎯        │   │
│ │             │  │             │   │
│ │ 代码审查专家 │  │ 架构设计师  │   │
│ │             │  │             │   │
│ │ 内功: 🎨    │  │ 内功: 📜    │   │
│ │ Claude算力  │  │ GPT算力     │   │
│ │             │  │             │   │
│ │ 装备: ⚔️🛡️ │  │ 装备: 📊🔧 │   │
│ │             │  │             │   │
│ │ 听令于:     │  │ 听令于:     │   │
│ │ Cursor      │  │ Claude Code │   │
│ │             │  │             │   │
│ │ 出战: 12次  │  │ 出战: 8次   │   │
│ │             │  │             │   │
│ │ [点将][详情]│  │ [点将][详情]│   │
│ └─────────────┘  └─────────────┘   │
└──────────────────────────────────────┘
```

### 4.2 点将成功反馈

```
┌────────────────────┐
│   🎯 ✨            │
│                    │
│ 代码审查专家出战告捷！│
│                    │
│ • 使用🎨Claude算力 │
│ • 调用装备: Git工具 │
│ • 耗费粮草: 3200   │
│                    │
│ [查看详情]         │
└────────────────────┘
```

### 4.3 招募智能体

```
从社区目录启用：
┌────────────────────────┐
│ 🎯 性能优化大师         │
│                        │
│ 擅长: 性能分析、优化建议│
│ 内功: 🎨 Claude算力     │
│ 装备: 📊 分析工具       │
│                        │
│ 可投射到:              │
│ ☑ Cursor              │
│ ☑ Claude Code         │
│ ☐ Codex               │
│                        │
│ [招募入营] [查看详情]  │
└────────────────────────┘

点击"招募入营"后：
┌────────────────────────┐
│      🎊                │
│ 性能优化大师已入营！    │
│                        │
│ 可对主公说出口令：      │
│ "用性能优化大师分析代码" │
│                        │
│ [复制口令] [前往殿堂]  │
└────────────────────────┘
```

---

## 5. 数据结构（极简）

```javascript
// 主题配置
const themeConfig = {
  enabled: false,  // 默认关闭
  
  // 术语映射（可选）
  terminology: {
    'enable': '招募',
    'disable': '休整',
    'project': '授印',
    'call': '点将',
    'use_count': '出战',
    'model': '内功',
    'skill': '装备',
    'prompt': '锦囊'
  },
  
  // 反馈样式
  feedback: {
    showAnimation: false,  // 关闭动画
    useThematicText: true  // 使用主题文案
  }
};

// 资源数据不变，仅展示层适配
// assistant 数据结构完全不改
```

---

## 6. 实施步骤（2周）

### Week 1: 资源页视觉适配

- [ ] ResourceAssetCard 组件增加三国主题样式
  - 智能体卡片加"武将"风格
  - 模型显示为"内功"
  - 技能显示为"装备"
  
- [ ] 按钮文案适配
  - "启用" → "招募入营"
  - "取消投射" → "休整"
  
- [ ] 模型图标系统
  - Claude → 🎨
  - GPT → 📜
  - 本地 → 🏺

### Week 2: 反馈优化

- [ ] 点将成功反馈
  - 简短主题文案
  - 可关闭
  
- [ ] 招募成功反馈
  - 生成口令卡
  - 引导使用

---

## 7. 与V1/V2对比

| 维度 | V1 | V2 | V3（本版）|
|---|---|---|---|
| **武将定义** | 模型 | 模型（图标） | ✅ 智能体 |
| **是否理解产品** | ❌ 跳过智能体 | ❌ 跳过智能体 | ✅ 基于智能体 |
| **学习成本** | 高 | 低 | ✅ 零 |
| **改动范围** | 深度 | 视觉 | ✅ 视觉+文案 |
| **实施周期** | 14周 | 4周 | ✅ 2周 |

---

## 8. 成功标准

### 用户理解度

- [ ] 新用户看到"武将殿堂"能理解是智能体库
- [ ] 看到"招募入营"能理解是启用智能体
- [ ] 看到"内功: Claude"能理解是使用的模型

### 功能完整性

- [ ] 启用智能体流程不受影响
- [ ] 投射机制正常工作
- [ ] 点将（MCP调用）正常工作
- [ ] 可完全关闭三国主题

### 不造成困扰

- [ ] 专业用户不觉得幼稚
- [ ] 不喜欢的用户能轻松关闭
- [ ] 性能无影响

---

## 9. FAQ

### Q1: 为什么不给模型起武将名？

A: 因为**模型不是武将，智能体才是**。
   - 模型 = 武将使用的算力/内功
   - 用图标区分即可，不需要改名

### Q2: 用户没有智能体怎么办？

A: 产品已有"为你推荐"和"社区目录"：
   - 可以启用推荐的智能体
   - 也可以创建自己的智能体
   - 三国主题只是视觉层，不改变流程

### Q3: 和原产品的"武将库"设计一致吗？

A: **完全一致**！
   - 原设计: 武将 = 智能体
   - 本方案: 武将 = 智能体
   - V1/V2错误: 武将 = 模型

---

## 10. 总结

### 核心纠正

```
❌ V1/V2: 模型 = 武将（错误）
✅ V3:    智能体 = 武将（正确）
```

### 设计原则

1. **基于现有产品** - 不创造新概念
2. **视觉层装饰** - 不改变核心逻辑
3. **完全可选** - 不喜欢可关闭
4. **零学习成本** - 智能体就是武将

### 实施建议

- 2周完成视觉适配
- 验证用户理解度
- 根据反馈决定是否保留

---

**这才是符合产品设计的三国主题方案。**
