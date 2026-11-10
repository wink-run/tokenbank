// 有疑问时去游乐场和内置「看护」智能体对话（双向沟通），而不是只看一条提示
// 带上上下文放进输入框，用户看过、可改，再自己点发送
export const GUARDIAN_AGENT_ID = 'assistant:tb-guardian';

export function askGuardian(navigate, prompt) {
  navigate('/debug', { state: { prompt, agentId: GUARDIAN_AGENT_ID } });
}

/** 看护记录 → 提问 */
export function recordQuestion(r, lang) {
  const lines = [r.title, r.advice, r.detail, r.lastError].filter(Boolean);
  return lang === 'en'
    ? `Token Bank's guardian reported this:\n${lines.join('\n')}\n\nHelp me understand why and what I should do. Ask me before changing files or running commands.`
    : `Token Bank 看护提示：\n${lines.join('\n')}\n\n帮我弄清楚原因和该怎么处理。改文件或执行命令前先问我。`;
}
