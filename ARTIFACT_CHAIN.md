# Artifact传输链路完整对照

## 当前链路（hired模式）

### 环节1: 收集 - collectWorkspaceArtifacts
**文件**: `client/electron/contribute-session.js:198-256`
**输出格式**:
```javascript
[{
  name: string,          // 文件名
  mime: string,          // MIME类型（SVG: 'image/svg+xml'）
  kind: string,          // 'image'或'file'（SVG被标记为'file'）
  dataUrl: string,       // "data:{mime};base64,{base64data}"
  localPath: string      // 本地绝对路径
}]
```
**触发条件**: agent-executor.js:1912 `if (collectArtifacts)`
**关键参数**: `taskStartTime = running?.started_at || (Date.now() - 300000)`

### 环节2: 存储 - executor.result
**文件**: `client/electron/agent-executor.js:1587`
**操作**: `JSON.stringify(result)` 存入SQLite
**result.artifacts**: 直接来自collectWorkspaceArtifacts返回值

### 环节3: HTTP响应 - agent-http taskToResponse  
**文件**: `client/electron/agent-http.js:119-121`
```javascript
if (task?.result?.artifacts) {
  response.artifacts = task.result.artifacts;
}
```
**字段名**: `artifacts` （保持不变）

### 环节4: Worker转发 - gateway_response
**文件**: `client/electron/agent-worker.js:931-942`
```javascript
parsedBody = JSON.parse(buffer);  // HTTP response body
send({
  type: 'gateway_response',
  body: parsedBody  // 包含artifacts字段
});
```
**字段名**: `artifacts` 在body中（保持不变）

### 环节5: Python接收 - gateway_over_websocket
**文件**: `server/gateway_over_websocket.py:93-99`
```python
response_body = msg.get("body", {})
return response_body  # 即gateway_response
```
**字段名**: `artifacts` （保持不变）

### 环节6: Python提取 - dispatch_agent
**文件**: `server/dispatch_agent.py:803-805, 1276-1278`
```python
raw_artifacts = gateway_response.get("artifacts")
if call_context == "hired":
    processed_output, public_arts = _apply_artifacts(task_id, output_text, raw_artifacts)
```
**字段名**: `artifacts` 作为raw参数传入_apply_artifacts

### 环节7: Python处理 - _apply_artifacts
**文件**: `server/dispatch_agent.py:69-74`
```python
def _apply_artifacts(task_id: str, output: str, raw) -> tuple[str, list]:
    stored = publish_agent_artifacts(task_id, raw)
    text = rewrite_artifact_paths(output, stored) if stored else output
    return redact_remaining_local_paths(text), public_artifacts(stored)
```

---

## 字段传输对照

| 环节 | 字段名 | 是否保持dataUrl |
|------|--------|----------------|
| collectWorkspaceArtifacts输出 | `dataUrl` | ✅ 生成base64 |
| executor.result存储 | `artifacts[].dataUrl` | ✅ 保持 |
| agent-http response | `artifacts[].dataUrl` | ✅ 保持 |
| worker gateway_response | `body.artifacts[].dataUrl` | ✅ JSON传输保持 |
| Python gateway_response | `artifacts[].dataUrl` | ✅ 保持 |
| _apply_artifacts参数raw | `[].dataUrl` | ✅ 传入 |

**结论**: dataUrl字段在整个链路中保持，无字段转换或丢失。

---

## 可能失败点（非代码缺陷）

### A. collectWorkspaceArtifacts未收集到文件
**原因**:
1. **时间窗口过滤**: 文件mtime < (taskStartTime - 2s) 被过滤
   - Line contribute-session.js:183
   - 如果running.started_at不准确，或文件创建早于任务开始
2. **正文匹配失败**: SVG路径格式不符合正则
   - bareRe (line 137): 需要边界字符（空白/引号/标点）
   - 如果正文是markdown图片`![](path)`或代码块，可能不匹配
3. **文件不在工作目录**: 如果SVG生成在临时目录或其他位置
4. **大小超限**: 单文件>32MB或总字符>64MB (line 65-67, 225-227)

### B. collectArtifacts未启用
**原因**: callContext !== 'hired'
- agent-http.js:328 `const collectArtifacts = callContext === 'hired'`
- Line 237 `callContext = body.call_context || ... || 'local'`
- 如果请求未设置call_context='hired'，不会收集

---

## 实测证据分析（share LdeFYHzPH0GM）

**任务**: at-414a43a808d5 (moon-lake.svg), at-dd11fb464b4f (moon-lake-poem.svg)
**现象**: 正文包含SVG文本，但assistant无artifacts
**/turn/finish**: 200成功，messages保存

**可能原因排查**:
1. ❌ **字段丢失**: 链路完整，无字段转换错误
2. ⚠️  **未收集**: collectWorkspaceArtifacts返回空数组
   - 需要日志确认：`[AgentExecutor] collected N artifacts`
   - 需要日志确认：`[collectWorkspaceArtifacts] mentioned=X, recent=Y, picked=Z`
3. ⚠️  **未启用**: collectArtifacts=false
   - 需要确认请求body.call_context值

---

## 下一步排查（需端侧日志）

**必要日志** (已添加):
```
[AgentExecutor] collected N artifacts for task {taskId}
[AgentExecutor] no artifacts collected for task {taskId}  
[collectWorkspaceArtifacts] mentioned=X, recent=Y, picked=Z, startedAt=T
```

**排查步骤**:
1. 查看worker console日志中的上述输出
2. 如果picked=0但recent>0: 文件被过滤（大小/格式/依赖管理文件）
3. 如果recent=0: 时间窗口问题或文件不在工作目录
4. 如果mentioned=0且正文确实包含SVG文件名: 正则匹配失败
5. 如果无任何日志: collectArtifacts=false或hired条件未满足

**无法通过代码静态分析确定的**:
- taskStartTime的实际值
- 文件的实际创建时间（mtime）
- 工作目录的实际路径
- 正文中SVG文件名的实际格式

---

## 确定性发现

1. ✅ **链路完整**: dataUrl字段从收集到Python端无丢失
2. ✅ **hired模式正确触发**: dispatch_agent默认call_context='hired'
3. ⚠️  **时间窗口依赖started_at**: fallback仅在started_at不存在时生效
4. ⚠️  **SVG文件收集依赖**: 正文匹配或时间窗口兜底

**非代码缺陷，需运行时证据**:
- collectWorkspaceArtifacts是否被调用
- 是否找到文件（mentioned/recent计数）
- 是否通过过滤（picked计数）

---

**生成时间**: 2026-11-07 04:43 UTC  
**最终main SHA**: 37280b6 (撤销无效fallback扩窗，保留必要日志)
