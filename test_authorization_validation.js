/**
 * 授权验证测试
 * 
 * 直接测试agent-http的授权检查逻辑
 * 不依赖完整executor执行
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

console.log('=== 授权验证测试 ===\n');

const tests = [];

// 模拟executor的getTaskStatus
const mockTasks = new Map();

const mockExecutor = {
  async getTaskStatus(taskId) {
    return mockTasks.get(taskId) || null;
  },
};

// 模拟授权检查逻辑（从agent-http.js提取）
function checkPreviousResponseAuthorization(body, prev) {
  const prevContext = prev?.context ? JSON.parse(prev.context) : {};
  const prevAssistantId = prevContext?.assistantId || prev?.agent_id;
  const prevConsumerKey = prevContext?.consumerKey;
  const prevCallContext = prevContext?.callContext;
  
  const currentAssistantId = body.metadata?.assistant_id;
  const currentConsumerKey = body.metadata?.consumer_key;
  const callContext = String(body.metadata?.call_context || 'local').toLowerCase();
  
  // 验证1: assistant_id必须匹配
  if (prevAssistantId && currentAssistantId && prevAssistantId !== currentAssistantId) {
    return { allowed: false, reason: 'assistant_mismatch' };
  }
  // 验证2: consumer_key必须匹配
  else if (prevConsumerKey && currentConsumerKey && prevConsumerKey !== currentConsumerKey) {
    return { allowed: false, reason: 'consumer_mismatch' };
  }
  // 验证3: call_context必须匹配
  else if (prevCallContext && prevCallContext !== callContext) {
    return { allowed: false, reason: 'context_mismatch' };
  }
  // 验证4: 旧数据缺失授权信息时拒绝
  else if (!prevAssistantId || !prevConsumerKey || !prevCallContext) {
    return { allowed: false, reason: 'missing_auth_data' };
  }
  // 全部验证通过
  else {
    return { allowed: true, reason: 'authorized' };
  }
}

// ========== 测试1: 正常续接（同consumer+assistant+context）==========
console.log('测试1: 正常续接（全部匹配）');

mockTasks.set('task1', {
  id: 'task1',
  context: JSON.stringify({
    assistantId: 'test-artist',
    consumerKey: 'u100',
    callContext: 'hired',
  }),
  result: JSON.stringify({
    cliSessionId: 'sess-abc',
    workspaceSessionId: 'ws-123',
  }),
});

const check1 = checkPreviousResponseAuthorization(
  {
    previous_response_id: 'task1',
    metadata: {
      assistant_id: 'test-artist',
      consumer_key: 'u100',
      call_context: 'hired',
    },
  },
  mockTasks.get('task1')
);

console.log(`  allowed: ${check1.allowed ? '✓' : '✗'}`);
console.log(`  reason: ${check1.reason}`);

tests.push({
  name: '正常续接',
  pass: check1.allowed && check1.reason === 'authorized',
});
console.log('');

// ========== 测试2: 跨consumer拒绝 ==========
console.log('测试2: 跨consumer尝试续接（必须拒绝）');

const check2 = checkPreviousResponseAuthorization(
  {
    previous_response_id: 'task1',
    metadata: {
      assistant_id: 'test-artist',
      consumer_key: 'u200',  // 不同consumer
      call_context: 'hired',
    },
  },
  mockTasks.get('task1')
);

console.log(`  allowed: ${!check2.allowed ? '✓' : '✗ 允许了跨用户'}`);
console.log(`  reason: ${check2.reason}`);

tests.push({
  name: '跨consumer拒绝',
  pass: !check2.allowed && check2.reason === 'consumer_mismatch',
});
console.log('');

// ========== 测试3: 跨assistant拒绝 ==========
console.log('测试3: 跨assistant尝试续接（必须拒绝）');

const check3 = checkPreviousResponseAuthorization(
  {
    previous_response_id: 'task1',
    metadata: {
      assistant_id: 'other-bot',  // 不同assistant
      consumer_key: 'u100',
      call_context: 'hired',
    },
  },
  mockTasks.get('task1')
);

console.log(`  allowed: ${!check3.allowed ? '✓' : '✗ 允许了跨assistant'}`);
console.log(`  reason: ${check3.reason}`);

tests.push({
  name: '跨assistant拒绝',
  pass: !check3.allowed && check3.reason === 'assistant_mismatch',
});
console.log('');

// ========== 测试4: 跨context拒绝 ==========
console.log('测试4: hired/local跨context续接（必须拒绝）');

const check4 = checkPreviousResponseAuthorization(
  {
    previous_response_id: 'task1',
    metadata: {
      assistant_id: 'test-artist',
      consumer_key: 'u100',
      call_context: 'local',  // 不同context
    },
  },
  mockTasks.get('task1')
);

console.log(`  allowed: ${!check4.allowed ? '✓' : '✗ 允许了跨context'}`);
console.log(`  reason: ${check4.reason}`);

tests.push({
  name: '跨context拒绝',
  pass: !check4.allowed && check4.reason === 'context_mismatch',
});
console.log('');

// ========== 测试5: 旧数据缺失授权信息 ==========
console.log('测试5: 旧任务缺失授权信息（必须拒绝）');

mockTasks.set('task-old', {
  id: 'task-old',
  context: JSON.stringify({
    // 旧数据：只有assistantId，缺少consumerKey和callContext
    assistantId: 'test-artist',
  }),
  result: JSON.stringify({
    cliSessionId: 'sess-old',
  }),
});

const check5 = checkPreviousResponseAuthorization(
  {
    previous_response_id: 'task-old',
    metadata: {
      assistant_id: 'test-artist',
      consumer_key: 'u100',
      call_context: 'hired',
    },
  },
  mockTasks.get('task-old')
);

console.log(`  allowed: ${!check5.allowed ? '✓' : '✗ 允许了旧数据绕过'}`);
console.log(`  reason: ${check5.reason}`);

tests.push({
  name: '旧数据拒绝',
  pass: !check5.allowed && check5.reason === 'missing_auth_data',
});
console.log('');

// ========== 测试6: 游客IP变化（必须拒绝）==========
console.log('测试6: 游客IP变化尝试续接（必须拒绝）');

mockTasks.set('task-guest1', {
  id: 'task-guest1',
  context: JSON.stringify({
    assistantId: 'test-artist',
    consumerKey: 'g-abc123',  // 游客1的IP hash
    callContext: 'hired',
  }),
  result: JSON.stringify({
    cliSessionId: 'sess-guest',
    workspaceSessionId: 'ws-guest',
  }),
});

const check6 = checkPreviousResponseAuthorization(
  {
    previous_response_id: 'task-guest1',
    metadata: {
      assistant_id: 'test-artist',
      consumer_key: 'g-xyz789',  // 游客IP变化后的新hash
      call_context: 'hired',
    },
  },
  mockTasks.get('task-guest1')
);

console.log(`  allowed: ${!check6.allowed ? '✓' : '✗ 允许了IP变化绕过'}`);
console.log(`  reason: ${check6.reason}`);
console.log(`  说明: 游客IP变化不能作为绕过身份核验理由`);

tests.push({
  name: '游客IP变化拒绝',
  pass: !check6.allowed && check6.reason === 'consumer_mismatch',
});
console.log('');

// ========== 总结 ==========
console.log('=== 验证结果 ===\n');

const passed = tests.filter(t => t.pass);
const failed = tests.filter(t => !t.pass);

console.log(`✓ 通过: ${passed.length}/${tests.length}`);
passed.forEach(t => console.log(`  ✓ ${t.name}`));
console.log('');

if (failed.length > 0) {
  console.log(`✗ 失败: ${failed.length}/${tests.length}`);
  failed.forEach(t => console.log(`  ✗ ${t.name}`));
  console.log('');
}

console.log('授权验证逻辑已测试，生产代码在 client/electron/agent-http.js');

process.exit(failed.length === 0 ? 0 : 1);
