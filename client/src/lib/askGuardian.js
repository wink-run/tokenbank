// 有疑问时去和智能管家对话，而不是只看一条提示
export const GUARDIAN_AGENT_ID = 'assistant:tb-guardian';

export function askGuardian(navigate, prompt) {
  // 去智能管家对话页，把问题放进输入框；用户看过、可改，再自己发
  navigate('/guardian', { state: { prompt } });
}

/** 智能管家记录 → 提问 */
export function recordQuestion(r, lang) {
  const lines = [r.title, r.advice, r.detail, r.lastError].filter(Boolean);
  return lang === 'en'
    ? `About this notice you raised:\n${lines.join('\n')}\n\nWhy is this happening, and what should be done?`
    : `你提示的这条：\n${lines.join('\n')}\n\n这是怎么回事？该怎么处理？`;
}

/** 用户觉得这条是误报 → 让智能管家核实，确认后写一条学到的规则（智能管家以后照着判，不用等发版本） */
export function falsePositiveQuestion(r, lang) {
  const facts = r.facts || (Array.isArray(r.factsList) ? r.factsList.slice(0, 5) : null);
  const f = facts ? JSON.stringify(facts, null, 2) : '';
  return lang === 'en'
    ? `I think this notice of yours is a false positive:\n${r.title}\n${r.advice || ''}\nWhat you based it on:\n${f}\n\nCheck it. If you got it wrong, fix your rule so it is not raised again.`
    : `我觉得你这条提醒是误报：\n${r.title}\n${r.advice || ''}\n你下结论的依据：\n${f}\n\n核实一下，如果判错了就改好规则，以后别再报。`;
}
