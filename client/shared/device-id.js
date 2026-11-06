// 本机唯一设备 ID：持久化在 ~/.tokenbank/device-id，安装后首次启动自动生成
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const DEVICE_ID_DIR = path.join(os.homedir(), '.tokenbank');
const DEVICE_ID_FILE = path.join(DEVICE_ID_DIR, 'device-id');
const ID_RE = /^dev-[a-f0-9]{16}$/;

/** desktop 与 cli 分文件存 ID，同机双端不会互相覆盖心跳与账户摘要 */
function deviceIdPath(kind = 'desktop') {
  const name = kind === 'cli' ? 'device-id-cli' : 'device-id';
  return path.join(DEVICE_ID_DIR, name);
}

function ensureTokenbankDir() {
  const dir = path.dirname(DEVICE_ID_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/** 读取已持久化的设备 ID（不存在或无效时返回 null） */
function readDeviceId(kind = 'desktop') {
  try {
    const id = fs.readFileSync(deviceIdPath(kind), 'utf8').trim();
    if (id && ID_RE.test(id)) return id;
  } catch (_) {}
  // CLI 首次启动：沿用旧版共用 device-id（迁移一次）
  if (kind === 'cli') {
    try {
      const legacy = fs.readFileSync(DEVICE_ID_FILE, 'utf8').trim();
      if (legacy && ID_RE.test(legacy)) return legacy;
    } catch (_) {}
  }
  return null;
}

/** 写入设备 ID（原子写） */
function writeDeviceId(id, kind = 'desktop') {
  if (!id || !ID_RE.test(id)) return;
  ensureTokenbankDir();
  const file = deviceIdPath(kind);
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, `${id}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * 确保本机有唯一设备 ID。
 * 只认 ~/.tokenbank 里的文件。config.json 会在多台 Mac 之间同步，
 * 文件被删掉时不能从那里把旧 id 抄回来。
 */
function ensureDeviceId(kind = 'desktop') {
  let id = readDeviceId(kind);
  if (!id) id = `dev-${crypto.randomBytes(8).toString('hex')}`;
  writeDeviceId(id, kind);
  return id;
}

module.exports = {
  DEVICE_ID_FILE,
  deviceIdPath,
  readDeviceId,
  writeDeviceId,
  ensureDeviceId,
};
