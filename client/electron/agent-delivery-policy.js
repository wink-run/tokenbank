'use strict';

/**
 * Claude Code / Codex 共用：可交付产物必须由 Agent 直接落盘，
 * 禁止让用户粘贴依赖 Codex 内部 cache 的「一键保存」超长脚本。
 */
const DELIVERY_POLICY = [
  '【Token Bank 产物交付】',
  '1. PPT/PDF/图片/代码等文件须用工具直接写入当前工作目录或用户指定路径（如桌面），完成后回复绝对路径。',
  '2. 禁止让用户复制粘贴「一键保存」超长脚本；禁止依赖 ~/.cache/codex-runtimes、artifact_tool 等内部路径。',
  '3. 若必须用脚本生成：先把完整脚本写入工作目录（.js/.mjs/.py 等），再在该目录用 shell 执行并写出产物。',
  '4. 对话中只给简短说明与最终文件路径，不要贴完整生成脚本正文。',
].join('\n');

/**
 * 只有出租接单时追加。雇佣方不在这台电脑前，不能把本机路径当交付。
 * 放在产物规则后面，避免「回复绝对路径」盖过这件事。
 */
const RENTAL_CONTEXT = [
  '【Token Bank 出租】',
  '你是上架出租的智能体，当前任务来自雇佣方，不是这台电脑的主人。',
  '雇佣方看不到这台电脑，打不开 Finder、桌面或任何本机路径。',
  '上面关于回复绝对路径、写到桌面或用户指定本机位置的要求，在这次出租里不适用。',
  '文件写到当前工作目录。回复里只用文件名指代成品，不要给绝对路径、用户目录或文件夹路径，也不要说已经在 Finder 里打开。',
  '平台会把工作目录里的成品交给雇佣方。',
].join('\n');

/** 出租接单时写进系统提示。已有则不重复加。 */
function applyRentalDefinition(args = []) {
  const out = [...args];
  const idx = out.indexOf('--append-system-prompt');
  if (idx >= 0 && typeof out[idx + 1] === 'string') {
    if (!out[idx + 1].includes('【Token Bank 出租】')) {
      out[idx + 1] = `${out[idx + 1]}\n\n${RENTAL_CONTEXT}`;
    }
    return out;
  }
  for (let i = out.length - 1; i >= 0; i -= 1) {
    const text = out[i];
    if (typeof text !== 'string' || !text.trim() || text.startsWith('-')) continue;
    if (text.includes('【Token Bank 出租】')) return out;
    if (text.includes(DELIVERY_POLICY)) {
      out[i] = text.replace(DELIVERY_POLICY, `${DELIVERY_POLICY}\n\n${RENTAL_CONTEXT}`);
    } else {
      out[i] = `${RENTAL_CONTEXT}\n\n${text}`;
    }
    return out;
  }
  return out;
}

/** Codex：前缀拼到用户 prompt */
function withDeliveryPolicyPrompt(prompt) {
  const body = String(prompt || '');
  if (!body.trim()) return DELIVERY_POLICY;
  if (body.includes('【Token Bank 产物交付】')) return body;
  return `${DELIVERY_POLICY}\n\n${body}`;
}

/** Claude：追加 --append-system-prompt 段（已有则拼接） */
function withClaudeDeliverySystemArgs(extraArgs = []) {
  const out = [...extraArgs];
  const idx = out.indexOf('--append-system-prompt');
  if (idx >= 0 && out[idx + 1] != null) {
    const prev = String(out[idx + 1]);
    if (!prev.includes('【Token Bank 产物交付】')) {
      out[idx + 1] = `${prev}\n\n${DELIVERY_POLICY}`;
    }
    return out;
  }
  out.push('--append-system-prompt', DELIVERY_POLICY);
  return out;
}

module.exports = {
  DELIVERY_POLICY,
  RENTAL_CONTEXT,
  withDeliveryPolicyPrompt,
  withClaudeDeliverySystemArgs,
  applyRentalDefinition,
};
