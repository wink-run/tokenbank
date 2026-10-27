// 同一账户的「同步账户密钥」：心跳带上开关和时间，其它终端按较新的修改对齐本机。

import { getConfig } from '../api/adapter';
import { getInventoryStats } from '../api/client';
import { pickSyncAccountSecrets } from './account-config-sync';

export function syncSecretsFromConfig(cfg) {
  return {
    value: !!cfg?.sync_account_secrets,
    at: Number(cfg?.sync_account_secrets_at) || 0,
  };
}

/** 读其它终端上报的开关。比本机新才写回本地配置。 */
export async function alignSyncAccountSecretsFromCloud(cfg) {
  const current = cfg && typeof cfg === 'object' ? cfg : ((await getConfig().read().catch(() => null)) || {});
  const local = syncSecretsFromConfig(current);
  let devices = [];
  try {
    const inv = await getInventoryStats(1);
    devices = inv?.data?.devices || [];
  } catch {
    return local;
  }
  const myId = current.device_id || '';
  const remotes = devices
    .filter(d => d && d.accounts_config && (!myId || d.device_id !== myId))
    .map(d => d.accounts_config);
  const picked = pickSyncAccountSecrets(local, remotes);
  if (picked.at > local.at && picked.value !== local.value) {
    try {
      const latest = (await getConfig().read().catch(() => null)) || current;
      await getConfig().write({
        ...latest,
        sync_account_secrets: picked.value,
        sync_account_secrets_at: picked.at,
      });
    } catch { /* 离线仍用刚算出的值 */ }
    return picked;
  }
  return local;
}
