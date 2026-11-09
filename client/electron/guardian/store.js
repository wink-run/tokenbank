// client/electron/guardian/store.js
// 看护的本地数据：设置、自动处理记录、规则库。存 ~/.tokenbank/guardian/*.json（桌面版与 Docker 同一格式；
// Docker 在 /data 卷里，升级镜像不丢）。写入走临时文件 + rename，读失败回退默认值。
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function dir() {
  return path.join(os.homedir(), '.tokenbank', 'guardian');
}

function readJson(name, fallback) {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(dir(), name), 'utf8'));
    return v == null ? fallback : v;
  } catch {
    return fallback;
  }
}

function writeJson(name, value) {
  const d = dir();
  fs.mkdirSync(d, { recursive: true });
  const file = path.join(d, name);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

module.exports = { dir, readJson, writeJson };
