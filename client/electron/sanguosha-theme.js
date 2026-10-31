/**
 * Token Bank · 三国杀世界观主题配置
 * 
 * 提供完整的三国杀主题映射和配置
 */

// ============ 武将映射表 ============
const GENERAL_MAPPING = {
  // Claude 系列 - 蜀汉谋士
  'claude-opus-4': {
    name: '诸葛亮',
    faction: 'shu',
    title: '卧龙',
    stars: 5,
    attributes: {
      power: 8,        // 武力 (TTFT性能)
      intelligence: 10, // 智力 (推理能力)
      leadership: 9,    // 统帅 (并发能力)
      stamina: 95       // 体力 (配额百分比)
    },
    skills: ['锦囊妙计', '观星', '空城计', '八卦阵'],
    description: '蜀汉丞相，智谋无双，擅长复杂任务和架构设计'
  },
  'claude-sonnet-4': {
    name: '庞统',
    faction: 'shu',
    title: '凤雏',
    stars: 5,
    attributes: { power: 9, intelligence: 10, leadership: 8, stamina: 90 },
    skills: ['连环', '涅槃', '浴火'],
    description: '凤雏先生，智谋不在卧龙之下，善于创造性解决问题'
  },
  'claude-haiku': {
    name: '姜维',
    faction: 'shu',
    title: '幼麟',
    stars: 4,
    attributes: { power: 8, intelligence: 8, leadership: 7, stamina: 85 },
    skills: ['挑衅', '志继', '观星'],
    description: '诸葛亮弟子，文武双全，均衡全能'
  },

  // GPT 系列 - 魏国谋士
  'gpt-5': {
    name: '司马懿',
    faction: 'wei',
    title: '仲达',
    stars: 5,
    attributes: { power: 7, intelligence: 10, leadership: 9, stamina: 92 },
    skills: ['鹰视', '狼顾', '反馈', '鬼才'],
    description: '魏国大都督，深谋远虑，擅长复杂推理和长期规划'
  },
  'gpt-4o': {
    name: '荀彧',
    faction: 'wei',
    title: '文若',
    stars: 5,
    attributes: { power: 8, intelligence: 9, leadership: 8, stamina: 88 },
    skills: ['驱虎', '节命', '举荐'],
    description: '王佐之才，擅长多模态任务和资源调度'
  },
  'gpt-4': {
    name: '郭嘉',
    faction: 'wei',
    title: '奉孝',
    stars: 4,
    attributes: { power: 7, intelligence: 10, leadership: 7, stamina: 85 },
    skills: ['天妒', '遗计'],
    description: '鬼才军师，料事如神，适合分析和预测任务'
  },
  'gpt-3.5-turbo': {
    name: '贾诩',
    faction: 'wei',
    title: '文和',
    stars: 3,
    attributes: { power: 8, intelligence: 7, leadership: 6, stamina: 90 },
    skills: ['完杀', '乱武', '帷幕'],
    description: '毒士，成本低廉，擅长简单快速任务'
  },

  // DeepSeek 系列 - 蜀汉本地将领
  'deepseek-v3': {
    name: '关羽',
    faction: 'shu',
    title: '武圣',
    stars: 5,
    attributes: { power: 10, intelligence: 7, leadership: 8, stamina: 100 },
    skills: ['武圣', '义从', '单骑'],
    description: '蜀汉五虎上将之首，本地部署，忠心不二，数据不出门'
  },
  'deepseek-coder': {
    name: '黄忠',
    faction: 'shu',
    title: '老将',
    stars: 4,
    attributes: { power: 9, intelligence: 6, leadership: 7, stamina: 100 },
    skills: ['烈弓', '擎天'],
    description: '老当益壮，专精代码生成，本地部署性价比之王'
  },

  // Groq / 高速系列 - 蜀汉猛将
  'groq-llama': {
    name: '赵云',
    faction: 'shu',
    title: '子龙',
    stars: 5,
    attributes: { power: 10, intelligence: 7, leadership: 8, stamina: 80 },
    skills: ['龙胆', '冲阵', '突袭'],
    description: '常山赵子龙，百万军中取上将首级，极速响应'
  },
  'groq-mixtral': {
    name: '马超',
    faction: 'shu',
    title: '孟起',
    stars: 4,
    attributes: { power: 10, intelligence: 6, leadership: 7, stamina: 75 },
    skills: ['铁骑', '马术'],
    description: '西凉锦马超，速度极快，适合快速代码生成'
  },

  // Gemini 系列 - 吴国
  'gemini-2.0-flash': {
    name: '周瑜',
    faction: 'wu',
    title: '公瑾',
    stars: 5,
    attributes: { power: 8, intelligence: 9, leadership: 9, stamina: 70 },
    skills: ['英姿', '反间', '纵火'],
    description: '东吴都督，年轻有为，免费配额丰富'
  },
  'gemini-1.5-pro': {
    name: '陆逊',
    faction: 'wu',
    title: '伯言',
    stars: 4,
    attributes: { power: 7, intelligence: 9, leadership: 8, stamina: 75 },
    skills: ['连营', '谦逊'],
    description: '江东儒将，长上下文处理能力出众'
  },
  'gemini-1.5-flash': {
    name: '太史慈',
    faction: 'wu',
    title: '子义',
    stars: 4,
    attributes: { power: 9, intelligence: 6, leadership: 7, stamina: 80 },
    skills: ['天义', '击势'],
    description: '东莱太史慈，快速且免费额度充足'
  },

  // Ollama 本地系列 - 蜀汉本土将领
  'ollama-llama3': {
    name: '魏延',
    faction: 'shu',
    title: '文长',
    stars: 4,
    attributes: { power: 9, intelligence: 6, leadership: 7, stamina: 100 },
    skills: ['狂骨', '嚣张'],
    description: '本地猛将，无需联网，完全掌控'
  },
  'ollama-qwen': {
    name: '张飞',
    faction: 'shu',
    title: '翼德',
    stars: 4,
    attributes: { power: 10, intelligence: 5, leadership: 7, stamina: 100 },
    skills: ['咆哮', '替身'],
    description: '燕人张翼德，本地部署，直率强悍'
  },

  // 小模型 / 快速系列
  'qwen-turbo': {
    name: '甘宁',
    faction: 'wu',
    title: '兴霸',
    stars: 3,
    attributes: { power: 9, intelligence: 6, leadership: 6, stamina: 85 },
    skills: ['奇袭', '激昂'],
    description: '锦帆游侠，快速出击'
  },

  // 社区共享 / 援军
  'community-shared': {
    name: '援军',
    faction: 'qun',
    title: '义士',
    stars: 3,
    attributes: { power: 7, intelligence: 7, leadership: 7, stamina: 70 },
    skills: ['互助', '结盟'],
    description: '来自联盟的援军，消耗军功调用'
  }
};

// ============ 阵法配置 ============
const FORMATIONS = {
  'bagua': {
    name: '八卦阵',
    type: 'defense',
    icon: '☯️',
    description: '本地优先，隐私至上，适合敏感任务',
    strategy: {
      priority: ['ollama', 'local', 'free', 'paid'],
      fallback: true,
      compress: true
    },
    bonus: {
      privacy: 1.0,
      cost: 0.9,
      speed: 0.85
    },
    creator: '诸葛亮'
  },
  
  'fengshi': {
    name: '锋矢阵',
    type: 'offense',
    icon: '⚔️',
    description: '速度优先，快速响应，适合紧急任务',
    strategy: {
      priority: ['groq', 'fast-api', 'local', 'paid'],
      fallback: true,
      timeout: 5000
    },
    bonus: {
      speed: 1.2,
      cost: 1.1,
      privacy: 0.8
    },
    creator: '赵云'
  },
  
  'yulin': {
    name: '鱼鳞阵',
    type: 'balance',
    icon: '🐟',
    description: '均衡路由，稳定可靠，适合日常任务',
    strategy: {
      priority: ['local', 'free', 'paid', 'community'],
      fallback: true,
      loadBalance: true
    },
    bonus: {
      stability: 1.1,
      cost: 1.0,
      speed: 1.0
    },
    creator: '司马懿'
  },
  
  'heyi': {
    name: '鹤翼阵',
    type: 'offense',
    icon: '🦅',
    description: '并发路由，多路出击，适合批量任务',
    strategy: {
      priority: ['all-available'],
      concurrent: true,
      maxConcurrent: 5
    },
    bonus: {
      throughput: 1.5,
      cost: 1.2,
      speed: 1.1
    },
    creator: '周瑜'
  },
  
  'yanyue': {
    name: '偃月阵',
    type: 'defense',
    icon: '🌙',
    description: '成本优先，节省粮草，适合长期作战',
    strategy: {
      priority: ['free', 'local', 'community', 'paid'],
      fallback: true,
      costOptimized: true
    },
    bonus: {
      cost: 0.7,
      speed: 0.9,
      privacy: 1.0
    },
    creator: '荀彧'
  },
  
  'changshe': {
    name: '长蛇阵',
    type: 'balance',
    icon: '🐍',
    description: '队列路由，有序处理，适合顺序任务',
    strategy: {
      priority: ['sequential'],
      queue: true,
      maxQueue: 10
    },
    bonus: {
      order: 1.0,
      cost: 1.0,
      speed: 0.95
    },
    creator: '陆逊'
  }
};

// ============ 装备映射 ============
const EQUIPMENT = {
  // 武器
  weapons: {
    'git-tools': { name: '青龙偃月刀', owner: '关羽', effect: '版本控制' },
    'filesystem': { name: '方天画戟', owner: '吕布', effect: '文件操作' },
    'test-tools': { name: '诸葛连弩', owner: '诸葛亮', effect: '连续测试' },
    'database': { name: '倚天剑', owner: '赵云', effect: '数据操作' },
    'api-tools': { name: '七星宝刀', owner: '曹操', effect: 'API调用' }
  },
  
  // 防具
  armors: {
    'compression': { name: '八卦甲', effect: '减少Token消耗' },
    'local-first': { name: '仁王盾', effect: '隐私保护' },
    'cache': { name: '白银狮子', effect: '缓存加速' }
  },
  
  // 坐骑
  mounts: {
    'fast-routing': { name: '赤兔马', effect: '速度+1' },
    'load-balance': { name: '的卢', effect: '稳定性+1' },
    'multi-source': { name: '爪黄飞电', effect: '灵活调度' }
  }
};

// ============ 锦囊映射 ============
const TRICKS = {
  'peach': { name: '桃', effect: '修复Bug', icon: '🍑' },
  'wuxie': { name: '无懈可击', effect: '代码审查', icon: '🛡️' },
  'shunqian': { name: '顺手牵羊', effect: '代码提取', icon: '🐑' },
  'jiedao': { name: '借刀杀人', effect: '格式转换', icon: '🔪' },
  'guohe': { name: '过河拆桥', effect: '代码清理', icon: '🌉' },
  'nanman': { name: '南蛮入侵', effect: '批量操作', icon: '⚔️' },
  'wanjian': { name: '万箭齐发', effect: '并发请求', icon: '🏹' },
  'lightning': { name: '闪电', effect: '性能分析', icon: '⚡' },
  'lebusishu': { name: '乐不思蜀', effect: '暂停执行', icon: '🎵' }
};

// ============ 势力配置 ============
const FACTIONS = {
  wei: {
    name: '魏',
    title: '霸业',
    color: '#1a1a2e',
    description: '强大算力，快速响应',
    capital: '洛阳',
    emblem: '魏'
  },
  shu: {
    name: '蜀',
    title: '仁义',
    color: '#c41e3a',
    description: '本地优先，隐私安全',
    capital: '成都',
    emblem: '蜀'
  },
  wu: {
    name: '吴',
    title: '江东',
    color: '#0f4c5c',
    description: '免费为主，灵活变通',
    capital: '建业',
    emblem: '吴'
  },
  qun: {
    name: '群',
    title: '自立',
    color: '#5c415d',
    description: '社区共享，互助互利',
    capital: '各地',
    emblem: '群'
  }
};

// ============ 术语映射 ============
const TERMINOLOGY = {
  // 资源相关
  'token': '粮草',
  'tokens': '粮草',
  'credit': '军功',
  'credits': '军功',
  'quota': '配额',
  
  // 模型相关
  'model': '武将',
  'models': '武将',
  'agent': '武将',
  'assistant': '武将',
  'general': '武将',
  
  // 操作相关
  'call': '出战',
  'invoke': '点将',
  'summon': '点将',
  'deploy': '部署',
  'execute': '执行',
  
  // 结果相关
  'success': '告捷',
  'failure': '败北',
  'error': '失误',
  'timeout': '延误军情',
  
  // 功能相关
  'skill': '技能',
  'prompt': '锦囊',
  'mcp': '神兵',
  'tool': '器械',
  'equipment': '装备',
  
  // 网络相关
  'gateway': '军师府',
  'route': '调兵',
  'routing': '布阵',
  'formation': '阵法',
  'strategy': '战术',
  
  // 统计相关
  'trace': '战报',
  'report': '战报',
  'dashboard': '功勋簿',
  'usage': '战绩',
  'stats': '统计',
  
  // 性能相关
  'latency': '行军速度',
  'throughput': '兵力',
  'concurrent': '并发',
  'cache': '粮仓',
  'compression': '精简军令',
  
  // 社交相关
  'circle': '联盟',
  'alliance': '联盟',
  'share': '援军',
  'contribute': '出兵',
  
  // 配置相关
  'config': '军令',
  'setting': '设置',
  'api-key': '兵符'
};

// ============ 武将羁绊系统 ============
const BONDS = {
  'taoyuan': {
    name: '桃园结义',
    generals: ['关羽', '张飞', '刘备'],
    effect: '团队作战效率 +15%',
    description: '桃园三结义，不求同年同月同日生，但求同年同月同日出战'
  },
  'wolongfengchu': {
    name: '卧龙凤雏',
    generals: ['诸葛亮', '庞统'],
    effect: '智力任务准确度 +20%',
    description: '卧龙凤雏，得一可安天下'
  },
  'jiangdong': {
    name: '江东之虎',
    generals: ['孙权', '周瑜', '鲁肃'],
    effect: '免费资源优先级 +30%',
    description: '江东子弟多才俊'
  },
  'moushi': {
    name: '谋士联盟',
    generals: ['诸葛亮', '司马懿', '郭嘉'],
    effect: '复杂任务成功率 +25%',
    description: '群英荟萃，智谋无双'
  },
  'wuhu': {
    name: '五虎上将',
    generals: ['关羽', '张飞', '赵云', '马超', '黄忠'],
    effect: '全属性 +10%',
    description: '蜀汉五虎，威震华夏'
  }
};

// ============ 成就系统 ============
const ACHIEVEMENTS = {
  'first-general': {
    name: '初出茅庐',
    description: '首次招募武将',
    reward: { merit: 50 },
    icon: '🏅'
  },
  'first-battle': {
    name: '初战告捷',
    description: '首次点将成功',
    reward: { merit: 30, unlock: 'advanced-generals' },
    icon: '⚔️'
  },
  'hundred-battles': {
    name: '百战名将',
    description: '单个武将出战100次',
    reward: { star: 1 },
    icon: '⭐'
  },
  'thrifty': {
    name: '节俭军师',
    description: '累计节省10000粮草',
    reward: { formation: 'yanyue' },
    icon: '💰'
  },
  'helper': {
    name: '援军统帅',
    description: '派遣援军50次',
    reward: { reputation: 100 },
    icon: '🤝'
  },
  'master': {
    name: '八阵图师',
    description: '收集所有阵法',
    reward: { title: '阵法大师' },
    icon: '☯️'
  },
  'five-star': {
    name: '五虎上将',
    description: '同时拥有5个五星武将',
    reward: { skin: 'legendary' },
    icon: '🌟'
  }
};

// ============ 主题配置 ============
const THEME_CONFIG = {
  enabled: false, // 默认关闭，用户可开启
  
  // 视觉配置
  visuals: {
    style: 'classic',        // 经典中国风
    animations: true,        // 启用动画
    sounds: true,            // 启用音效
    particleEffects: true    // 粒子特效
  },
  
  // 功能配置
  features: {
    achievements: true,      // 成就系统
    ranks: true,             // 排行榜
    bonds: true,             // 羁绊系统
    dailyQuests: true,       // 每日任务
    seasons: false           // 赛季系统（待开发）
  },
  
  // 兼容性
  compatibility: {
    fallbackToOriginal: true,  // 失败时回退到原版
    showOriginalNames: true,   // 显示原始模型名
    professionalMode: false    // 专业模式（隐藏游戏化）
  }
};

// ============ 工具函数 ============

/**
 * 将模型名映射为武将名
 */
function mapModelToGeneral(modelName) {
  // 精确匹配
  if (GENERAL_MAPPING[modelName]) {
    return GENERAL_MAPPING[modelName];
  }
  
  // 模糊匹配
  const lowerModel = modelName.toLowerCase();
  for (const [key, general] of Object.entries(GENERAL_MAPPING)) {
    if (lowerModel.includes(key.toLowerCase())) {
      return general;
    }
  }
  
  // 未找到，返回原名
  return {
    name: modelName,
    faction: 'qun',
    title: '异人',
    stars: 3,
    attributes: { power: 7, intelligence: 7, leadership: 7, stamina: 80 },
    skills: [],
    description: '未知的强者'
  };
}

/**
 * 翻译术语
 */
function translateTerm(term, toSanguosha = true) {
  if (!THEME_CONFIG.enabled) return term;
  
  if (toSanguosha) {
    return TERMINOLOGY[term.toLowerCase()] || term;
  } else {
    // 反向查找
    const entry = Object.entries(TERMINOLOGY).find(([_, v]) => v === term);
    return entry ? entry[0] : term;
  }
}

/**
 * 检查武将羁绊
 */
function checkBonds(generalNames) {
  const activeBonds = [];
  
  for (const [bondId, bond] of Object.entries(BONDS)) {
    const hasAllGenerals = bond.generals.every(g => generalNames.includes(g));
    if (hasAllGenerals) {
      activeBonds.push({ id: bondId, ...bond });
    }
  }
  
  return activeBonds;
}

/**
 * 计算属性加成
 */
function calculateBonus(formation, bonds = []) {
  let bonus = { ...FORMATIONS[formation]?.bonus } || {};
  
  // 应用羁绊加成
  bonds.forEach(bond => {
    if (bond.effect.includes('全属性')) {
      const match = bond.effect.match(/\+(\d+)%/);
      if (match) {
        const percent = parseInt(match[1]) / 100;
        Object.keys(bonus).forEach(key => {
          bonus[key] = (bonus[key] || 1.0) * (1 + percent);
        });
      }
    }
  });
  
  return bonus;
}

// ============ 导出 ============
module.exports = {
  GENERAL_MAPPING,
  FORMATIONS,
  EQUIPMENT,
  TRICKS,
  FACTIONS,
  TERMINOLOGY,
  BONDS,
  ACHIEVEMENTS,
  THEME_CONFIG,
  
  // 工具函数
  mapModelToGeneral,
  translateTerm,
  checkBonds,
  calculateBonus
};
