// client/electron/resource-projector.js
// Skill 投射：以用户安装目录为权威源，其他 Agent 建目录软链
'use strict';

const fs = require('fs');
const path = require('path');
const { getAgentTarget } = require('./resource-agent-targets');
const {
  resolveAuthorityDir,
  materializeSkillDir,
  copyDirRecursive,
  normalizeSkillDirPath,
  resolvePath,
  pathExists,
  pathsEqual,
  isRealSkillDir,
  realSkillDir,
} = require('./resource-canonical');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function isSymlinkTo(targetPath, authorityDir) {
  try {
    const st = fs.lstatSync(targetPath);
    // Windows junction 在 lstat 上也表现为 symlink
    if (!st.isSymbolicLink()) return false;
    return pathsEqual(fs.realpathSync(targetPath), fs.realpathSync(authorityDir));
  } catch {
    return false;
  }
}

function removePathSafe(p) {
  if (!pathExists(p)) return;
  const st = fs.lstatSync(p);
  if (st.isSymbolicLink()) {
    fs.unlinkSync(p);
    return;
  }
  if (st.isDirectory()) {
    fs.rmSync(p, { recursive: true, force: true });
    return;
  }
  fs.unlinkSync(p);
}

/**
 * 在 targetDir 创建指向 authorityDir 的目录软链
 * @returns {'symlink'|'copy'} 实际使用的方式
 */
function replaceWithSymlink(targetDir, authorityDir) {
  ensureDir(path.dirname(targetDir));

  if (pathExists(targetDir)) {
    if (isSymlinkTo(targetDir, authorityDir)) return 'symlink';
    removePathSafe(targetDir);
  }

  try {
    // Windows：优先 junction（无需管理员）；失败再试 dir symlink，最后回退复制
    if (process.platform === 'win32') {
      try {
        fs.symlinkSync(resolvePath(authorityDir), targetDir, 'junction');
        return 'symlink';
      } catch (junctionErr) {
        fs.symlinkSync(resolvePath(authorityDir), targetDir, 'dir');
        return 'symlink';
      }
    }
    fs.symlinkSync(resolvePath(authorityDir), targetDir, 'dir');
    return 'symlink';
  } catch (e) {
    console.warn('[resource-projector] dir symlink failed, fallback to copy:', e.message);
    copyDirRecursive(authorityDir, targetDir);
    return 'copy';
  }
}

/** 该 Agent 上是否保留用户自装的实体目录（权威源，不替换为软链） */
function shouldKeepAsAuthority(resource, agentId, skillDir, existingProjection) {
  const skillDirResolved = resolvePath(skillDir);
  const authorityDir = resolveAuthorityDir(resource);

  if (authorityDir && pathsEqual(skillDirResolved, authorityDir)) return true;

  if (existingProjection?.projectionType === 'scan' || existingProjection?.projectionType === 'origin') {
    const projDir = normalizeSkillDirPath(existingProjection.targetPath, resource.name);
    if (projDir && pathsEqual(projDir, skillDirResolved) && pathExists(skillDir) && !fs.lstatSync(skillDir).isSymbolicLink()) {
      return true;
    }
  }

  const scannedFrom = resource.metadata?.scannedFrom || resource.metadata?.authorityPath;
  if (scannedFrom) {
    const scannedDir = normalizeSkillDirPath(scannedFrom, resource.name);
    if (scannedDir && resolvePath(scannedDir) === skillDirResolved && pathExists(skillDir) && !fs.lstatSync(skillDir).isSymbolicLink()) {
      return true;
    }
  }

  const originAgents = resource.metadata?.originAgents || [];
  if (originAgents.includes(agentId) && pathExists(skillDir) && !fs.lstatSync(skillDir).isSymbolicLink()) {
    return true;
  }
  return false;
}

/**
 * 目标位置是否已有一个「与本资产无关的真实目录」。
 * 存在、非软链、且不是本资产的权威目录 → 属于冲突：直接覆盖会删掉用户已有的同名 Skill。
 */
function isForeignRealDir(skillDir, authorityDir) {
  if (!pathExists(skillDir)) return false;
  try {
    if (fs.lstatSync(skillDir).isSymbolicLink()) return false;
  } catch {
    return false;
  }
  if (authorityDir && resolvePath(skillDir) === resolvePath(authorityDir)) return false;
  return true;
}

/**
 * Skill 投射：权威目录在用户安装位置；其他 Agent 软链指向该目录
 */
function projectSkillToAgent(resource, agentId, scope = 'global', options = {}) {
  const target = getAgentTarget(agentId);
  if (!target) throw new Error(`不支持的 Agent: ${agentId}`);

  const skillRoot = target.getSkillRoot();
  ensureDir(skillRoot);

  const skillDir = path.join(skillRoot, resource.name);
  const skillMdPath = path.join(skillDir, 'SKILL.md');
  let authorityDir = resolveAuthorityDir(resource);

  if (shouldKeepAsAuthority(resource, agentId, skillDir, options.existingProjection)) {
    if (!authorityDir && pathExists(skillDir) && !fs.lstatSync(skillDir).isSymbolicLink()) {
      authorityDir = resolvePath(skillDir);
    }
    return {
      agentId,
      scope,
      targetPath: skillDir,
      skillMdPath,
      authorityPath: authorityDir,
      projectionType: 'scan',
      status: 'active',
    };
  }

  // 冲突保护：目标位置已有一个无关的真实同名目录（用户自装的另一个 Skill）。
  // 直接软链/物化会先删掉它，造成数据丢失——除非调用方显式 force，否则拒绝并回报冲突。
  if (isForeignRealDir(skillDir, authorityDir) && !options.force) {
    return {
      agentId,
      scope,
      targetPath: skillDir,
      skillMdPath,
      authorityPath: authorityDir,
      projectionType: 'conflict',
      status: 'conflict',
      conflict: true,
      conflictPath: skillDir,
    };
  }

  // 目录市场纳管、尚无本机副本：在首个目标 Agent 写入实体目录作为权威源
  if (!authorityDir) {
    authorityDir = materializeSkillDir(skillDir, resource.content, resource.metadata?.files || null);
    return {
      agentId,
      scope,
      targetPath: skillDir,
      skillMdPath,
      authorityPath: authorityDir,
      projectionType: 'origin',
      status: 'active',
    };
  }

  const mode = replaceWithSymlink(skillDir, authorityDir);
  return {
    agentId,
    scope,
    targetPath: skillDir,
    skillMdPath,
    authorityPath: authorityDir,
    projectionType: mode === 'symlink' ? 'symlink' : 'copy',
    status: 'active',
  };
}

/** 取消投射：删除软链/副本/非权威实体目录；权威目录本身不删（卸载时才删） */
function unprojectSkillFromAgent(resource, agentId, projectionType = 'symlink', targetPathHint) {
  if (projectionType === 'reference') {
    return { removed: false, skipped: true };
  }

  const authorityDir = resolveAuthorityDir(resource)
    || normalizeSkillDirPath(
      resource?.metadata?.authorityPath || resource?.metadata?.scannedFrom || resource?.authorityPath,
      resource?.name,
    );

  let skillDir = normalizeSkillDirPath(targetPathHint, resource?.name);
  if (!skillDir) {
    const target = getAgentTarget(agentId);
    if (!target) return { removed: false };
    skillDir = path.join(target.getSkillRoot(), resource.name);
  }

  const abs = resolvePath(skillDir);
  // 权威源实体目录不删；但软链即使指向权威也必须摘掉（否则取消投射后标签会因磁盘残留被扫回）
  let isLink = false;
  try { isLink = fs.lstatSync(abs).isSymbolicLink(); } catch { /* missing */ }
  if (authorityDir && abs === resolvePath(authorityDir) && !isLink) {
    return { removed: false, skipped: true, reason: 'authority', path: abs };
  }

  if (!pathExists(abs)) {
    // target_path 可能过期：再试 Agent 默认 skills/<name>
    const target = getAgentTarget(agentId);
    if (target && resource?.name) {
      const fallback = path.join(target.getSkillRoot(), resource.name);
      if (fallback !== abs && pathExists(fallback)) {
        return unprojectSkillFromAgent(resource, agentId, projectionType, fallback);
      }
    }
    return { removed: false, path: abs };
  }

  try {
    const st = fs.lstatSync(abs);
    if (st.isSymbolicLink()) {
      fs.unlinkSync(abs);
    } else {
      // 副本，或其它 Agent 上的多余实体（含 scan/origin）→ 删除目录
      fs.rmSync(abs, { recursive: true, force: true });
    }
  } catch (e) {
    throw new Error(`取消投射失败: ${e.message}`);
  }

  return { removed: true, path: abs };
}

/**
 * 校验单条投射当前是否仍然健康（软链是否还在/是否仍指向权威/权威是否还存在）。
 * @returns {{ healthy: boolean, reason: string, repairable: boolean }}
 */
function verifyProjection(resource, agentId, projectionType, targetPath) {
  if (projectionType === 'reference') {
    return { healthy: true, reason: 'reference', repairable: false };
  }
  // 提示词:投射即 DB 标记(经 MCP 暴露),行存在即健康
  if (projectionType === 'mcp' || resource?.type === 'prompt') {
    return { healthy: true, reason: 'mcp', repairable: false };
  }
  if (!resource || resource.type !== 'skill') {
    return { healthy: true, reason: 'reference', repairable: false };
  }
  const skillDir = normalizeSkillDirPath(targetPath, resource.name)
    || (getAgentTarget(agentId) ? path.join(getAgentTarget(agentId).getSkillRoot(), resource.name) : null);
  if (!skillDir) return { healthy: false, reason: 'unknown-target', repairable: false };

  const authorityDir = resolveAuthorityDir(resource);

  // 权威型：该 Agent 目录本身就是权威源，健康 = 真实目录仍在
  if (projectionType === 'scan' || projectionType === 'origin') {
    // 扫描进来的位置后来被换成了指向真身的软链：真身在就算健康
    return (isRealSkillDir(skillDir) || realSkillDir(skillDir))
      ? { healthy: true, reason: 'authority', repairable: false }
      : { healthy: false, reason: 'authority-missing', repairable: false };
  }

  if (projectionType === 'symlink') {
    if (isSymlinkTo(skillDir, authorityDir)) return { healthy: true, reason: 'symlink', repairable: false };
    if (!authorityDir) return { healthy: false, reason: 'authority-missing', repairable: false };
    return {
      healthy: false,
      reason: pathExists(skillDir) ? 'not-symlink' : 'missing',
      repairable: true,
    };
  }

  if (projectionType === 'copy') {
    if (!pathExists(skillDir)) return { healthy: false, reason: 'missing', repairable: !!authorityDir };
    // 复制存在但可能已陈旧（权威升级后不会自动同步）
    return { healthy: true, reason: 'copy-maybe-stale', repairable: !!authorityDir };
  }

  return { healthy: true, reason: projectionType, repairable: false };
}

// ── 提示词 → MCP 可见性标记(不落盘;可见集由 resource_projections 决定)────────

function projectPromptToAgent(resource, agentId, scope = 'global') {
  return {
    agentId,
    scope,
    targetPath: null,
    authorityPath: null,
    projectionType: 'mcp',
    status: 'active',
  };
}

function unprojectPromptFromAgent() {
  return { removed: true };
}

function projectResource(resource, agentId, scope = 'global', options = {}) {
  if (resource.type === 'skill') {
    return projectSkillToAgent(resource, agentId, scope, options);
  }
  if (resource.type === 'prompt') {
    return projectPromptToAgent(resource, agentId, scope, options);
  }
  return {
    agentId,
    scope,
    targetPath: null,
    authorityPath: null,
    projectionType: 'reference',
    status: 'active',
  };
}

function unprojectResource(resource, agentId, projectionType = 'symlink', targetPath) {
  if (resource.type === 'skill') {
    return unprojectSkillFromAgent(resource, agentId, projectionType, targetPath);
  }
  if (resource.type === 'prompt') {
    return unprojectPromptFromAgent(resource, agentId, targetPath);
  }
  return { removed: true };
}

module.exports = {
  projectResource,
  unprojectResource,
  projectSkillToAgent,
  projectPromptToAgent,
  unprojectPromptFromAgent,
  verifyProjection,
  isForeignRealDir,
  replaceWithSymlink,
  isSymlinkTo,
  normalizeSkillDirPath,
};
