'use strict';

/**
 * 只给出租接单用：雇佣方不在这台电脑前，成品必须落在工作目录里由平台转交。
 * 本机游乐场 / 本地智能体不要加这段，否则普通问答也会被写成文件。
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
  '远程交付只认当前工作目录：',
  '- 要交给雇佣方的图片、视频、文档，必须用工具写进当前工作目录。写到目录外的文件对方拿不到。',
  '- 这轮新建或改过的文件会由平台换成可远程打开的地址。不要自己编造链接，也不要说已经在 Finder 里打开。',
  '- 回复里用文件在磁盘上的准确文件名指代成品，例如 cover.png。不要写绝对路径、用户目录或文件夹路径。',
  '- 只在正文里写出文件名、却没有把文件写进工作目录，对方只能看到文件名，打不开。',
].join('\n');

/** 出租接单才需要落盘规则，并接上「不能报本机路径」。已有则不重复加。 */
function withRentalHandoff(text) {
  let body = String(text || '');
  if (!body.includes('【Token Bank 产物交付】')) {
    body = body.trim() ? `${body}\n\n${DELIVERY_POLICY}` : DELIVERY_POLICY;
  }
  if (!body.includes('【Token Bank 出租】')) {
    body = `${body}\n\n${RENTAL_CONTEXT}`;
  }
  return body;
}

/** 出租接单时写进系统提示或用户 prompt。已有则不重复加。 */
function applyRentalDefinition(args = []) {
  const out = [...args];
  const idx = out.indexOf('--append-system-prompt');
  if (idx >= 0 && typeof out[idx + 1] === 'string') {
    out[idx + 1] = withRentalHandoff(out[idx + 1]);
    return out;
  }
  for (let i = out.length - 1; i >= 0; i -= 1) {
    const text = out[i];
    if (typeof text !== 'string' || !text.trim() || text.startsWith('-')) continue;
    out[i] = withRentalHandoff(text);
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
