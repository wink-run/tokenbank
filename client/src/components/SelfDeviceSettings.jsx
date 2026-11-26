// 设置页「我的设备」里的本机设置：批准新设备、接不接我其他设备派来的活、开不开放本机模型、中转、工作区（名字 → 本机目录）。
// 只在本机改；其他设备只看到工作区的名字，看不到路径。
import React, { useCallback, useEffect, useState } from 'react';
import { useLang } from '../store/lang';
import { getSelfSettings, updateSelfSettings, addWorkspace, removeWorkspace, useMeshDevices, decidePendingDevice } from '../api/meshDevices';

function Toggle({ on, disabled, onChange, label, hint }) {
  return (
    <label className={`inline-flex items-center gap-1.5 text-xs ${disabled ? 'opacity-60' : 'cursor-pointer'}`} title={hint}>
      <button type="button" role="switch" aria-checked={on} disabled={disabled} onClick={() => onChange(!on)}
        className={`relative w-7 h-4 rounded-full transition-colors shrink-0 ${on ? 'bg-blue-500' : 'bg-zinc-300 dark:bg-zinc-600'}`}>
        <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-white shadow transition-all ${on ? 'left-3.5' : 'left-0.5'}`} />
      </button>
      <span className="text-zinc-600 dark:text-zinc-300">{label}</span>
    </label>
  );
}

/**
 * 中继：本账号用哪个（自动 / 某台设备 / 官方中继，所有设备跟着最近一次的手动指定），本机当不当中继。
 * 下拉里能选的设备：本机，以及描述里开着中继的其他设备。
 */
function RelayControls({ s, mesh, busy, t, run }) {
  const relay = s.relay || {};
  const pref = s.relay_pref || 'auto';
  const options = [];
  if (relay.active) options.push({ id: mesh.self?.device_id || 'self', label: t('mesh.self') });
  for (const d of mesh.others) if (d.relay?.enabled || d.device_id === pref) options.push({ id: d.device_id, label: d.label + (d.online ? '' : ` · ${t('mesh.statusOffline')}`) });
  if (pref !== 'auto' && pref !== 'official' && !options.some((o) => o.id === pref)) options.push({ id: pref, label: pref });
  const using = relay.using === 'self' ? t('mesh.self') : relay.using_label;
  const serving = (relay.serving || []).length;
  return (
    <>
      <label className="inline-flex items-center gap-1 text-xs text-zinc-600 dark:text-zinc-300" title={t('mesh.settings.relayHint')}>
        {t('mesh.settings.relay')}
        <select value={pref} disabled={busy} onChange={(e) => run(() => updateSelfSettings({ relay_pref: e.target.value }))}
          className="tb-soft-field text-xs px-1.5 py-0.5 rounded-md max-w-[11rem]">
          <option value="auto">{t('mesh.settings.relayAuto')}</option>
          {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
          <option value="official">{t('mesh.settings.relayOfficial')}</option>
        </select>
        {using && <span className="text-zinc-400 dark:text-zinc-500">{t('mesh.settings.relayUsing', { name: using })}</span>}
        {relay.unavailable && <span className="text-amber-600 dark:text-amber-400">{t('mesh.settings.relayUnavailable')}</span>}
      </label>
      <label className="inline-flex items-center gap-1 text-xs text-zinc-600 dark:text-zinc-300" title={t('mesh.settings.relayModeHint')}>
        {t('mesh.settings.relayMode')}
        <select value={s.relay_mode || 'auto'} disabled={busy} onChange={(e) => run(() => updateSelfSettings({ relay_mode: e.target.value }))}
          className="tb-soft-field text-xs px-1.5 py-0.5 rounded-md">
          <option value="auto">{t('mesh.settings.relayModeAuto')}</option>
          <option value="on">{t('mesh.settings.relayModeOn')}</option>
          <option value="off">{t('mesh.settings.relayModeOff')}</option>
        </select>
        {serving > 0 && <span className="text-violet-600 dark:text-violet-300">{t('mesh.settings.relayServing', { n: serving })}</span>}
      </label>
    </>
  );
}

export default function SelfDeviceSettings() {
  const { t } = useLang();
  const [s, setS] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [wsOpen, setWsOpen] = useState(false);
  const [draft, setDraft] = useState({ path: '', name: '' });
  const mesh = useMeshDevices();

  const load = useCallback(async () => { setS(await getSelfSettings()); }, []);
  useEffect(() => { load(); }, [load]);

  const run = async (fn) => {
    setBusy(true); setErr('');
    try { setS(await fn()); } catch (e) { setErr(e.message || String(e)); }
    setBusy(false);
    mesh.refresh();
  };

  if (!s) return null;
  if (!s.enabled) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Toggle on={false} disabled={busy || !s.can_enable} label={t('mesh.settings.network')} hint={t('mesh.settings.networkHint')}
          onChange={() => run(() => updateSelfSettings({ enabled: true }))} />
        <span className="text-[11px] text-zinc-400 dark:text-zinc-500">{s.can_enable ? t('mesh.settings.offCan') : t('mesh.settings.offLogin')}</span>
        {err && <span className="text-[11px] text-red-500">{err}</span>}
      </div>
    );
  }
  const cloud = s.cloud || {};
  const syncText = !cloud.connected ? t('mesh.settings.cloudLocal')
    : cloud.error ? t('mesh.settings.cloudError', { msg: cloud.error })
    : cloud.last_sync ? t('mesh.settings.cloudOk', { n: cloud.peers || 0 })
    : t('mesh.settings.cloudSyncing');
  const workspaces = s.workspaces || [];
  const known = new Set(workspaces.map((w) => w.path));
  const recent = (s.recent || []).filter((p) => !known.has(p) && !workspaces.some((w) => p.endsWith(w.path.replace(/^~/, ''))));

  const pending = cloud.pending || [];
  return (
    <div className="flex flex-col gap-2">
      {cloud.awaiting_approval && (
        <p className="m-0 text-xs text-amber-700 dark:text-amber-300">{t('mesh.approval.waiting')}</p>
      )}
      {pending.map((p) => (
        <div key={p.device_id} className="flex flex-wrap items-center gap-2 text-xs rounded-lg px-3 py-2 bg-amber-500/10 text-amber-800 dark:text-amber-200 max-w-2xl">
          <span>{t('mesh.approval.request', { name: p.name || p.device_id })}</span>
          <button type="button" disabled={busy} onClick={() => run(async () => { await decidePendingDevice(p.device_id, true); return getSelfSettings(); })}
            className="min-h-[24px] px-2.5 rounded-md font-medium bg-blue-500 text-white hover:bg-blue-600 disabled:opacity-60">{t('mesh.approval.approve')}</button>
          <button type="button" disabled={busy} onClick={() => run(async () => { await decidePendingDevice(p.device_id, false); return getSelfSettings(); })}
            className="min-h-[24px] px-2 text-zinc-500 hover:text-red-500">{t('mesh.approval.reject')}</button>
          <span className="basis-full text-[11px] opacity-70">{t('mesh.approval.hint')}</span>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Toggle on disabled={busy} label={t('mesh.settings.network')} hint={t('mesh.settings.networkHint')}
          onChange={() => run(() => updateSelfSettings({ enabled: false }))} />
        <Toggle on={s.accept_agent_tasks} disabled={busy} label={t('mesh.settings.acceptTasks')} hint={t('mesh.settings.acceptTasksHint')}
          onChange={(v) => run(() => updateSelfSettings({ accept_agent_tasks: v }))} />
        {s.accept_agent_tasks && (
          <label className="inline-flex items-center gap-1 text-xs text-zinc-600 dark:text-zinc-300" title={t('mesh.settings.maxTasksHint')}>
            {t('mesh.settings.maxTasks')}
            <select value={s.max_tasks || 2} disabled={busy} onChange={(e) => run(() => updateSelfSettings({ max_tasks: Number(e.target.value) }))}
              className="tb-soft-field text-xs px-1.5 py-0.5 rounded-md">
              {[1, 2, 3, 4, 6, 8].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
            {s.load ? <span className="text-zinc-400 dark:text-zinc-500">{t('mesh.settings.running', { n: s.load.running })}</span> : null}
          </label>
        )}
        <Toggle on={s.accept_model_requests} disabled={busy} label={t('mesh.settings.shareModels')} hint={t('mesh.settings.shareModelsHint')}
          onChange={(v) => run(() => updateSelfSettings({ accept_model_requests: v }))} />
        <RelayControls s={s} mesh={mesh} busy={busy} t={t} run={run} />
        <button type="button" onClick={() => setWsOpen((v) => !v)} aria-expanded={wsOpen}
          className="text-xs text-blue-600 dark:text-blue-400 hover:underline">
          {t('mesh.settings.workspaces', { n: workspaces.length })}
        </button>
        <span className={`text-[11px] ${cloud.error ? 'text-amber-600 dark:text-amber-400' : 'text-zinc-400 dark:text-zinc-500'}`}>{syncText}</span>
        {err && <span className="text-[11px] text-red-500">{err}</span>}
      </div>
      {wsOpen && (
        <div className="tb-soft-tile rounded-xl px-3 py-2.5 flex flex-col gap-2 max-w-2xl">
          <p className="m-0 text-[11px] text-zinc-400 dark:text-zinc-500">{t('mesh.settings.wsHint')}</p>
          {workspaces.length === 0 && <p className="m-0 text-xs text-zinc-400">{t('mesh.settings.wsEmpty')}</p>}
          {workspaces.map((w) => (
            <div key={w.name} className="flex items-center gap-2 text-xs min-w-0">
              <label className="inline-flex items-center gap-1 shrink-0 cursor-pointer" title={t('mesh.settings.wsDefaultHint')}>
                <input type="radio" name="tb-ws-default" checked={w.default} disabled={busy}
                  onChange={() => run(() => updateSelfSettings({ default_workspace: w.name }))} />
                <span className="font-medium text-zinc-800 dark:text-zinc-100">{w.name}</span>
              </label>
              <span className={`font-mono truncate min-w-0 ${w.exists ? 'text-zinc-500 dark:text-zinc-400' : 'text-red-500'}`} title={w.path}>
                {w.path}{w.exists ? '' : ` · ${t('mesh.settings.wsMissing')}`}
              </span>
              <button type="button" disabled={busy} onClick={() => run(() => removeWorkspace(w.name))}
                className="ml-auto shrink-0 text-[11px] text-zinc-400 hover:text-red-500">{t('mesh.settings.wsRemove')}</button>
            </div>
          ))}
          <form className="flex flex-wrap items-center gap-2 pt-1 border-t border-zinc-100 dark:border-white/[0.06]"
            onSubmit={(e) => {
              e.preventDefault();
              if (!draft.path.trim()) return;
              run(async () => { const r = await addWorkspace(draft.name.trim(), draft.path.trim()); setDraft({ path: '', name: '' }); return r; });
            }}>
            {recent.length > 0 && (
              <select value="" disabled={busy} onChange={(e) => e.target.value && setDraft({ path: e.target.value, name: '' })}
                className="tb-soft-field text-xs px-2 py-1.5 rounded-lg max-w-[14rem]" aria-label={t('mesh.settings.wsRecent')}>
                <option value="">{t('mesh.settings.wsRecent')}</option>
                {recent.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            )}
            <input value={draft.path} onChange={(e) => setDraft({ ...draft, path: e.target.value })} placeholder={t('mesh.settings.wsPathPh')}
              className="tb-soft-field flex-1 min-w-[12rem] text-xs px-3 py-1.5 rounded-lg font-mono" />
            <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder={t('mesh.settings.wsNamePh')}
              className="tb-soft-field w-32 text-xs px-3 py-1.5 rounded-lg" />
            <button type="submit" disabled={busy || !draft.path.trim()}
              className="min-h-[28px] px-3 rounded-lg text-xs font-medium bg-blue-500 text-white hover:bg-blue-600 disabled:opacity-60">
              {t('mesh.settings.wsAdd')}
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
