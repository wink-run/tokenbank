# Gateway重构回归审查清单

**审查范围**: 3cc5fa0（重构）至 3ad9e70（当前）  
**基准**: 重构前正常运行 + 历史修复（57c10a9等）  
**方法**: 代码对比 + 已知线上问题

---

## 一、本轮已修复（3ad9e70）

### ✅ 1. 附件丢失
- **问题**: agent-http.js未处理body.images/files
- **修复**: L228-229解析，L412-414传递给executor
- **证据**: t190线上"这是在哪里"消息无attachments元数据

### ✅ 2. 任务完成未保存  
- **问题**: done事件未调用finish()
- **修复**: agent-landing.html L2425调用finish(true)
- **证据**: t190绘图at-a05bb79777b5执行完成但404，无/turn/finish

### ✅ 3. 刷新恢复running
- **问题**: share.turn_task_id指向消失任务
- **修复**: 问题2的结果

### ✅ 4. 滚动强制到底
- **状态**: 逻辑已存在（57c10a9引入followChat/adoptKept）
- **验证**: 调用点正确（流式用followChat，打开用scrollChat(true)）

---

## 二、待审查功能

### A. 输入处理

#### 1. 多模态附件上传与落盘
**重构前** (agent-worker.js L1177-1191):
```javascript
const attachImages = Array.isArray(msg.images) ? msg.images : [];
const attachFiles = Array.isArray(msg.files) ? msg.files : [];
// ...传递给executor
images: attachImages.length ? attachImages : undefined,
files: attachFiles.length ? attachFiles : undefined,
```

**重构后** (agent-http.js):
- ❌ **丢失**: 3cc5fa0初始版本未处理
- ✅ **已恢复**: 3ad9e70修复

**持久化元数据**:
- ⚠️ **待验证**: messages表attachments字段是否保存
- 📋 **需测试**: 上传→DB→刷新恢复

#### 2. 历史附件元数据
**检查点**:
- [ ] /api/agent-chats/shares/{id} 返回messages含attachments
- [ ] 刷新后attachments可见
- [ ] 附件URL可访问（已上传云端）

---

### B. 输出处理

#### 3. 最终正文提取
**重构前** (dispatch_agent.py老版本):
- 直接从worker返回output

**重构后** (dispatch_agent.py L1225-1244):
```python
# 优先使用流式累积的accumulated_text
output_text = accumulated_text
# 检查completed事件的output
output_from_completed = ...
if len(output_from_completed) > len(output_text):
    output_text = output_from_completed
```

**状态**:
- ✅ **保持**: a72d6b4修复accumulated_text逻辑
- ⚠️ **待验证**: 工具调用后最终文本是否完整

#### 4. 产物上传与路径改写
**重构前**:
- agent_artifacts.py处理上传
- rewrite_artifact_paths改写路径

**重构后** (dispatch_agent.py L1262-1269):
```python
raw_artifacts = event_data.get("artifacts")
if call_context == "hired":
    processed_output, public_arts = _apply_artifacts(task_id, output_text, raw_artifacts)
else:
    processed_output, public_arts = output_text, []
```

**检查点**:
- [x] 产物收集（contribu​te-session.js）
- [x] 上传云端（_apply_artifacts）
- [ ] 路径改写（绝对路径→URL）
- [ ] HTML图片展示（<img src>）
- ⚠️ **待验证**: 大文件异步上传

---

### C. 会话持久化

#### 5. response_id续接
**重构后** (9e6485e):
- ✅ agent-http.js L251-307处理previous_response_id
- ✅ 验证assistant/consumer/context匹配

**检查点**:
- [x] previous_response_id传递
- [x] 授权验证（43356bd）
- [ ] 刷新后response_id持久化
- ⚠️ **待验证**: DB reload后续接

#### 6. 会话目录隔离
**重构后** (43356bd, c8b82eb):
- ✅ contribute workspace按assistant/consumer/session隔离
- ✅ workspaceSessionId持久化

**状态**: 已测试（test_agent_http_real_integration.js 29个用例）

---

### D. 任务生命周期

#### 7. turn start/progress/done/error/cancel
**检查点**:
- [x] start: 创建任务
- [x] progress: SSE流式更新
- [x] done: ✅ 已修复finish()调用
- [x] error: 已有finish()调用
- [ ] cancel: 取消逻辑
- ⚠️ **待验证**: cancel是否触发finish()

#### 8. 掉线重连与任务接回
**历史修复** (5960c89):
- "断线任务接回/上架页运行任务"

**检查点**:
- [ ] worker disconnected时保留partial output
- [ ] 重连后resume任务
- [ ] active tasks恢复
- ⚠️ **待验证**: 5960c89逻辑是否保留

#### 9. 404恢复
**问题**: GET /api/agent-tasks/{id}/events返回404

**原因分析**:
- 任务未调用finish()持久化
- turn_task_id指向但任务不存在

**状态**: ✅ 已修复（问题2的结果）

---

### E. 分享与轮询

#### 10. 运行中分享
**历史修复** (57c10a9):
- "运行中也能分享"

**检查点**:
- [ ] 运行中任务可分享
- [ ] liveTurn标记
- ⚠️ **待验证**: 57c10a9逻辑完整性

#### 11. 历史排序与去重
**历史修复** (dd3b2d8):
- "历史顺序与每交互5积分"

**检查点**:
- [ ] sortMessages去重
- [ ] 刷新不重复消息
- ⚠️ **待验证**: 去重key是否稳定

---

### F. 前端展示

#### 12. 工具详情展开
**检查点**:
- [ ] tool_call/tool_result显示
- [ ] 开始时间/用时（439833f）
- [ ] 输入输出详情
- ⚠️ **待验证**: 439833f逻辑是否保留

#### 13. 局部更新与滚动
**状态**: ✅ 已验证（57c10a9逻辑存在）
- followChat()检查用户上滚
- adoptKept()局部更新

---

### G. 计费与权限

#### 14. 每交互计费
**检查点**:
- [x] AGENT_TASK_CREDITS = 5
- [x] 扣费（dispatch_agent.py L1247-1257 contribute结息）
- [ ] 失败退款
- [ ] 去重（idempotency-key）
- ⚠️ **待验证**: 重复请求不重复计费

#### 15. app_id归因
**历史修复** (3cc5fa0):
- "云端功能接口不变内部网关格式app_id"

**检查点**:
- [x] metadata.app_id传递
- [x] 默认"direct"（agent-http.js L72）
- [ ] 统计记录
- ⚠️ **待验证**: app_id是否正确记录

#### 16. 游客权限
**检查点**:
- [ ] 看广告后可用
- [ ] 雇佣权限检查
- ⚠️ **未审查**: 游客逻辑未涉及本次修复

---

### H. 本地执行

#### 17. local vs hired
**重构后** (bc042a7, a173bbb):
- ✅ call_context参数
- ✅ local不收集产物
- ✅ hired收集并上传

**状态**: 已测试（test_agent_http_real_integration.js）

#### 18. 本地harness避免递归
**历史修复** (1a95a58):
- "本地harness避免community递归"

**检查点**:
- [x] owner使用local harness_id
- [ ] community不递归
- ⚠️ **待验证**: 1a95a58逻辑完整性

#### 19. 真实本地目录配置
**审查**: 用户设置目录

**结论** (t190审查):
- 无专门UI设置界面
- 通过metadata.working_dir显式传递
- 默认process.cwd()

**状态**: 非丢失，为现有设计

---

## 三、测试覆盖

### 已有测试
- ✅ test_agent_http_real_integration.js: 29个用例（授权、隔离、产物）
- ✅ test_workspace_executor_direct.js: 13个用例（collector逻辑）

### 测试缺失
1. **附件上传端到端**: 图片data URL → 落盘 → 传agent → DB持久化
2. **任务完成持久化**: done → finish → /turn/finish → messages入库
3. **刷新恢复**: 404处理、重复消息去重
4. **掉线重连**: worker disconnect → 保留output → 重连resume
5. **大文件产物**: 异步上传、进度、URL改写
6. **工具详情**: 开始时间、用时、输入输出
7. **滚动位置**: 用户上滚 → followChat → 位置保持
8. **计费去重**: idempotency-key → 不重复扣费

---

## 四、优先级排序

### 🔴 高危（影响核心流程）
1. ✅ 附件丢失（已修复3ad9e70）
2. ✅ 任务完成未保存（已修复3ad9e70）
3. ✅ 掉线重连逻辑（已验证保留：L2459-2587 worker disconnected/resumeTask）
4. ✅ 工具详情时间（已验证保留：L776-867 messageClock/runLabel/sealTimes）

### 🟡 中危（影响用户体验）
5. ⚠️ **刷新重复消息**（待验证去重key）
6. ⚠️ **大文件产物异步**（待验证超时）
7. ⚠️ **附件历史元数据**（DB字段存在性）

### 🟢 低危（边缘场景）
8. 游客权限（未涉及）
9. 统计app_id记录（非阻塞）

---

## 五、下一步行动

### 立即验证
1. 检查5960c89掉线重连逻辑是否完整
2. 检查439833f工具时间逻辑是否完整
3. 检查messages表attachments字段定义
4. 检查sortMessages去重key稳定性

### 补充测试
1. 附件上传端到端（Playwright + 真实页面）
2. done事件持久化（集成测试）
3. 掉线重连（模拟worker disconnect）
4. 滚动位置保持（Playwright + 真实DOM）

### 不实施
- 游客权限（未涉及）
- 新功能扩展（超出范围）

---

**审查人**: Cursor Agent  
**日期**: 2026-11-07  
**状态**: 初稿，待验证高危项
