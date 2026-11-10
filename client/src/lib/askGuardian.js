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

/** 用户觉得这条是误报 → 让内置看护智能体核实，确认后写一条判断规则（看护以后照着判，不用等发版本） */
export function falsePositiveQuestion(r, lang) {
  const facts = r.facts || (Array.isArray(r.factsList) ? r.factsList.slice(0, 5) : null);
  const f = facts ? JSON.stringify(facts, null, 2) : '';
  return lang === 'en'
    ? `I think this guardian notice is a false positive:\n${r.title}\n${r.advice || ''}\nFacts it was based on:\n${f}\n\nPlease verify. If it really is a false positive, explain why and write a judgment rule in your rule format so the guardian stops judging it this way.`
    : `我觉得这条看护提醒是误报：\n${r.title}\n${r.advice || ''}\n看护下结论的依据：\n${f}\n\n帮我核实一下。如果确实是误报，说明原因，并按判断规则的格式写一条规则，让看护以后不再这样判。`;
}
