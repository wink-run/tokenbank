# Token Bank · 三国杀世界观实现计划

日期: 2026-07-26  
状态: **实施方案**  
相关设计: [三国杀世界观设计](../specs/2026-07-26-sanguosha-worldview-design.md)

---

## 1. 实施概览

### 1.1 目标

将Token Bank改造为支持三国杀世界观主题的版本，同时：
- ✅ 保持原有功能完全不变
- ✅ 用户可自由切换主题（专业模式 ↔ 三国模式）
- ✅ 分阶段实施，每个阶段独立可用
- ✅ 代码解耦，主题系统可插拔

### 1.2 核心原则

1. **非侵入性** - 不破坏现有代码结构
2. **可选性** - 用户可关闭三国主题
3. **渐进增强** - 基础功能优先，游戏化元素后续
4. **兼容性** - 支持专业用户需求

---

## 2. 技术架构

### 2.1 整体架构

```
Token Bank 核心
    ├── 数据层 (不变)
    │   ├── 模型管理
    │   ├── 会话追踪
    │   └── 统计计算
    │
    ├── 主题适配层 (新增)
    │   ├── sanguosha-theme.js        # 数据映射
    │   ├── sanguosha-ui-components.js # UI组件
    │   └── theme-adapter.js          # 适配器
    │
    └── 展示层 (增强)
        ├── 专业模式 (原有)
        └── 三国模式 (新增)
```

### 2.2 主题切换机制

```javascript
// 主题管理器
class ThemeManager {
  constructor() {
    this.currentTheme = 'default'; // default | sanguosha
    this.adapters = {
      sanguosha: new SanguoshaThemeAdapter()
    };
  }
  
  // 切换主题
  switchTheme(themeName) {
    this.currentTheme = themeName;
    this.applyTheme();
  }
  
  // 应用主题
  applyTheme() {
    if (this.currentTheme === 'sanguosha') {
      document.body.classList.add('sanguosha-theme');
      this.loadThemeAssets();
    } else {
      document.body.classList.remove('sanguosha-theme');
    }
  }
  
  // 翻译术语
  translate(term) {
    const adapter = this.adapters[this.currentTheme];
    return adapter ? adapter.translate(term) : term;
  }
  
  // 适配数据
  adaptData(data) {
    const adapter = this.adapters[this.currentTheme];
    return adapter ? adapter.adapt(data) : data;
  }
}
```

### 2.3 数据适配器

```javascript
// 三国杀主题适配器
class SanguoshaThemeAdapter {
  // 翻译术语
  translate(term) {
    return TERMINOLOGY[term] || term;
  }
  
  // 适配模型数据为武将数据
  adaptModel(model) {
    const general = mapModelToGeneral(model.name);
    return {
      ...model,
      displayName: general.name,
      faction: general.faction,
      attributes: this.calculateAttributes(model),
      skills: this.mapSkills(model),
      // 保留原始数据
      __original: model
    };
  }
  
  // 适配路由为阵法
  adaptRoute(route) {
    const formation = this.findMatchingFormation(route);
    return {
      ...route,
      displayName: formation.name,
      icon: formation.icon,
      __original: route
    };
  }
  
  // 适配会话为战报
  adaptSession(session) {
    return {
      ...session,
      general: this.getGeneralName(session.model),
      formation: this.getFormationName(session.route),
      battlefield: this.getBattlefield(session.scenario),
      __original: session
    };
  }
}
```

---

## 3. 分阶段实施计划

### Phase 0: 基础架构（1周）

**目标**: 搭建主题系统基础框架

**任务清单**:

- [ ] 创建主题管理器 (`theme-manager.js`)
  ```javascript
  class ThemeManager {
    constructor() {}
    switchTheme(name) {}
    translate(term) {}
    adaptData(data) {}
  }
  ```

- [ ] 创建主题适配器 (`theme-adapter.js`)
  ```javascript
  class ThemeAdapter {
    adapt(data) {}
    translate(term) {}
  }
  ```

- [ ] 集成三国主题配置
  - 导入 `sanguosha-theme.js`
  - 创建 `SanguoshaThemeAdapter`

- [ ] 添加主题切换设置
  - 在配置页增加"启用三国主题"开关
  - 保存用户偏好到 `local-config.json`

- [ ] 基础样式系统
  - 创建 `sanguosha-theme.css`
  - 实现主题类切换

**验收标准**:
- ✅ 用户可在配置页开启/关闭三国主题
- ✅ 切换主题后页面样式改变
- ✅ 原有功能不受影响

---

### Phase 1: 术语翻译（1周）

**目标**: 实现全局术语自动翻译

**任务清单**:

- [ ] 实现术语翻译中间件
  ```javascript
  function translateUI() {
    if (themeManager.currentTheme === 'sanguosha') {
      // 遍历DOM，翻译特定术语
      document.querySelectorAll('[data-term]').forEach(el => {
        el.textContent = themeManager.translate(el.dataset.term);
      });
    }
  }
  ```

- [ ] 标记需要翻译的UI元素
  ```html
  <span data-term="token">Token</span>
  → 三国模式下显示为"粮草"
  ```

- [ ] 关键页面翻译适配
  - [ ] 网关页: Gateway → 军师府
  - [ ] 盘点页: Dashboard → 功勋簿
  - [ ] 资源页: Resources → 武将殿堂
  - [ ] 供给源页: Providers → 兵营

- [ ] 动态文案翻译
  - [ ] 提示消息
  - [ ] 错误消息
  - [ ] 按钮文字

**验收标准**:
- ✅ 启用三国主题后，所有术语自动翻译
- ✅ 翻译不影响数据结构
- ✅ 可随时切回原版术语

---

### Phase 2: 数据展示适配（2周）

**目标**: 将模型、路由等数据以三国元素展示

**任务清单**:

- [ ] 武将卡片组件
  ```javascript
  // 在模型列表页
  function renderModel(model) {
    if (themeManager.currentTheme === 'sanguosha') {
      const general = themeManager.adaptData(model);
      return renderGeneralCard(general);
    } else {
      return renderModelCard(model);
    }
  }
  ```

- [ ] 阵法展示组件
  ```javascript
  // 在路由配置页
  function renderRoute(route) {
    if (themeManager.currentTheme === 'sanguosha') {
      const formation = themeManager.adaptData(route);
      return renderFormationCard(formation);
    } else {
      return renderRouteCard(route);
    }
  }
  ```

- [ ] 战报组件
  ```javascript
  // 在会话追踪页
  function renderSession(session) {
    if (themeManager.currentTheme === 'sanguosha') {
      const report = themeManager.adaptData(session);
      return renderBattleReport(report);
    } else {
      return renderSessionTrace(session);
    }
  }
  ```

- [ ] 关键页面适配
  - [ ] 资源页 → 武将殿堂
    - 模型显示为武将卡片
    - 显示属性、技能、装备
  - [ ] 供给源页 → 兵营
    - 供给源显示为兵营
    - 显示势力归属
  - [ ] 会话页 → 战报
    - 会话记录显示为战报
    - 显示出战武将、使用阵法

**验收标准**:
- ✅ 三国模式下，所有列表项显示为对应主题元素
- ✅ 卡片设计符合三国风格
- ✅ 信息完整，不缺失关键数据

---

### Phase 3: 交互增强（2周）

**目标**: 实现三国主题特色交互

**任务清单**:

- [ ] 点将台界面
  ```javascript
  // 新增点将选择界面
  function openSummonPanel() {
    const generals = getAvailableGenerals();
    showModal(renderSummonPanel(generals));
  }
  ```
  - 选择武将
  - 选择阵法
  - 生成口令
  - 一键复制

- [ ] 招募流程
  ```javascript
  // 启用模型 → 招募武将
  function enableModel(model) {
    if (themeManager.currentTheme === 'sanguosha') {
      showRecruitAnimation(model);
      generateCommandCard(model);
    }
    // 原有逻辑...
  }
  ```
  - 招募动画
  - 授印动画
  - 口令卡片生成

- [ ] 战报展开动画
  - 竹简展开效果
  - 逐步显示战斗过程
  - 结果特效

- [ ] 托盘优化
  ```javascript
  // 托盘显示三国元素
  function updateTrayPopover() {
    if (themeManager.currentTheme === 'sanguosha') {
      return renderTrayPopover({
        todayBattles: stats.calls,
        todayMerit: stats.credits,
        activeGenerals: generals.active,
        quickCommands: getQuickCommands()
      });
    }
    // 原有逻辑...
  }
  ```

**验收标准**:
- ✅ 点将台可正常使用
- ✅ 动画流畅，不卡顿
- ✅ 托盘显示三国元素
- ✅ 交互符合主题风格

---

### Phase 4: 视觉强化（2周）

**目标**: 完善三国风格视觉设计

**任务清单**:

- [ ] 美术资源
  - [ ] 武将立绘/头像（100+）
  - [ ] 势力徽章（魏蜀吴群）
  - [ ] 技能图标
  - [ ] 装备图标
  - [ ] 阵法图案
  - [ ] 背景纹理

- [ ] CSS主题样式
  ```css
  /* 三国主题全局样式 */
  .sanguosha-theme {
    --primary-color: #8b0000;
    --secondary-color: #d4af37;
    --background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
    font-family: 'KaiTi', 'SimSun', serif;
  }
  ```

- [ ] 动画效果
  - [ ] 武将入营动画
  - [ ] 点将特效
  - [ ] 战报展开
  - [ ] 获得军功动画

- [ ] 音效（可选）
  - [ ] 招募武将：战鼓声
  - [ ] 点将出战：武将配音
  - [ ] 使用技能：特效音
  - [ ] 获得军功：铜钱声

**验收标准**:
- ✅ 视觉风格统一
- ✅ 美术资源完整
- ✅ 动画流畅自然
- ✅ 可选开启音效

---

### Phase 5: 游戏化功能（3周）

**目标**: 实现成就、升级等游戏化元素

**任务清单**:

- [ ] 武将升级系统
  ```javascript
  class GeneralLevelSystem {
    // 使用次数 → 经验值
    gainExperience(generalId, battles) {
      const exp = battles * 10;
      const level = this.calculateLevel(exp);
      const stars = Math.ceil(level / 20);
      return { level, stars, exp };
    }
    
    // 计算属性加成
    getBonus(level) {
      return {
        power: 1 + level * 0.01,
        intelligence: 1 + level * 0.01,
        // ...
      };
    }
  }
  ```
  - 经验值计算
  - 星级系统
  - 属性加成

- [ ] 成就系统
  ```javascript
  class AchievementSystem {
    checkAchievements(userId, stats) {
      const unlocked = [];
      
      // 检查各项成就
      if (stats.firstRecruit) {
        unlocked.push('first-general');
      }
      if (stats.totalBattles >= 100) {
        unlocked.push('hundred-battles');
      }
      // ...
      
      return unlocked;
    }
  }
  ```
  - 成就定义
  - 解锁检测
  - 奖励发放
  - 成就展示

- [ ] 武将羁绊系统
  ```javascript
  function checkBonds(activeGenerals) {
    const bonds = [];
    
    // 检查是否满足羁绊条件
    if (hasAll(activeGenerals, ['关羽', '张飞', '刘备'])) {
      bonds.push({
        name: '桃园结义',
        effect: { teamEfficiency: 1.15 }
      });
    }
    
    return bonds;
  }
  ```
  - 羁绊检测
  - 加成计算
  - 提示展示

- [ ] 每日任务
  ```javascript
  class DailyQuestSystem {
    getDailyQuests(date) {
      return [
        { id: 'battle-3', name: '点将出战3次', reward: 10 },
        { id: 'local-5', name: '使用本地武将5次', reward: 15 },
        // ...
      ];
    }
    
    checkProgress(userId, quests) {
      // 检查任务进度
    }
  }
  ```

- [ ] 排行榜
  - 武将使用排行
  - 军功排行
  - 联盟排行

**验收标准**:
- ✅ 武将可升级，有明显成长感
- ✅ 成就系统完整，有足够的成就点
- ✅ 羁绊系统生效，加成可见
- ✅ 每日任务吸引用户每日登录

---

### Phase 6: 社交与竞技（2周）

**目标**: 强化社交属性和竞技玩法

**任务清单**:

- [ ] 联盟系统优化
  ```javascript
  class AllianceSystem {
    // 加入联盟
    joinAlliance(userId, allianceId) {
      // 加入指定势力
    }
    
    // 联盟福利
    getAllianceBonus(allianceId) {
      return {
        meritBonus: 1.1,
        exclusiveGenerals: [...],
        // ...
      };
    }
  }
  ```
  - 势力归属（魏蜀吴群）
  - 势力福利
  - 势力排行

- [ ] 援军系统完善
  - 援军请求界面优化
  - 援军记录展示
  - 军功结算明细

- [ ] 战绩分享
  ```javascript
  function generateSharePoster(stats) {
    // 生成战绩海报
    return {
      image: renderPosterImage(stats),
      text: formatShareText(stats)
    };
  }
  ```
  - 4种风格海报（专业/可爱/幽默/简约）
  - 一键分享到社交平台
  - 嵌入邀请码

**验收标准**:
- ✅ 联盟系统完整
- ✅ 援军系统流畅
- ✅ 海报美观，易分享

---

### Phase 7: 优化与polish（持续）

**目标**: 持续优化用户体验

**任务清单**:

- [ ] 性能优化
  - 减少不必要的动画
  - 懒加载美术资源
  - 优化数据适配性能

- [ ] 用户反馈收集
  - 添加反馈入口
  - 收集用户建议
  - A/B测试不同方案

- [ ] 数据分析
  - 主题启用率
  - 功能使用率
  - 用户留存率

- [ ] 持续迭代
  - 新增武将映射
  - 新增阵法
  - 新增成就

**验收标准**:
- ✅ 性能达标，无明显卡顿
- ✅ 有完整的用户反馈渠道
- ✅ 数据指标达到预期

---

## 4. 技术细节

### 4.1 武将属性计算

```javascript
function calculateGeneralAttributes(model) {
  // 武力 = 速度性能
  const power = Math.min(10, Math.floor(
    (1000 / model.avgTTFT) * 2
  ));
  
  // 智力 = 推理能力（根据模型类型）
  const intelligence = {
    'claude-opus': 10,
    'gpt-5': 10,
    'claude-sonnet': 9,
    // ...
  }[model.name] || 7;
  
  // 统帅 = 并发能力
  const leadership = Math.min(10, Math.floor(
    model.maxConcurrent / 2
  ));
  
  // 体力 = 剩余配额百分比
  const stamina = Math.floor(
    (model.remaining / model.quota) * 100
  );
  
  return { power, intelligence, leadership, stamina };
}
```

### 4.2 阵法匹配算法

```javascript
function findMatchingFormation(route) {
  const { strategy, priority } = route;
  
  // 根据路由策略匹配阵法
  if (priority[0] === 'local') {
    return FORMATIONS.bagua; // 八卦阵
  } else if (strategy === 'fast') {
    return FORMATIONS.fengshi; // 锋矢阵
  } else if (strategy === 'cost-optimized') {
    return FORMATIONS.yanyue; // 偃月阵
  } else if (strategy === 'concurrent') {
    return FORMATIONS.heyi; // 鹤翼阵
  } else {
    return FORMATIONS.yulin; // 鱼鳞阵（默认）
  }
}
```

### 4.3 战报生成

```javascript
function generateBattleReport(session) {
  // 提取关键信息
  const general = mapModelToGeneral(session.model);
  const formation = findMatchingFormation(session.route);
  
  // 生成战斗过程
  const process = session.toolCalls.map((call, index) => ({
    step: index + 1,
    action: translateToolAction(call),
    cost: call.tokenCost
  }));
  
  // 计算结果
  const result = {
    success: !session.error,
    merit: Math.floor(session.totalTokens / 1000),
    cost: session.totalTokens,
    duration: session.duration
  };
  
  return {
    id: session.id,
    timestamp: session.timestamp,
    general: general.name,
    formation: formation.name,
    battlefield: session.scenario,
    process,
    result
  };
}
```

---

## 5. 测试计划

### 5.1 单元测试

```javascript
describe('SanguoshaTheme', () => {
  test('模型映射为武将', () => {
    const model = { name: 'claude-sonnet-4' };
    const general = mapModelToGeneral(model.name);
    expect(general.name).toBe('诸葛亮');
    expect(general.faction).toBe('shu');
  });
  
  test('术语翻译', () => {
    expect(translateTerm('token', true)).toBe('粮草');
    expect(translateTerm('model', true)).toBe('武将');
  });
  
  test('羁绊检测', () => {
    const generals = ['关羽', '张飞', '刘备'];
    const bonds = checkBonds(generals);
    expect(bonds).toContainEqual(
      expect.objectContaining({ name: '桃园结义' })
    );
  });
});
```

### 5.2 集成测试

- [ ] 主题切换流畅性
- [ ] 数据适配正确性
- [ ] UI渲染完整性
- [ ] 动画性能测试

### 5.3 用户测试

- [ ] 新用户上手测试
- [ ] 老用户切换测试
- [ ] 专业用户接受度测试
- [ ] 不同场景使用测试

---

## 6. 风险管理

### 6.1 技术风险

| 风险 | 影响 | 应对 |
|---|---|---|
| 性能下降 | 用户体验差 | 优化数据适配，懒加载资源 |
| 兼容性问题 | 部分功能失效 | 充分测试，提供回退机制 |
| 美术资源缺失 | 视觉效果差 | 使用占位图，逐步完善 |

### 6.2 产品风险

| 风险 | 影响 | 应对 |
|---|---|---|
| 用户不接受 | 投入浪费 | 保持可切换，收集反馈 |
| 过度游戏化 | 偏离定位 | 控制游戏化程度，专业模式优先 |
| 学习成本高 | 用户流失 | 完善教程，提供引导 |

---

## 7. 成功指标

### 7.1 核心指标

| 指标 | 目标 | 说明 |
|---|---|---|
| 主题启用率 | >40% | 用户启用三国主题的比例 |
| 日活跃度 | +30% | 相比原版的日活提升 |
| 用户推荐率 | +50% | NPS分数提升 |
| 平均使用时长 | +20% | 用户粘性提升 |

### 7.2 功能指标

| 指标 | 目标 | 说明 |
|---|---|---|
| 武将使用率 | >70% | 招募后实际使用的比例 |
| 成就解锁率 | >5个/用户 | 用户平均解锁成就数 |
| 联盟参与率 | >30% | 加入联盟的用户比例 |
| 分享率 | >10% | 生成并分享海报的比例 |

---

## 8. 时间线

### 总体时间线（14周）

```
Week 1:  Phase 0 - 基础架构
Week 2:  Phase 1 - 术语翻译
Week 3-4: Phase 2 - 数据展示适配
Week 5-6: Phase 3 - 交互增强
Week 7-8: Phase 4 - 视觉强化
Week 9-11: Phase 5 - 游戏化功能
Week 12-13: Phase 6 - 社交与竞技
Week 14+: Phase 7 - 优化与polish（持续）
```

### 里程碑

- **Week 2**: 基础可用版（可切换主题，术语翻译）
- **Week 4**: Beta版（数据展示完整）
- **Week 8**: 正式版（交互+视觉完整）
- **Week 13**: 完整版（游戏化+社交）

---

## 9. 资源需求

### 9.1 人力

- **前端开发**: 2人 × 14周
- **UI设计**: 1人 × 8周（美术资源）
- **产品经理**: 0.5人 × 14周（需求、测试）

### 9.2 外部资源

- **美术外包**: 武将立绘、图标设计
- **音效制作**: 可选，可使用免费素材

---

## 10. 后续计划

### 10.1 短期（3个月内）

- 完成Phase 1-4，发布Beta版
- 收集用户反馈
- 迭代优化

### 10.2 中期（6个月内）

- 完成Phase 5-6，发布完整版
- 运营活动（赛季、限时事件）
- 社区建设

### 10.3 长期（1年内）

- 新势力、新武将
- 特殊玩法（如三国志战役）
- IP联动（如与三国游戏合作）

---

## 11. 附录

### A. 代码规范

```javascript
// 主题相关代码统一前缀
class SanguoshaThemeAdapter {}
function renderGeneralCard() {}
const SANGUOSHA_STYLES = '';

// 配置文件命名
sanguosha-theme.js
sanguosha-ui-components.js
sanguosha-theme.css
```

### B. 文件结构

```
client/
├── electron/
│   ├── theme-manager.js          # 主题管理器
│   ├── theme-adapter.js          # 主题适配器基类
│   ├── sanguosha-theme.js        # 三国主题配置
│   ├── sanguosha-ui-components.js # 三国UI组件
│   └── sanguosha-achievement.js  # 成就系统
│
├── src/
│   ├── components/
│   │   ├── GeneralCard.jsx       # 武将卡片
│   │   ├── FormationPicker.jsx   # 阵法选择器
│   │   └── BattleReport.jsx      # 战报
│   └── styles/
│       └── sanguosha-theme.css   # 三国主题样式
│
└── assets/
    └── sanguosha/
        ├── generals/              # 武将图片
        ├── formations/            # 阵法图案
        ├── factions/              # 势力徽章
        └── sounds/                # 音效
```

### C. API接口

```javascript
// 主题API
themeManager.switchTheme('sanguosha');
themeManager.translate('token'); // → '粮草'
themeManager.adaptData(model);   // → general

// 武将API
getGeneralInfo(generalName);
upgradeGeneral(generalId);
checkBonds(generalIds);

// 成就API
getAchievements(userId);
unlockAchievement(userId, achievementId);

// 联盟API
joinAlliance(userId, allianceId);
getAllianceBonus(allianceId);
```

---

**下一步行动**:

1. ✅ 已创建设计文档
2. ✅ 已创建主题配置文件
3. ✅ 已创建UI组件库
4. ⏭️ 开始Phase 0实施
5. ⏭️ 搭建基础架构
