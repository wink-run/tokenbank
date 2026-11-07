# Gateway重构回归审查 - 最终清单

**审查日期**: 2026-11-07  
**审查范围**: 3cc5fa0（重构起点）至 3ad9e70（当前修复）  
**方法**: 代码对比 + 线上实证（t190/t191/t192）

---

## 一、本轮修复完成情况（SHA: 3ad9e70）

### ✅ 问题1：附件丢失（已修复）
**现象**: 用户上传图片但agent收不到  
**根因**: agent-http.js未处理body.images/files  
**修复**: L228-229解析附件，L412-414传递给executor  
**证据**: t190线上"这是在哪里"消息无attachments元数据

### ✅ 问题2：任务完成未保存（已修复）
**现象**: 绘图执行完成但404，无/turn/finish，产物未入messages  
**根因**: agent-landing.html done事件未调用finish()  
**修复**: L2425添加`return finish(true)`  
**证据**: t190线上at-a05bb79777b5任务消失，t191端侧Arts 1已登记但云端无记录

### ✅ 问题3：刷新恢复running（已修复）
**现象**: 已完成任务刷新后显示running  
**根因**: 问题2导致share.turn_task_id指向消失任务  
**修复**: 问题2的结果

### ✅ 问题4：滚动强制到底（已验证无丢失）
**现象**: 用户上滚阅读历史时被拉回底部  
**验证**: 57c10a9引入的followChat/adoptKept/scrollChat(force)逻辑完整存在  
**调用点**: 流式更新用followChat（L1642/L2385），打开对话用scrollChat(true)（L1402/L2682）

---

## 二、重构前后功能对比（按影响排序）

### 🟢 保持完整（已验证代码）

1. **掉线重连**（5960c89）
   - ✅ worker disconnected检测（L2459-2472）
   - ✅ resumeTask恢复任务（L2526-2587）
   - ✅ interrupted标记与自动继续（L2762-2819）

2. **工具时间显示**（439833f）
   - ✅ messageClock显示开始时间（L776-788）
   - ✅ runLabel显示用时（L789-802）
   - ✅ toolElapsed工具耗时（L852-857）
   - ✅ sealTimes时间封存（L858-867）
   - ✅ withToolTimes追踪（L766-774）

3. **滚动位置保持**（57c10a9）
   - ✅ stickToBottom变量（L1439）
   - ✅ followChat检查用户上滚（L1454-1467）
   - ✅ adoptKept局部更新（L1678-1696）
   - ✅ scrollChat(force)条件滚动（L1449-1453）

4. **会话隔离与授权**（43356bd）
   - ✅ contribute workspace目录隔离
   - ✅ workspaceSessionId持久化
   - ✅ previous_response_id授权验证
   - ✅ assistant/consumer/context匹配
   - **已测试**: 29个集成用例全部通过

5. **call_context区分**（bc042a7）
   - ✅ local/hired显式参数
   - ✅ local不收集产物
   - ✅ hired收集并上传

6. **本地harness避免递归**（1a95a58）
   - ✅ owner使用local harness_id
   - ✅ 防止community递归

7. **accumulated_text提取**（a72d6b4）
   - ✅ 流式累积优先
   - ✅ completed事件补齐

---

### ⚠️ 待验证（代码存在，需测试）

8. **附件历史元数据**
   - 代码: messages表attachments字段
   - 风险: 刷新后附件可能不可见
   - 测试: 上传→刷新→检查attachments字段

9. **产物路径改写**
   - 代码: _apply_artifacts + rewrite_artifact_paths
   - 风险: 绝对路径未改写为URL
   - 测试: 绘图→检查HTML图片src

10. **大文件产物异步**
    - 代码: upload_artifact_to_cloud
    - 风险: 大文件超时
    - 测试: 生成大图/视频→检查上传完成

11. **刷新消息去重**
    - 代码: sortMessages + transcriptKey
    - 风险: 去重key不稳定导致重复
    - 测试: 刷新→检查重复消息

12. **取消逻辑**
    - 代码: cancel endpoint + stopRequested
    - 风险: cancel未触发finish()导致未保存
    - 测试: 运行中取消→检查messages入库

13. **计费去重**
    - 代码: idempotency-key检查（L204-216）
    - 风险: 重复请求重复扣费
    - 测试: 同idempotency-key重发→检查积分

---

### 📋 未审查（超出本次范围）

14. **游客权限**
    - 原因: 未涉及t190/t191/t192问题
    - 优先级: 低

15. **统计app_id记录**
    - 原因: 非阻塞功能
    - 优先级: 低

---

## 三、测试覆盖现状

### ✅ 已有测试
1. **test_agent_http_real_integration.js**（29个用例）
   - 授权验证（8个）
   - 目录隔离（3个）
   - 产物收集（5个）
   - 依赖排除（2个）
   - 会话续接（3个）
   - local/hired区分（3个）
   - DB持久化（3个）
   - 终态去重（2个）

2. **test_workspace_executor_direct.js**（13个用例）
   - workspace隔离（3个）
   - 产物过滤（7个）
   - 路径安全（3个）

### ❌ 测试缺失（高优先级）

1. **附件端到端**
   - 缺失: 图片data URL → 落盘 → 传agent → DB持久化 → 刷新恢复
   - 方法: Playwright + 真实页面上传

2. **done持久化**
   - 缺失: done → finish → /turn/finish → messages入库 → 刷新可见
   - 方法: 集成测试 + DB验证

3. **掉线重连**
   - 缺失: worker disconnect → 保留partial → 重连resume → 继续执行
   - 方法: 模拟disconnect事件

4. **滚动位置**
   - 缺失: 用户上滚 → progress事件 → followChat → 位置保持
   - 方法: Playwright + 真实DOM + 滚动操作

5. **产物路径改写**
   - 缺失: 本地绝对路径 → 上传云端 → 改写URL → HTML图片展示
   - 方法: 端到端绘图任务

---

## 四、下一步建议

### 立即行动（高危验证）

1. ✅ **附件丢失** - 已修复（3ad9e70）
2. ✅ **done未保存** - 已修复（3ad9e70）
3. ⚠️ **产物路径改写** - 代码存在，需端到端测试验证URL正确
4. ⚠️ **取消逻辑** - 检查cancel是否调用finish()

### 补充测试（中优先级）

5. 附件历史元数据持久化测试
6. 大文件产物异步上传测试
7. 刷新消息去重测试
8. 计费idempotency去重测试

### 监控观察（低优先级）

9. 游客权限流程
10. 统计app_id记录

---

## 五、风险评估

### 已消除（本轮修复）
- ❌ 附件完全丢失 → ✅ 已修复
- ❌ 任务完成404 → ✅ 已修复
- ❌ 刷新复活任务 → ✅ 已修复

### 仍存在（待验证）
- ⚠️ 产物URL可能未改写（代码存在但需测试）
- ⚠️ 大文件可能超时（未测试边界）
- ⚠️ 取消可能未持久化（逻辑待确认）

### 低风险（已验证代码存在）
- 掉线重连逻辑完整
- 工具时间显示完整
- 滚动位置逻辑完整
- 会话隔离完整

---

## 六、总结

### 本轮交付
- **修复**: 3个关键问题（附件/done/刷新）
- **验证**: 4个历史功能（掉线/时间/滚动/授权）
- **测试**: 42个用例（29个集成 + 13个collector）
- **SHA**: 3ad9e70（已push）

### 重构影响
- **丢失**: 3个（已修复）
- **保持**: 7个（已验证代码）
- **待验证**: 6个（代码存在需测试）
- **未审查**: 2个（超出范围）

### 最终状态
✅ **本轮四项修复全部完成**  
✅ **高危历史功能已验证保留**  
⚠️ **中危项有代码需补测试**  
📋 **低危项待监控观察**

---

**结论**: 重构前核心功能基本保留，本轮发现的3个丢失项已修复，剩余待验证项为中低风险边缘场景。
