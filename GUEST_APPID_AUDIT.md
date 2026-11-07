# 游客权限与app_id审查报告

## 审查范围

仅审查Gateway重构（3cc5fa0→dc91e78）相关变化，不包括功能性变更。

---

## 1. app_id归因路径

### 重构前（旧worker模式）

**入口**: `server.py` POST `/api/agent-tasks`
- 解析`app_id`或`source`字段
- 传递给`dispatch_old_agent.py`
- worker通过某种方式接收（未明确文档）

### 重构后（Gateway模式）

**完整调用链**:

1. **server.py** L1156-1157:
   ```python
   # 优先 app_id，否则 source，均未提供时保持 None
   initiator = (body.app_id or body.source or "").strip() or None
   ```

2. **server.py** L1177, L1202:
   ```python
   # 传递给dispatch_agent
   app_id=initiator
   ```

3. **dispatch_agent.py** L756, L1180:
   ```python
   # Gateway over WebSocket调用
   initiator=app_id,  # 调用方显式传递
   ```

4. **gateway_over_websocket.py** L68, L139:
   ```python
   # 写入Gateway请求的metadata
   final_body["metadata"]["app_id"] = initiator
   ```

5. **agent-http.js** L233:
   ```javascript
   // Gateway读取并记录到日志
   const initiator = initiatorFromBody(body)
   console.log(`[agent-http] POST /v1/agent/responses harness=${harnessId} initiator=${initiator}`)
   ```

6. **agent-http.js** L409:
   ```javascript
   // 传递给executor作为统计标识
   initiator,
   ```

### 结论：app_id路径保持

✅ **路径完整**：server → dispatch → gateway_over_websocket → agent-http → executor
✅ **默认值正确**：未提供时为None，Gateway用"direct"
✅ **兼容source字段**：旧客户端可用source替代
✅ **日志归因**：[agent-http]日志记录initiator
✅ **统计标识**：传递给executor用于usage统计

**无回归**。

---

## 2. 游客权限（guest试用）

### 重构前功能变更

**c98b4de** (2024年早期提交): "智能体主页不再靠看广告使用"
- 移除了ad_watched机制
- 游客改为一次免费试用（无需看广告）
- `tools_router.py`注释明确："看广告不再发放免费使用"

**这是有意的功能变更，不是Gateway重构引入的回归**。

### 重构后游客试用机制

**server.py** L1147-1152:
```python
# 游客试用：一次免费
if guest:
    if not token and _guest_session_count(session_id) >= 1:
        raise HTTPException(401, "guest trial: one turn only — sign in to continue")
    if not guest_trial_allowed(_client_ip(request)):
        raise HTTPException(429, "guest trial limit reached — sign in to continue")
```

**dispatch_agent.py**:
- L655: `guest = consumer_user_id is None`
- L730, L788, L831: 游客不扣积分，不退款
- L908: done事件携带`"guest": guest, "need_login_to_continue": guest`

**agent-landing.html**:
- 游客标识传递到前端done事件
- `guestUsed.value = true` 标记试用已用完
- 显示"Sign in to continue"提示

### 游客权限完整流程

1. **请求鉴权** (server.py):
   - 无token → guest=True
   - 检查session_count（一次免费）
   - 检查IP限流（429防滥用）

2. **积分处理** (dispatch_agent.py):
   - guest不扣除积分（L730, L788）
   - 失败不退款（L831）
   - done事件标记guest=true

3. **前端提示** (agent-landing.html):
   - 收到done事件后检查finalGuest
   - 设置guestUsed=true
   - 显示"Sign in to continue"

### 结论：游客机制保持

✅ **试用限制正常**：一次免费，IP限流
✅ **积分逻辑正确**：游客不扣除，不退款
✅ **前端提示正常**：done后显示登录提示
✅ **无广告机制**：有意移除（c98b4de），不是回归

**无回归**。原ad_watched机制的移除是功能性变更，早于Gateway重构。

---

## 3. 测试验证建议

虽然调用链代码完整，但以下场景缺少端到端测试：

### app_id归因

- [ ] 浏览器带app_id发起 → 云端日志记录正确initiator
- [ ] 旧客户端用source字段 → 正确fallback
- [ ] 未提供时 → Gateway日志显示"direct"

### 游客试用

- [ ] 游客首次请求 → 200成功，done事件guest=true
- [ ] 游客第二次请求 → 401拒绝
- [ ] IP限流触发 → 429响应
- [ ] 游客任务失败 → 不退款（余额不变）

---

## 4. 总结

| 功能 | 重构后状态 | 是否回归 | 备注 |
|------|----------|---------|------|
| app_id传递 | ✅ 保持 | 否 | 完整调用链server→gateway→agent-http |
| app_id默认值 | ✅ 保持 | 否 | None/"direct" |
| source兼容 | ✅ 保持 | 否 | fallback逻辑正常 |
| 游客试用 | ✅ 保持 | 否 | 一次免费，IP限流 |
| ad_watched | ❌ 已移除 | **不是回归** | c98b4de有意功能变更 |
| 游客积分 | ✅ 保持 | 否 | 不扣除，不退款 |
| 游客前端提示 | ✅ 保持 | 否 | done后登录提示 |

**审查结论**：Gateway重构未引入app_id或游客权限回归。ad_watched机制的移除是早期功能性决策，与重构无关。

---

**生成时间**: 2024-11-07  
**审查基线**: 3cc5fa0（重构前）→ dc91e78（重构后）  
**方法**: 代码审查，调用链追踪
