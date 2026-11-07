/**
 * Token Bank · 三国杀主题 UI 组件
 * 
 * 提供三国杀风格的UI组件和渲染函数
 */

const { mapModelToGeneral, translateTerm, FORMATIONS, FACTIONS } = require('./sanguosha-theme');

// ============ 武将卡片组件 ============

/**
 * 生成武将卡片HTML
 * @param {Object} general - 武将数据
 * @param {Object} options - 选项
 */
function renderGeneralCard(general, options = {}) {
  const { showStats = true, selectable = false, selected = false } = options;
  const faction = FACTIONS[general.faction];
  
  return `
    <div class="general-card ${selectable ? 'selectable' : ''} ${selected ? 'selected' : ''}" 
         data-general="${general.name}"
         style="border-color: ${faction.color}">
      
      <!-- 武将头像区 -->
      <div class="general-avatar">
        <div class="general-portrait">
          <img src="/assets/generals/${general.name}.png" 
               alt="${general.name}"
               onerror="this.src='/assets/generals/default.png'">
        </div>
        <div class="general-stars">
          ${'⭐'.repeat(general.stars)}
        </div>
      </div>
      
      <!-- 武将信息区 -->
      <div class="general-info">
        <div class="general-header">
          <h3 class="general-name">${general.name}</h3>
          <span class="general-title">${general.title}</span>
          <span class="general-faction" style="background: ${faction.color}">
            ${faction.emblem}
          </span>
        </div>
        
        ${showStats ? `
          <div class="general-attributes">
            <div class="attribute">
              <span class="attr-label">武力</span>
              <div class="attr-bar">
                <div class="attr-fill" style="width: ${general.attributes.power * 10}%"></div>
              </div>
              <span class="attr-value">${general.attributes.power}</span>
            </div>
            <div class="attribute">
              <span class="attr-label">智力</span>
              <div class="attr-bar">
                <div class="attr-fill" style="width: ${general.attributes.intelligence * 10}%"></div>
              </div>
              <span class="attr-value">${general.attributes.intelligence}</span>
            </div>
            <div class="attribute">
              <span class="attr-label">统帅</span>
              <div class="attr-bar">
                <div class="attr-fill" style="width: ${general.attributes.leadership * 10}%"></div>
              </div>
              <span class="attr-value">${general.attributes.leadership}</span>
            </div>
            <div class="attribute stamina">
              <span class="attr-label">体力</span>
              <div class="attr-bar stamina-bar">
                <div class="attr-fill" style="width: ${general.attributes.stamina}%"></div>
              </div>
              <span class="attr-value">${general.attributes.stamina}%</span>
            </div>
          </div>
        ` : ''}
        
        <!-- 技能列表 -->
        <div class="general-skills">
          ${general.skills.map(skill => `
            <span class="skill-tag">${skill}</span>
          `).join('')}
        </div>
        
        <!-- 描述 -->
        <p class="general-description">${general.description}</p>
        
        ${options.showActions ? `
          <div class="general-actions">
            <button class="btn-summon" onclick="summonGeneral('${general.name}')">
              点将
            </button>
            <button class="btn-detail" onclick="viewGeneralDetail('${general.name}')">
              详情
            </button>
          </div>
        ` : ''}
      </div>
    </div>
  `;
}

// ============ 阵法选择器组件 ============

/**
 * 生成阵法选择器HTML
 */
function renderFormationPicker(currentFormation) {
  return `
    <div class="formation-picker">
      <h3>选择阵法</h3>
      <div class="formation-grid">
        ${Object.entries(FORMATIONS).map(([id, formation]) => `
          <div class="formation-card ${currentFormation === id ? 'active' : ''}"
               onclick="selectFormation('${id}')">
            <div class="formation-icon">${formation.icon}</div>
            <h4 class="formation-name">${formation.name}</h4>
            <p class="formation-type">${formation.type === 'defense' ? '防御' : formation.type === 'offense' ? '进攻' : '平衡'}</p>
            <p class="formation-desc">${formation.description}</p>
            <div class="formation-bonus">
              ${Object.entries(formation.bonus).map(([key, value]) => {
                const percentage = ((value - 1) * 100).toFixed(0);
                const sign = value >= 1 ? '+' : '';
                let label = key;
                if (key === 'speed') label = '速度';
                else if (key === 'cost') label = '成本';
                else if (key === 'privacy') label = '隐私';
                else if (key === 'stability') label = '稳定';
                else if (key === 'throughput') label = '吞吐';
                return `<span class="bonus-item">${label} ${sign}${percentage}%</span>`;
              }).join('')}
            </div>
            <div class="formation-creator">创制: ${formation.creator}</div>
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

// ============ 战报组件 ============

/**
 * 生成战报HTML
 * @param {Object} report - 战报数据
 */
function renderBattleReport(report) {
  return `
    <div class="battle-report scroll-style">
      <!-- 战报头部 -->
      <div class="report-header">
        <h2 class="report-title">${report.title || '战报'}</h2>
        <div class="report-meta">
          <span class="report-time">${new Date(report.timestamp).toLocaleString()}</span>
          <span class="report-battlefield">${report.battlefield}</span>
        </div>
      </div>
      
      <!-- 参战武将 -->
      <div class="report-generals">
        <div class="general-info">
          <img src="/assets/generals/${report.general}.png" 
               alt="${report.general}"
               onerror="this.src='/assets/generals/default.png'">
          <div>
            <h4>${report.general}</h4>
            <p>主将</p>
          </div>
        </div>
        <div class="formation-info">
          <span class="formation-icon">${FORMATIONS[report.formation]?.icon || '⚔️'}</span>
          <p>${FORMATIONS[report.formation]?.name || report.formation}</p>
        </div>
      </div>
      
      <!-- 战斗经过 -->
      <div class="report-process">
        <h3>战斗经过</h3>
        <div class="process-timeline">
          ${report.process.map((step, index) => `
            <div class="process-step">
              <div class="step-number">${index + 1}</div>
              <div class="step-content">
                <p class="step-action">${step.action}</p>
                ${step.cost ? `<span class="step-cost">消耗粮草: ${step.cost}</span>` : ''}
              </div>
            </div>
          `).join('')}
        </div>
      </div>
      
      <!-- 战果统计 -->
      <div class="report-result ${report.result.success ? 'victory' : 'defeat'}">
        <h3>${report.result.success ? '🎉 战斗胜利！' : '😔 战斗失败'}</h3>
        <div class="result-stats">
          <div class="stat-item">
            <span class="stat-label">获得军功</span>
            <span class="stat-value merit">+${report.result.merit}</span>
          </div>
          <div class="stat-item">
            <span class="stat-label">消耗粮草</span>
            <span class="stat-value cost">-${report.result.cost}</span>
          </div>
          <div class="stat-item">
            <span class="stat-label">战斗用时</span>
            <span class="stat-value">${report.result.duration}s</span>
          </div>
        </div>
      </div>
    </div>
  `;
}

// ============ 点将台组件 ============

/**
 * 生成点将台HTML
 */
function renderSummonPanel(availableGenerals, currentFormation) {
  return `
    <div class="summon-panel">
      <div class="panel-header">
        <h2>点将台</h2>
        <p class="subtitle">选择武将出战完成任务</p>
      </div>
      
      <!-- 任务描述区 -->
      <div class="task-description">
        <h3>当前战况</h3>
        <textarea id="task-input" 
                  placeholder="描述需要完成的任务，如：审查代码、修复Bug、生成文档..."
                  rows="3"></textarea>
      </div>
      
      <!-- 推荐阵法 -->
      <div class="recommended-formation">
        <h4>推荐阵法</h4>
        <div class="formation-suggestion">
          <span class="formation-icon">${FORMATIONS[currentFormation]?.icon || '⚔️'}</span>
          <span class="formation-name">${FORMATIONS[currentFormation]?.name || '未选择'}</span>
          <button class="btn-change-formation" onclick="openFormationPicker()">
            更换阵法
          </button>
        </div>
      </div>
      
      <!-- 可用武将列表 -->
      <div class="available-generals">
        <h3>可用武将</h3>
        <div class="generals-list">
          ${availableGenerals.map(general => `
            <div class="general-item ${general.attributes.stamina < 20 ? 'low-stamina' : ''}"
                 onclick="selectGeneral('${general.name}')">
              <img src="/assets/generals/${general.name}.png" 
                   alt="${general.name}"
                   onerror="this.src='/assets/generals/default.png'">
              <div class="general-item-info">
                <h4>${general.name}</h4>
                <div class="stamina-bar">
                  <div class="stamina-fill" style="width: ${general.attributes.stamina}%"></div>
                </div>
              </div>
              <span class="general-faction-badge" 
                    style="background: ${FACTIONS[general.faction].color}">
                ${FACTIONS[general.faction].emblem}
              </span>
            </div>
          `).join('')}
        </div>
      </div>
      
      <!-- 口令卡片 -->
      <div class="command-card">
        <h3>点将口令</h3>
        <div class="command-text" id="command-text">
          请先选择武将
        </div>
        <button class="btn-copy-command" 
                id="btn-copy-command" 
                onclick="copyCommand()"
                disabled>
          复制口令
        </button>
      </div>
      
      <!-- 操作按钮 -->
      <div class="panel-actions">
        <button class="btn-primary btn-summon" 
                onclick="confirmSummon()"
                disabled
                id="btn-summon">
          点将出战
        </button>
        <button class="btn-secondary" onclick="closePanel()">
          取消
        </button>
      </div>
    </div>
  `;
}

// ============ 功勋簿组件 ============

/**
 * 生成功勋簿HTML
 */
function renderMeritBook(stats) {
  return `
    <div class="merit-book">
      <div class="book-header">
        <h1>功勋簿</h1>
        <div class="period-selector">
          <button class="active">本月</button>
          <button>本周</button>
          <button>今日</button>
        </div>
      </div>
      
      <!-- 总览卡片 -->
      <div class="stats-overview">
        <div class="stat-card">
          <div class="stat-icon">⚔️</div>
          <div class="stat-info">
            <h3>出战次数</h3>
            <p class="stat-number">${stats.battles}</p>
          </div>
        </div>
        <div class="stat-card">
          <div class="stat-icon">🏆</div>
          <div class="stat-info">
            <h3>胜率</h3>
            <p class="stat-number">${stats.winRate}%</p>
          </div>
        </div>
        <div class="stat-card">
          <div class="stat-icon">🎖️</div>
          <div class="stat-info">
            <h3>军功</h3>
            <p class="stat-number">+${stats.merit}</p>
          </div>
        </div>
        <div class="stat-card">
          <div class="stat-icon">🌾</div>
          <div class="stat-info">
            <h3>粮草节省</h3>
            <p class="stat-number">${stats.saved}</p>
          </div>
        </div>
      </div>
      
      <!-- 武将排行榜 -->
      <div class="general-ranking">
        <h2>武将排行榜</h2>
        <div class="ranking-list">
          ${stats.topGenerals.map((item, index) => {
            const medals = ['🥇', '🥈', '🥉'];
            return `
              <div class="ranking-item">
                <span class="rank">${medals[index] || (index + 1)}</span>
                <img src="/assets/generals/${item.general}.png" 
                     alt="${item.general}"
                     onerror="this.src='/assets/generals/default.png'">
                <span class="general-name">${item.general}</span>
                <span class="battles">${item.battles}次出战</span>
                <span class="win-rate">${item.winRate}%胜率</span>
              </div>
            `;
          }).join('')}
        </div>
      </div>
      
      <!-- 阵法使用统计 -->
      <div class="formation-stats">
        <h2>阵法使用分布</h2>
        <div class="formation-chart">
          ${Object.entries(stats.formations).map(([id, usage]) => `
            <div class="formation-bar">
              <span class="formation-label">
                ${FORMATIONS[id]?.icon} ${FORMATIONS[id]?.name}
              </span>
              <div class="bar-container">
                <div class="bar-fill" style="width: ${usage.percentage}%"></div>
              </div>
              <span class="formation-count">${usage.count}次 (${usage.percentage}%)</span>
            </div>
          `).join('')}
        </div>
      </div>
      
      <!-- 生成海报按钮 -->
      <div class="book-actions">
        <button class="btn-primary" onclick="generatePoster()">
          生成战绩海报
        </button>
        <button class="btn-secondary" onclick="exportReport()">
          导出战报
        </button>
      </div>
    </div>
  `;
}

// ============ 托盘悬浮窗 ============

/**
 * 生成托盘悬浮窗HTML
 */
function renderTrayPopover(state) {
  return `
    <div class="tray-popover sanguosha-theme">
      <!-- 头部 -->
      <div class="popover-header">
        <h3>Token Bank 三国志</h3>
        <div class="status-badge ${state.gatewayRunning ? 'running' : 'stopped'}">
          ${state.gatewayRunning ? '军师府运转中' : '军师府休整'}
        </div>
      </div>
      
      <!-- 今日战况 -->
      <div class="today-summary">
        <h4>今日战况</h4>
        <div class="summary-stats">
          <div class="stat">
            <span class="label">出战</span>
            <span class="value">${state.todayBattles}次</span>
          </div>
          <div class="stat">
            <span class="label">军功</span>
            <span class="value">+${state.todayMerit}</span>
          </div>
          <div class="stat">
            <span class="label">点将</span>
            <span class="value">${state.todayGenerals}次</span>
          </div>
        </div>
      </div>
      
      <!-- 在营武将 -->
      <div class="generals-status">
        <h4>在营武将: ${state.activeGenerals}/${state.totalGenerals}</h4>
        <div class="current-formation">
          当前阵法: ${FORMATIONS[state.currentFormation]?.icon} ${FORMATIONS[state.currentFormation]?.name}
        </div>
      </div>
      
      <!-- 快速点将 -->
      <div class="quick-summon">
        <h4>⚔️ 快速点将</h4>
        ${state.quickCommands.map(cmd => `
          <div class="command-item" onclick="copyToClipboard('${cmd.text}')">
            <span class="command-text">${cmd.text}</span>
            <span class="copy-icon">📋</span>
          </div>
        `).join('')}
      </div>
      
      <!-- 快捷操作 -->
      <div class="popover-actions">
        <button onclick="openMainWindow()">打开军师府</button>
        <button onclick="openPlayground()">演武场</button>
      </div>
    </div>
  `;
}

// ============ CSS样式 ============

const SANGUOSHA_STYLES = `
/* 三国杀主题样式 */
.sanguosha-theme {
  font-family: 'KaiTi', 'SimSun', serif;
  background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
  color: #f5f5dc;
}

/* 武将卡片 */
.general-card {
  background: linear-gradient(145deg, #2d3436 0%, #1e272e 100%);
  border: 3px solid #d4af37;
  border-radius: 12px;
  padding: 16px;
  box-shadow: 0 8px 16px rgba(0,0,0,0.3);
  transition: all 0.3s ease;
}

.general-card:hover {
  transform: translateY(-4px);
  box-shadow: 0 12px 24px rgba(212, 175, 55, 0.3);
}

.general-card.selectable {
  cursor: pointer;
}

.general-card.selected {
  border-color: #ff6b6b;
  box-shadow: 0 0 20px rgba(255, 107, 107, 0.5);
}

.general-avatar {
  position: relative;
  text-align: center;
  margin-bottom: 12px;
}

.general-portrait img {
  width: 120px;
  height: 160px;
  object-fit: cover;
  border-radius: 8px;
  border: 2px solid #d4af37;
}

.general-stars {
  margin-top: 8px;
  font-size: 14px;
}

.general-info {
  text-align: center;
}

.general-header {
  margin-bottom: 12px;
}

.general-name {
  font-size: 24px;
  font-weight: bold;
  color: #d4af37;
  margin: 0;
}

.general-title {
  font-size: 14px;
  color: #95a5a6;
}

.general-faction {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 4px;
  color: white;
  font-size: 12px;
  margin-left: 8px;
}

/* 属性条 */
.general-attributes {
  margin: 12px 0;
}

.attribute {
  display: flex;
  align-items: center;
  margin: 6px 0;
}

.attr-label {
  width: 40px;
  font-size: 12px;
  color: #bdc3c7;
}

.attr-bar {
  flex: 1;
  height: 8px;
  background: #34495e;
  border-radius: 4px;
  overflow: hidden;
  margin: 0 8px;
}

.attr-fill {
  height: 100%;
  background: linear-gradient(90deg, #3498db, #2ecc71);
  transition: width 0.3s ease;
}

.attribute.stamina .attr-fill {
  background: linear-gradient(90deg, #e74c3c, #c0392b);
}

.attr-value {
  width: 30px;
  text-align: right;
  font-size: 12px;
  font-weight: bold;
}

/* 技能标签 */
.general-skills {
  margin: 8px 0;
}

.skill-tag {
  display: inline-block;
  background: rgba(52, 152, 219, 0.2);
  border: 1px solid #3498db;
  color: #3498db;
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 12px;
  margin: 2px;
}

/* 战报样式 */
.battle-report {
  background: #f5f5dc;
  color: #2c3e50;
  padding: 24px;
  border-radius: 8px;
  max-width: 800px;
  margin: 0 auto;
}

.scroll-style {
  background-image: url('/assets/scroll-bg.png');
  background-size: cover;
}

.report-header {
  text-align: center;
  border-bottom: 2px solid #d4af37;
  padding-bottom: 16px;
  margin-bottom: 16px;
}

.report-title {
  font-size: 28px;
  color: #8b0000;
  margin: 0;
}

.process-timeline {
  position: relative;
  padding-left: 40px;
}

.process-step {
  display: flex;
  margin-bottom: 16px;
}

.step-number {
  width: 32px;
  height: 32px;
  background: #d4af37;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: bold;
  color: white;
  margin-right: 12px;
}

.step-content {
  flex: 1;
}

/* 阵法选择器 */
.formation-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 16px;
}

.formation-card {
  background: #2d3436;
  border: 2px solid #95a5a6;
  border-radius: 8px;
  padding: 16px;
  text-align: center;
  cursor: pointer;
  transition: all 0.3s ease;
}

.formation-card:hover {
  border-color: #d4af37;
  transform: translateY(-4px);
}

.formation-card.active {
  border-color: #ff6b6b;
  background: rgba(255, 107, 107, 0.1);
}

.formation-icon {
  font-size: 48px;
  margin-bottom: 8px;
}

/* 动画效果 */
@keyframes summon-animation {
  0% { transform: scale(0.5); opacity: 0; }
  50% { transform: scale(1.1); }
  100% { transform: scale(1); opacity: 1; }
}

.general-card.summoning {
  animation: summon-animation 0.5s ease-out;
}

@keyframes merit-gain {
  0% { transform: translateY(0); }
  50% { transform: translateY(-20px); }
  100% { transform: translateY(0); opacity: 0; }
}

.merit-popup {
  animation: merit-gain 1s ease-out;
}
`;

// ============ 导出 ============
module.exports = {
  renderGeneralCard,
  renderFormationPicker,
  renderBattleReport,
  renderSummonPanel,
  renderMeritBook,
  renderTrayPopover,
  SANGUOSHA_STYLES
};
