// 自定义路由的一句话说明，给模型页的路由行用：「图片请求走 A；其余走 B → C，前一个不行换下一个」

const OPS = ['is', 'not', 'gt', 'lt', 'gte', 'lte', 'match', 'contains'];
const REQUEST_TYPES = ['chat', 'image', 'video', 'embedding', 'audio'];

function stepName(s, t) {
  if (!s) return '?';
  const model = String(s.model || s.label || '').trim();
  if (model) return model;
  if (s.scope === 'community') return t('gateway.route.sum.anyCommunity');
  if (s.scope === 'personal') return t('gateway.route.sum.anyPersonal');
  if (s.tier === 'free') return t('gateway.route.sum.anyFree');
  if (s.tier === 'paid') return t('gateway.route.sum.anyPaid');
  return t('gateway.route.sum.any');
}

function condText(w, t) {
  if (!w?.type) return '';
  const op = OPS.includes(w.op) ? w.op : 'is';
  if (w.type === 'request_type' && REQUEST_TYPES.includes(w.value)) {
    return t(`gateway.route.sum.type.${op === 'not' ? 'not' : 'is'}`, { kind: t(`gateway.route.sum.kind.${w.value}`) });
  }
  return t('gateway.route.sum.cond', {
    what: t(`gateway.route.sum.field.${w.type}`),
    op: t(`gateway.route.sum.op.${op}`),
    value: String(w.value ?? ''),
  });
}

/** 把路由的步骤（含老格式 rules）说成一句话 */
export function routeSummary(route, t) {
  const flat = [];
  for (const r of route?.rules || []) for (const s of r.steps || []) flat.push({ ...s, when: s.when || r.when });
  for (const s of route?.steps || []) flat.push(s);
  if (!flat.length) return t('gateway.route.sum.empty');

  const parts = [];
  const plain = [];
  for (const s of flat) {
    if (s.when?.type) parts.push(t('gateway.route.sum.whenGo', { cond: condText(s.when, t), to: stepName(s, t) }));
    else plain.push(stepName(s, t));
  }
  if (plain.length) {
    const multi = plain.length > 1;
    const key = parts.length
      ? (multi ? 'gateway.route.sum.restChain' : 'gateway.route.sum.rest')
      : (multi ? 'gateway.route.sum.allChain' : 'gateway.route.sum.all');
    // 几步之间怎么走：没设就是轮流
    const flow = ['fallback', 'latency', 'weighted', 'direct'].includes(route?.flow) ? route.flow : 'roundRobin';
    const how = multi ? t(`gateway.route.sum.flow.${flow}`) : '';
    parts.push(t(key, { to: plain.join(multi && flow === 'fallback' ? ' → ' : '、'), how }));
  }
  return parts.join(t('gateway.route.sum.sep'));
}
