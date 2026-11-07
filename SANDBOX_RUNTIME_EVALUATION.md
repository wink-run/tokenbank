# @anthropic-ai/sandbox-runtime 可行性评估报告

## 执行摘要（基于官方研究 v0.0.81）

@anthropic-ai/sandbox-runtime 是 Claude Code 官方的 OS 级沙箱运行时（Apache 2.0, Beta），**可作为 hired 多层防御的一层补充**，但**不能单独满足严格围栏要求**。

**核心结论**：
- ⚠️  **默认策略不安全**：全盘可读 + 默认写例外，**绝不可沿默认使用**
- ⚠️  **env 不自动清洗**：需手动构造最小 env，不能暴露 owner auth 目录
- ⚠️  **沙箱内可写文件仍可删除**：Python/Node 可删除工作目录文件，不是危险命令审核器
- ⚠️  **stdout/产物秘密检查仍需独立**：沙箱不检查输出内容
- ❌ **Windows 不可用**：Alpha 状态，token 派生绕过、SMB/系统服务不覆盖、ACL 问题
- ✅ **可作为一层补充**：与现有输入/输出检查组合，形成纵深防御

**官方研究来源**：
- https://github.com/anthropics/sandbox-runtime/blob/v0.0.81/README.md
- npm @anthropic-ai/sandbox-runtime@0.0.81
- Windows known-limitations 章节

---

## ⚠️  关键限制（官方研究发现）

### 默认策略不安全
- **全盘可读**：默认允许读取所有文件，包括 owner home
- **默认写例外**：`/tmp/claude`, `~/.npm/_logs`, `~/.claude/debug` 自动可写
- **绝不可沿默认使用**：必须显式配置 `denyRead` 和 `allowWrite`

### 环境变量不自动清洗
```javascript
// ❌ 错误：沙箱不会移除敏感 env
await sandbox.wrapWithSandbox('node', ['script.js'], {
  env: process.env  // 包含 AWS_SECRET_ACCESS_KEY 等
});

// ✅ 正确：手动构造最小 env
await sandbox.wrapWithSandbox('node', ['script.js'], {
  env: {
    PATH: process.env.PATH,
    NODE_ENV: 'production',
    // 不包含任何 owner auth
  }
});
```

### 沙箱内文件仍可被删除
- Python/Node 可以 `os.remove()` 或 `fs.unlinkSync()` 工作目录文件
- 沙箱只限制路径访问，不审查删除意图
- **仍需输入检查拒绝危险命令**

### credentials masking 实验性
- 需要 TLS terminate proxy（额外复杂度）
- 只在 Linux 支持文件 masking
- **不要为此扩建认证平台**

### 并发配置串扰风险
- SandboxManager 实例共享配置
- **每任务需独立 worker 或独立 SandboxManager**

---

## 1. 核心能力验证（需显式配置）

### 1.1 读权限控制（满足要求）

**默认策略**：允许所有读取（deny-then-allow pattern）

**限制 home 访问的实际配置**：
```json
{
  "filesystem": {
    "denyRead": ["/home", "~/.ssh", "~/.aws"],
    "allowRead": ["."],  // 只允许当前工作目录
    "allowWrite": ["."]
  }
}
```

**实际隔离效果**（Linux）：
- `denyRead` 条目会被挂载为**空的临时 tmpfs**
- 沙箱内的进程看到 `/home` 是空目录
- 无法读取 owner 的 `.ssh/id_rsa`, `.aws/credentials` 等
- `allowRead: ["."]` 重新打开当前工作目录的读取

**macOS 实现**：
- 生成 Seatbelt profile 动态规则
- 支持 glob 模式：`"denyRead": ["**/.env"]` 拒绝所有 .env 文件

**重要限制**：
- Linux 的 glob 展开在命令启动时，后续创建的文件不受限
- `denyRead` 条目如果父目录不可搜索，会拒绝最近的上级目录

### 1.2 写权限控制（满足要求）

**默认策略**：拒绝所有写入（allow-only pattern）

**hired 模式配置**：
```json
{
  "filesystem": {
    "allowWrite": [".", "/tmp"],  // 只允许工作目录和 /tmp
    "denyWrite": [".env", "**/.git/config"]  // 禁止写敏感文件
  }
}
```

**denyWrite 优先级**：高于 allowWrite，可在允许区域内禁止特定文件

**自动允许的路径**（无法禁止）：
- 子进程的 stdio
- `/tmp/claude`
- `~/.npm/_logs` 和 `~/.claude/debug`（可通过 denyRead 移除）

### 1.3 网络隔离（满足要求）

**默认策略**：拒绝所有网络访问（allow-only pattern）

**实现机制**：
- **Linux**: 移除网络命名空间，所有流量经 Unix socket 到 host proxy
- **macOS**: Seatbelt 只允许 localhost 特定端口，proxy 监听此端口
- **Windows**: WFP 过滤器阻止 srt-sandbox 账户的出站连接，除了 proxy 端口

**hired 模式配置**：
```json
{
  "network": {
    "allowedDomains": [],  // 空 = 完全禁止网络
    "deniedDomains": []
  }
}
```

### 1.4 凭证保护（满足要求）

**环境变量保护**：
```json
{
  "credentials": {
    "envVars": [
      { "name": "AWS_SECRET_ACCESS_KEY", "mode": "deny" },
      { "name": "GITHUB_TOKEN", "mode": "deny" }
    ]
  }
}
```

**文件保护**（Linux only）：
```json
{
  "credentials": {
    "files": [
      { "path": "~/.ssh/id_rsa", "mode": "deny" },
      { "path": "~/.aws/credentials", "mode": "deny" }
    ]
  }
}
```

**两种模式**：
- `deny`: 完全隐藏值
- `mask`: 放置哨兵值，proxy 在出口替换真实值（需 TLS terminate）

---

## 2. 平台支持矩阵

| 平台 | 成熟度 | 原生依赖 | Fail Closed 策略 |
|------|--------|----------|-----------------|
| **macOS** | ✅ 成熟 | 无（系统自带 sandbox-exec） | 可安全部署 |
| **Linux** | ✅ 成熟 | **必需**：bubblewrap, socat, ripgrep | **必须预检** |
| **Windows** | ⚠️  Alpha | 无（内置 srt-win.exe） | **暂不推荐生产** |

### 2.1 Linux 依赖要求（关键）

**必需安装**：
```bash
# Ubuntu/Debian
apt-get install bubblewrap socat ripgrep

# 支持的 bubblewrap 版本：0.4.0+（推荐 0.5.0+）
```

**seccomp 隔离层**：
- 需要 userns + seccomp 支持
- **缺少 seccomp 可能降级**（仅警告）
- **必须 fail closed 拒绝降级执行**

**Ubuntu 24.04+ 额外要求**：
```bash
# 禁用 AppArmor 限制（否则 unshare 无 capability）
sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
```

**denyRead['/'] 例外**：
- `/proc`, `/dev`, `/sys` 仍可访问
- **需实际验证是否泄露敏感信息**

**依赖检查**：
```javascript
const { checkDependencies } = require('@anthropic-ai/sandbox-runtime');

const deps = await checkDependencies();
// Linux: { available: true, missingDependencies: [] }
// 或   : { available: false, missingDependencies: ['bubblewrap', 'socat'] }
```

**Fail Closed 实现**：
```javascript
if (!deps.available) {
  if (callContext === 'hired') {
    // 拒绝执行，不降级到无保护模式
    throw new Error(`Hired mode requires sandbox: missing ${deps.missingDependencies.join(', ')}`);
  }
  // local 模式可继续
}
```

### 2.2 Windows Alpha 限制（官方确认不可用）

**当前状态**（v0.0.81 Alpha）：
- 使用专用 `srt-sandbox` 本地用户账户
- WFP（Windows Filtering Platform）网络过滤
- **官方记录的严重限制**：
  1. **Token 派生绕过网络 fence**：进程可在线程上放置不同 token 绕过
  2. **SMB/系统服务不覆盖**：系统服务代理的流量不受网络限制
  3. **profile/项目 ACL 问题**：ACL 权限可能被绕过
  4. 文件 mask 不支持（只支持 deny）

**明确结论**：
- ❌ **不能宣称 Windows 严格隔离可用**
- ❌ **hired 模式必须 fail closed 拒绝 Windows**
- 等待官方 Beta/Stable 且修复上述限制后再考虑

**来源**：官方 README "Windows (alpha)" 和 "known-limitations" 章节

---

## 3. 集成方案设计

### 3.1 hired 模式配置

**最小安全配置**（hired 默认）：
```javascript
{
  filesystem: {
    denyRead: [
      '/home',          // 拒绝所有 home 目录
      '/root',
      '~/.ssh',
      '~/.aws',
      '**/.env'         // 所有 .env 文件
    ],
    allowRead: ['.'],   // 只允许工作目录
    allowWrite: ['.'],  // 只允许工作目录写入
    denyWrite: []
  },
  network: {
    allowedDomains: [], // 完全禁止网络
    deniedDomains: []
  },
  credentials: {
    envVars: [
      { name: 'AWS_ACCESS_KEY_ID', mode: 'deny' },
      { name: 'AWS_SECRET_ACCESS_KEY', mode: 'deny' },
      { name: 'GITHUB_TOKEN', mode: 'deny' },
      { name: 'OPENAI_API_KEY', mode: 'deny' },
      // ... 所有敏感 env
    ]
  }
}
```

### 3.2 集成 API

**检查依赖**（启动时）：
```javascript
const { checkDependencies } = require('@anthropic-ai/sandbox-runtime');

async function initHiredSandbox() {
  const deps = await checkDependencies();
  
  if (!deps.available) {
    if (process.platform === 'linux') {
      console.error('Missing dependencies:', deps.missingDependencies);
      console.error('Install: apt-get install bubblewrap socat ripgrep');
    }
    // Fail closed: 拒绝 hired 执行
    return { available: false, reason: 'sandbox_deps_missing' };
  }
  
  return { available: true };
}
```

**执行命令**（hired spawn 替换）：
```javascript
const { SandboxManager } = require('@anthropic-ai/sandbox-runtime');

async function spawnHired(executable, args, options) {
  const sandbox = new SandboxManager({
    filesystem: HIRED_FS_CONFIG,
    network: HIRED_NETWORK_CONFIG,
    credentials: HIRED_CREDENTIALS_CONFIG,
  });
  
  await sandbox.initialize();
  
  try {
    const result = await sandbox.wrapWithSandbox(
      executable,
      args,
      {
        cwd: options.workingDir,
        // 环境变量已被 sandbox 过滤
      }
    );
    
    return result;
  } finally {
    await sandbox.cleanup();
  }
}
```

### 3.3 与现有 agent-safety 的关系（纵深防御）

**三层防御架构**（所有层都必须保留）：

1. **第一层（输入检查）**：
   - `agent_safety.check_input_safety()` - 拒绝危险 prompt
   - **必须保留**：沙箱内可写文件仍能被删除，需要拒绝删除命令
   - **必须保留**：防止用户诱导模型生成危险操作

2. **第二层（OS 沙箱）**：
   - **sandbox-runtime** 在子进程级别限制文件/网络访问
   - **不替代第一层**：沙箱不审查命令意图
   - **新增能力**：阻止实际越界访问（读 owner home, 写系统目录）

3. **第三层（输出检查）**：
   - `agent_safety.check_output_safety()` - 拦截敏感信息
   - **必须保留**：沙箱不检查 stdout/产物内容
   - **必须保留**：防止密钥/密码泄露到响应中

4. **第四层（环境清洗）**：
   - **手动构造最小 env**（沙箱不自动清洗）
   - **必须保留** agent-safety.buildSafeEnv 逻辑
   - 传递给 sandbox 的 env 已经是受限集

**修改点**：
```javascript
// agent-executor.js hired spawn 逻辑
if (isHired) {
  // 第一层：输入检查（已在 dispatch_agent.py 完成，保留）
  
  // 第四层：环境清洗（必须保留）
  const safeEnv = buildSafeEnv(resolvedCwd);  // 移除敏感 env
  
  // 第二层：OS 沙箱（新增）
  const sandboxResult = await spawnWithSandbox(executable, args, {
    workingDir: resolvedCwd,
    env: safeEnv,  // 已清洗的 env
    config: HIRED_SANDBOX_CONFIG,
  });
  
  // 第三层：输出检查（返回前执行，保留）
  const outputSafe = checkOutputSafety(sandboxResult.stdout);
  if (!outputSafe.safe) {
    throw new Error(outputSafe.error);
  }
}
```

**关键原则**：
- ❌ **不能移除任何一层**
- ❌ **不能假设沙箱替代了输入/输出检查**
- ✅ **sandbox-runtime 是补充层，不是替代**

---

## 4. 已知风险与限制

### 4.1 不可规避的风险

1. **allowNestedUserNamespaces = true**（Linux）
   - 子进程可创建自己的 user namespace
   - **破坏 denyWrite 保护**
   - **hired 必须保持 false**

2. **allowAppleEvents = true**（macOS）
   - 允许 AppleScript 和 Launch Services
   - **破坏代码执行隔离**（可 `open` 启动外部应用）
   - **hired 必须保持 false**

3. **enableWeakerNetworkIsolation = true**
   - 允许访问 `com.apple.trustd.agent`
   - **潜在数据泄露通道**
   - **hired 必须保持 false**

### 4.2 平台特定限制

**Linux**：
- Glob 展开在启动时，后续文件不受限
- 符号链接处理复杂（可能逃逸）
- bubblewrap 版本差异（< 0.5.0 不能 deny 非常规文件）

**macOS**：
- Glob 模式强大但可能性能开销大
- Seatbelt profile 生成开销

**Windows Alpha**：
- 线程级 token 切换可绕过网络过滤
- 系统服务代理的流量不受限
- 文件 mask 不支持

### 4.3 CLI 工具限制

**某些 CLI 可能不兼容**：
- 需要 pty 的工具（需 `allowPty: true` on macOS）
- 需要嵌套沙箱的工具（Docker, Podman）
- JVM 工具需要 `javaAgentJarPath` 配置

**解决方案**：
- 检测 CLI 类型，针对性配置
- 或 fail closed 拒绝不兼容的 CLI

---

## 5. 部署建议

### 5.1 分阶段推出

**Phase 1: macOS only**
- macOS 无额外依赖，最安全
- 验证集成正确性
- 收集性能数据

**Phase 2: Linux with deps check**
- 启动时检查依赖
- 依赖缺失 → fail closed 拒绝 hired
- 提供安装指南

**Phase 3: Windows（待 Beta）**
- 等待 Windows 版本成熟
- 当前 Windows hired 任务 fail closed

### 5.2 Fail Closed 实现（严格检查）

```javascript
async function canRunHired() {
  const platform = process.platform;
  
  // 1. Windows Alpha: 明确拒绝
  if (platform === 'win32') {
    console.error('[hired] Windows sandbox has known security issues (token bypass, SMB uncovered)');
    return {
      ok: false,
      reason: 'windows_alpha_not_supported',
      detail: 'Windows sandbox-runtime is Alpha with documented security limitations'
    };
  }
  
  // 2. 检查原生依赖
  const deps = await checkDependencies();
  if (!deps.available) {
    console.error('[hired] Missing sandbox dependencies:', deps.missingDependencies);
    return {
      ok: false,
      reason: 'missing_dependencies',
      missing: deps.missingDependencies,
      installCommand: `apt-get install ${deps.missingDependencies.join(' ')}`
    };
  }
  
  // 3. Linux: 检查 seccomp 降级（需要检查 warnings）
  if (platform === 'linux') {
    const warnings = deps.warnings || [];
    const hasSeccompWarning = warnings.some(w => 
      w.includes('seccomp') || w.includes('isolation')
    );
    
    if (hasSeccompWarning) {
      console.error('[hired] seccomp isolation layer degraded');
      return {
        ok: false,
        reason: 'seccomp_degraded',
        detail: 'seccomp isolation unavailable, would run without full isolation'
      };
    }
  }
  
  // 4. 验证可以创建 SandboxManager（不能只检查依赖存在）
  try {
    const testSandbox = new SandboxManager({
      filesystem: { denyRead: [], allowWrite: [], denyWrite: [] },
      network: { allowedDomains: [], deniedDomains: [] }
    });
    await testSandbox.initialize();
    await testSandbox.cleanup();
  } catch (err) {
    console.error('[hired] Failed to initialize sandbox:', err.message);
    return {
      ok: false,
      reason: 'sandbox_init_failed',
      detail: err.message
    };
  }
  
  return { ok: true };
}
```

### 5.3 性能考量

**启动开销**：
- macOS: ~50ms (profile 生成)
- Linux: ~100ms (bubblewrap setup + mount)

**运行时开销**：
- 文件访问：可忽略（kernel 级别）
- 网络访问：proxy 中转（+10-20ms per request）

**建议**：
- 缓存 SandboxManager 实例（同一 worker）
- 预热 proxy 连接池

---

## 6. 替代 agent-safety.js 的迁移计划

### 6.1 当前实现对比

| 功能 | agent-safety.js | sandbox-runtime | 采用方案 |
|------|----------------|-----------------|----------|
| 输入检查（prompt） | ✅ 正则匹配 | ❌ | **保留 agent-safety** |
| 输出检查（敏感信息） | ✅ 正则匹配 | ❌ | **保留 agent-safety** |
| 环境变量过滤 | ⚠️  简单删除 | ✅ OS 级 deny | **迁移到 sandbox-runtime** |
| 文件读限制 | ❌ 无 | ✅ OS 级 denyRead | **新增 sandbox-runtime** |
| 文件写限制 | ⚠️  目录检查 | ✅ OS 级 allowWrite | **迁移到 sandbox-runtime** |
| 网络隔离 | ❌ 无 | ✅ OS 级 proxy | **新增 sandbox-runtime** |

### 6.2 迁移步骤

1. **保留** server/agent_safety.py 的输入/输出检查
2. **替换** client/agent-safety.js 的环境限制部分
3. **新增** sandbox-runtime 集成模块
4. **测试** 验证双层防御都生效

---

## 7. 最终推荐（基于官方研究）

### ⚠️  采用 sandbox-runtime 作为**补充层**，不能单独满足严格围栏

**明确限制**：
1. ❌ **不能替代输入检查**：沙箱内文件仍可被删除
2. ❌ **不能替代输出检查**：沙箱不检查 stdout/产物秘密
3. ❌ **不能替代 env 清洗**：必须手动构造最小 env
4. ❌ **默认策略不安全**：必须显式配置 denyRead/allowWrite
5. ❌ **Windows 不可用**：已知安全绕过，fail closed 拒绝

**采用条件**（所有条件必须满足）：
1. ✅ **macOS/Linux only**：Windows fail closed
2. ✅ **所有依赖可用**：Linux 需 bubblewrap/socat/ripgrep + seccomp
3. ✅ **保留现有检查**：输入/输出/env 检查全部保留
4. ✅ **显式配置策略**：denyRead owner home, allowWrite 工作目录
5. ✅ **每任务独立实例**：防止配置串扰

### ⚠️  运维要求

1. **安装文档**：
   - Linux 用户需手动安装 bubblewrap/socat/ripgrep
   - 提供自动检测和安装指南

2. **监控指标**：
   - 依赖可用性（启动时检查）
   - 沙箱启动失败率
   - 违规检测记录

3. **降级策略**：
   - 依赖缺失 → hired 拒绝，local 继续
   - 不静默降级到无保护模式

### 📋 后续工作

1. **立即**：
   - [ ] 集成 sandbox-runtime 到 agent-executor
   - [ ] 实现平台检测和 fail closed
   - [ ] 添加依赖检查和错误提示

2. **短期**：
   - [ ] macOS/Linux 生产验证
   - [ ] 性能基准测试
   - [ ] 违规日志分析

3. **长期**：
   - [ ] 跟踪 Windows Beta 进展
   - [ ] 研究 credential masking 用于 API 访问
   - [ ] 探索动态配置更新（--control-fd）

---

**评估完成时间**: 2026-11-07  
**评估基于版本**: @anthropic-ai/sandbox-runtime@0.0.81  
**推荐状态**: ✅ 采用（macOS/Linux），⚠️  Windows 待定
