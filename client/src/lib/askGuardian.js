// 有疑问时去游乐场和看护的执行应用对话（双向沟通），而不是只看一条提示
// 带上上下文放进输入框，用户看过、可改，再自己点发送
export async function askGuardian(navigate, prompt) {
  let agentId = null;
  try {
    const st = await window.electronAPI?.guardian?.engineStatus?.();
    agentId = st?.runtime || null;
  } catch { /* 没有执行应用：游乐场用当前选中的 */ }
  navigate('/debug', { state: { prompt, ...(agentId ? { agentId } : {}) } });
}

/** 看护记录 → 提问 */
export function recordQuestion(r, lang) {
  const lines = [r.title, r.advice, r.detail, r.lastError].filter(Boolean);
  return lang === 'en'
    ? `Token Bank's guardian reported this:\n${lines.join('\n')}\n\nHelp me understand why and what I should do. Ask me before changing files or running commands.`
    : `Token Bank 看护提示：\n${lines.join('\n')}\n\n帮我弄清楚原因和该怎么处理。改文件或执行命令前先问我。`;
}
