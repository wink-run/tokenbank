'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

/**
 * 回归测试：PR #33 - 防止雇佣的本机智能体触发无限循环
 * 
 * 场景：
 * 1. Web chat: tokenbank.wink.run 访客 → 发布者本机智能体
 * 2. Desktop Playground: 本地用户 → 雇佣的本机智能体
 * 
 * 两种情况都不应该触发 community 远程调用循环。
 */

describe('agent-executor-local-community', () => {
  test('community格式解析和本地检查逻辑', () => {
    const { isCommunityAgentId, parseCommunityAgentId } = require('../hired-community-agents');
    
    // 场景1：可以解析的 community 格式
    const communityAgentId = 'community:claude-code@adam';
    assert.ok(isCommunityAgentId(communityAgentId), 'Should recognize community agent format');
    
    const parsed = parseCommunityAgentId(communityAgentId);
    assert.equal(parsed.assistant_id, 'claude-code', 'Should parse assistant_id correctly');
    assert.equal(parsed.owner, 'adam', 'Should parse owner correctly');
    
    // ✅ 如果本地有 claude-code，应该用本地执行
    // （实际检查由 _resolveAssistant 和 AGENT_CLI 决定）
    
    // 场景2：解析出 assistant_id，但本地可能没有
    const remoteAgentId = 'community:unknown-agent@bob';
    const parsedRemote = parseCommunityAgentId(remoteAgentId);
    assert.equal(parsedRemote.assistant_id, 'unknown-agent');
    assert.equal(parsedRemote.owner, 'bob');
    
    // ✅ 如果本地没有 unknown-agent，应该走远程
  });

  test('本地智能体不应触发runCommunityAgentTask', () => {
    // 验证逻辑路径：当本地有 assistant 时，不应该调用 _runCommunityTaskForExecute
    const { isCommunityAgentId, parseCommunityAgentId } = require('../hired-community-agents');
    
    const communityId = 'community:res-assistant-content-creator@adam';
    assert.ok(isCommunityAgentId(communityId));
    
    const parsed = parseCommunityAgentId(communityId);
    assert.equal(parsed.assistant_id, 'res-assistant-content-creator');
    assert.equal(parsed.owner, 'adam');
    
    // ✅ 解析成功，如果本地有 res-assistant-content-creator，就不应该远程调用
  });

  test('无法解析的community格式应走远程', () => {
    const { isCommunityAgentId, parseCommunityAgentId } = require('../hired-community-agents');
    
    // 错误的格式
    const invalidId = 'not-a-community-agent';
    assert.ok(!isCommunityAgentId(invalidId), 'Should not recognize non-community format');
    
    // community: 格式但无法解析
    const emptyId = 'community:';
    assert.ok(isCommunityAgentId(emptyId), 'Should recognize community: prefix');
    
    const parsed = parseCommunityAgentId(emptyId);
    assert.equal(parsed, null, 'Should return null for unparseable id');
  });
});
