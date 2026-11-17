import React, { useCallback, useEffect, useState } from 'react';
import { useLang } from '../store/lang';

const api = () => (typeof window !== 'undefined' ? window.electronAPI?.resource : null) || {};
const NAME_RE = /^[A-Z][A-Z0-9_]{1,63}$/;

/**
 * 技能要用的 Key / 配置：列出技能里写到的变量，每个一格，配过的只显示末四位。
 * 值存在本机（不写进技能文件）；Token Bank 跑任务时带上，Claude Code 写进它的配置，其它应用 source 一个文件。
 */
export default function SkillEnvPanel({ resourceId, onChanged }) {
  const { t } = useLang();
  const [info, setInfo] = useState(null);
  const [draft, setDraft] = useState({});
  const [saving, setSaving] = useState('');
  const [err, setErr] = useState('');
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [newValue, setNewValue] = useState('');

  const load = useCallback(async () => {
    if (!resourceId || !api().skillEnvGet) return;
    const r = await api().skillEnvGet({ resourceId }).catch(() => null);
    setInfo(r?.success ? r : { vars: [], missing: [] });
  }, [resourceId]);

  useEffect(() => { setInfo(null); setDraft({}); setErr(''); setAdding(false); load(); }, [load]);

  if (!api().skillEnvGet || !info) return null;

  const save = async (name, value) => {
    setSaving(name); setErr('');
    const r = await api().skillEnvSet({ resourceId, name, value }).catch(e => ({ success: false, error: e.message }));
    setSaving('');
    if (!r?.success) { setErr(r?.error || t('resources.env.saveFailed')); return false; }
    setDraft(d => ({ ...d, [name]: '' }));
    await load();
    onChanged?.();
    return true;
  };

  const vars = info.vars || [];
  const field = 'tb-soft-field min-w-0 flex-1 rounded-lg px-2.5 py-1.5 text-xs font-mono text-zinc-900 dark:text-zinc-100';
  const btn = 'shrink-0 text-[11px] px-2.5 py-1.5 rounded-lg disabled:opacity-40';

  return (
    <div className="space-y-2.5">
      {vars.length === 0 ? (
        <p className="text-[11px] text-zinc-400">{t('resources.env.none')}</p>
      ) : vars.map(v => (
        <div key={v.name} className="space-y-1">
          <div className="flex items-center gap-1.5 min-w-0">
            <code className="text-[11px] font-mono text-zinc-800 dark:text-zinc-100 truncate">{v.name}</code>
            {v.declared && <span className="shrink-0 text-[10px] px-1 rounded bg-rose-50 dark:bg-rose-950/40 text-rose-600 dark:text-rose-300">{t('resources.env.required')}</span>}
            {!v.declared && !v.custom && <span className="shrink-0 text-[10px] text-zinc-400" title={t('resources.env.mentionedHint')}>{t('resources.env.mentioned')}</span>}
            <span className={`ml-auto shrink-0 text-[11px] ${v.set ? 'text-emerald-600 dark:text-emerald-400' : 'text-zinc-400'}`}>
              {v.set ? t('resources.env.setAs', { v: v.preview }) : t('resources.env.notSet')}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <input type="password" autoComplete="off" value={draft[v.name] || ''} placeholder={v.set ? t('resources.env.replacePh') : t('resources.env.valuePh')}
              onChange={e => setDraft(d => ({ ...d, [v.name]: e.target.value }))}
              onKeyDown={e => { if (e.key === 'Enter' && draft[v.name]) save(v.name, draft[v.name]); }}
              className={field} aria-label={v.name} />
            <button type="button" disabled={!draft[v.name] || saving === v.name} onClick={() => save(v.name, draft[v.name])}
              className={`${btn} bg-blue-600 text-white hover:bg-blue-500`}>{saving === v.name ? t('resources.env.saving') : t('resources.env.save')}</button>
            {v.set && (
              <button type="button" disabled={saving === v.name} onClick={() => save(v.name, '')}
                className={`${btn} text-zinc-500 hover:text-rose-600`}>{t('resources.env.clear')}</button>
            )}
          </div>
        </div>
      ))}

      {adding ? (
        <div className="space-y-1.5 pt-1">
          <div className="flex items-center gap-1.5">
            <input value={newName} onChange={e => setNewName(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ''))}
              placeholder={t('resources.env.namePh')} className={field} aria-label={t('resources.env.namePh')} />
            <input type="password" autoComplete="off" value={newValue} onChange={e => setNewValue(e.target.value)}
              placeholder={t('resources.env.valuePh')} className={field} aria-label={t('resources.env.valuePh')} />
          </div>
          <div className="flex items-center gap-1.5">
            <button type="button" disabled={!NAME_RE.test(newName) || !newValue || !!saving}
              onClick={async () => { if (await save(newName, newValue)) { setNewName(''); setNewValue(''); setAdding(false); } }}
              className={`${btn} bg-blue-600 text-white hover:bg-blue-500`}>{t('resources.env.save')}</button>
            <button type="button" onClick={() => { setAdding(false); setNewName(''); setNewValue(''); }} className={`${btn} text-zinc-500`}>{t('resources.env.cancel')}</button>
          </div>
        </div>
      ) : (
        <button type="button" onClick={() => setAdding(true)} className="text-[11px] text-blue-600 dark:text-blue-400 hover:underline">
          + {t('resources.env.add')}
        </button>
      )}

      {err && <p className="text-[11px] text-rose-600 dark:text-rose-400">{err}</p>}
      <p className="text-[11px] leading-relaxed text-zinc-400">
        {t('resources.env.where')}<code className="mx-0.5 font-mono">source {String(info.shellFile || '~/.tokenbank/skill-env.sh').replace(/^\/(?:root|home\/[^/]+|Users\/[^/]+)/, '~')}</code>
      </p>
    </div>
  );
}
