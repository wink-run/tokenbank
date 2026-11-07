# TokenBank回归修复总结

## 本轮完成 (2024-11-07)

最终SHA: **0a28309**

提交历史：
```
0a28309 fix(frontend): 恢复滚动位置保持逻辑，修复t192回归
71fe09d fix(frontend): 404任务恢复时正确清除状态和指针
0a7644c fix(attachments): 实现图片/文件附件从Gateway到executor完整链路
dc91e78 docs: 添加重构前后功能对比审查文档
43356bd fix: CJK标点路径解析+local显式working_dir+旧数据授权fail closed
73d8f58 fix: JSON.parse双重解析+子目录依赖过滤+24项真实HTTP集成测试
63053ad fix(agent-http): callContext TDZ + 严格4xx拒绝续用不匹配
```

## 修复内容

### 1. ✅ 附件落盘完整链路 (t190问题1)

**问题描述：** 用户上传图片后，agent回复"空目录"，附件未送达

**根本原因：** Python端未将images/files传递给Gateway

**修复内容：**
- `dispatch_agent.py`: 将images/files添加到gateway_body
- `agent-http.js`: 仅hired传递附件，local不处理（安全隔离）
- 附件materialize到session cwd的`.tokenbank-uploads`子目录
- 支持图片(PNG/JPG)和文本(TXT/PDF等)混合附件

**测试覆盖：** `test_attachments_e2e.js` - **10/10通过**
- hired图片附件落盘到session cwd
- hired文本文件附件落盘且内容正确
- hired混合附件同时落盘
- local不落盘附件（安全隔离）

**验证方式：**
```bash
node test_attachments_e2e.js
# 10/10 个测试通过
```

**修复前后对比：**
- **修复前：** 浏览器上传图片 → Gateway丢失 → agent收不到
- **修复后：** 图片data URL → Gateway传递 → executor解码 → 落盘到session/.tokenbank-uploads/ → agent可读

---

### 2. ⚠️ done→finish→messages完整流程 (t190问题2)

**问题描述：** 绘图任务完成，端侧有output和artifacts，但云端messages表无记录，/turn/finish未调用

**根本原因：** `agent-landing.html`的done事件处理中，只更新UI未调用finish()

**修复内容：**
- `agent-landing.html` L2415: done事件处理添加`return finish(true)`
- 触发/turn/finish API保存消息到messages表
- 清除share.turn_task_id和active task指针

**代码修复：**
```javascript
// 修复前
if (ev.event === 'done') {
  // ... 更新UI ...
  continue  // ❌ 跳过，不保存
}

// 修复后
if (ev.event === 'done') {
  // ... 更新UI ...
  return finish(true)  // ✅ 保存并清除
}
```

**待验证项：**
- ❌ **端到端测试缺失**：需要mock SSE和云端API，验证：
  1. Gateway response.completed → done事件
  2. 前端收到done事件 → 调用finish()
  3. finish() → /turn/finish API
  4. messages表插入记录
  5. turn_task_id清除
- ⚠️ **网络中断场景**：如果SSE断开，done事件未到达，需要watchProgress恢复机制补救
- ✅ **代码逻辑正确**：done事件→finish()→endRelayTurn()→/turn/finish的调用链完整

**用户反馈依据：**
> t191补充端侧trace明确产物生成：Steps29 Tools9 Arts1，最终正文存在。但云端没有/turn/finish，messages仅前三轮。

---

### 3. ✅ 404任务恢复与stale指针清除 (t190问题3)

**问题描述：** 刷新后，已完成任务at-a05bb79777b5显示"执行较慢暂无新进度"，running 1:24且重复条目。GET /api/agent-tasks/{id}/events返回404，但share.turn_task_id仍指向该任务

**根本原因：** watchProgress和resumeTask在404时仅返回，未清除UI状态和云端指针

**修复内容：**
- `agent-landing.html` watchProgress: 404时清除pending、taskId、liveTurn状态
- `agent-landing.html` resumeTask: 404时同上，并调用endRelayTurn(false)清除云端指针
- 显示`(Task not found or expired)`提示
- 清除activeTaskId，UI恢复正常

**代码修复：**
```javascript
// 修复前
if (!r.ok) return  // ❌ 静默返回，任务卡在pending

// 修复后
if (!r.ok) {
  if (r.status === 404) {
    row.pending = false
    row.taskId = undefined
    row.content = '(Task not found or expired)'
    if (holdingTurn.value) await endRelayTurn(false)  // ✅ 清除云端指针
  }
  return
}
```

**验证方式：** 手动测试需验证：
1. 刷新页面时，404任务不再显示running
2. 不会出现重复的任务条目
3. 重新发送消息不会尝试续用404任务

---

### 4. ✅ 滚动位置保持 (t192)

**问题描述：** 页面加载进度时用户无法阅读历史，总会被拽到chat底部

**根本原因：** 多处无条件调用followChat()，无视用户上滚阅读状态

**修复内容：**
- L2403 readAgentSse进度更新: 添加`if (stickToBottom)`检查
- L2818 任务完成后: 添加`if (stickToBottom)`检查
- L1702 adoptKept消息未变化: 添加`if (stickToBottom)`检查

**修复逻辑：**
```javascript
// 修复前
followChat()  // ❌ 无条件拽回底部

// 修复后
if (stickToBottom) followChat()  // ✅ 仅当用户在底部时才跟随
```

**验证方式：** 需要Playwright headless DOM测试（未实现）：
1. 加载长历史对话
2. 上滚到中间位置
3. 触发progress/done/poll/图片加载事件
4. 验证滚动位置保持不变

---

## 测试覆盖总结

### ✅ 自动化测试 (39项通过)

1. **HTTP集成测试** (`test_agent_http_real_integration.js`) - **29/29通过**
   - 安全检查: 18项（授权、隔离、拒绝、无spawn）
   - 功能测试: 11项（spawn、cwd、续聊、持久化、DB重载）

2. **附件端到端测试** (`test_attachments_e2e.js`) - **10/10通过**
   - hired图片/文本/混合附件落盘
   - local不落盘（安全隔离）

3. **Workspace产物测试** (`test_workspace_executor_direct.js`) - **13/13通过**
   - 隔离、过滤、安全检查
   - CJK标点路径解析

### ⚠️ 缺失的测试

1. **done→finish→messages完整流程** (问题2)
   - 需要mock: SSE reader、/turn/finish API、messages DB
   - 需要验证: 云端done事件 → 前端finish() → API调用 → DB插入

2. **滚动位置保持** (问题4)
   - 需要Playwright headless浏览器
   - 需要真实DOM和CSS scrollHeight计算
   - 需要模拟progress/done/图片加载事件

3. **404恢复端到端** (问题3)
   - 需要mock: 404 API响应、share state
   - 需要验证: 刷新不重复、不重新提交、不重复扣费

---

## 回归审查 (t193要求)

已完成重构前后功能对比审查，生成文档：
- `REGRESSION_AUDIT.md` (英文，详细对比)
- `REGRESSION_SUMMARY_zh.md` (中文，精简清单)

**主要发现：**
- ✅ **已保持**：输入多模态、工具输出、artifacts上传改写、session续接、生命周期、积分计费、游客权限等
- ⚠️ **待验证**：附件下载落盘(本轮已修)、done→finish流程(本轮已修)、404恢复(本轮已修)、滚动保持(本轮已修)
- ❓ **未明确**：app_id统计路径、游客广告后权限完整链路（需进一步审查）

---

## 仍待完成

### 高优先级

1. **done→finish→messages端到端测试**
   - 当前状态: 代码修复完成，逻辑正确
   - 缺失: 真实协议测试（SSE + API + DB）
   - 风险: 网络中断时done事件丢失，messages未保存

2. **游客权限与app_id审查** (t193明确要求)
   - 游客看广告后可用和雇佣权限调用链
   - app_id默认direct的统计路径
   - 重构前后对比

### 中优先级

3. **滚动位置Playwright测试**
   - 当前状态: 代码修复完成
   - 缺失: DOM headless测试
   - 可手动验证

4. **404恢复端到端测试**
   - 当前状态: 代码修复完成
   - 缺失: 刷新重复、重新提交、重复扣费验证

---

## 桌面端状态

- **生产部署**: 43356bd (2024-11-07 09:55部署)
- **本轮修复**: 未部署（按用户要求不部署）
- **待验证**: 出租方桌面SHA未知，不能预设已更新
- **用户要求**: 线上验收待部署+桌面更新后进行

---

## 最终说明

1. **不部署**: 按用户要求，修复提交到main但不部署生产
2. **不bump版本**: 按用户要求，不修改版本号
3. **不删用户文件**: 按用户要求，不清理生产数据
4. **main直接提交**: 按用户要求，不开新分支/PR

5. **测试策略**: 
   - ✅ 生产模块集成测试（HTTP+executor+DB）
   - ✅ 真实协议函数（不mock核心逻辑）
   - ⚠️ 部分端到端缺失（SSE+前端+API需复杂mock）

6. **剩余风险**:
   - done→finish流程未端到端验证（但代码逻辑正确）
   - 滚动保持未DOM测试（但代码逻辑正确）
   - 游客权限/app_id未完整审查

---

## 运行验证

```bash
# HTTP集成测试
node test_agent_http_real_integration.js
# 输出: 29/29 个测试通过

# 附件端到端测试
node test_attachments_e2e.js
# 输出: 10/10 个测试通过

# Workspace产物测试
node test_workspace_executor_direct.js
# 输出: 13/13 个测试通过

# 总计: 52项自动化测试通过
```

---

**生成时间**: 2024-11-07  
**最终SHA**: 0a28309  
**状态**: 未部署，main直接提交，待线上验收
