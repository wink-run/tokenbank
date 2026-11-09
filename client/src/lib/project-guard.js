// 投射到应用：看护的安全巡检发现高风险技能时，先列出风险请用户确认，确认后才投射。
// 所有投射入口（资产页、启用流程、为我推荐）统一走这里。
export async function projectWithGuard(params, { confirm = (msg) => window.confirm(msg), t, name, lang } = {}) {
  const api = window.electronAPI?.resource;
  const first = await api.project(params);
  if (!first || first.success !== false || first.error !== 'security-risk') return first;
  const list = (first.securityFindings || [])
    .filter(f => f.level === 'high')
    .map(f => `· ${f.text}（${f.file}:${f.line}）`)
    .join('\n');
  const label = name || params.resourceId;
  const msg = t
    ? t('resources.securityConfirm', { name: label, list })
    : (String(lang || 'zh').startsWith('en')
      ? `"${label}" contains high-risk operations:\n\n${list}\n\nProject it to your apps anyway?`
      : `「${label}」包含高风险操作：\n\n${list}\n\n确认来源可信、仍要投射到应用吗？`);
  if (!confirm(msg)) return { success: false, error: 'security-risk-declined', canceled: true };
  return api.project({ ...params, allowRisky: true });
}
