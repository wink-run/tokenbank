// client/cli/docker-entry.js
// Docker 入口：以 root 启动只做准备工作，随后降为普通用户运行网关与命令行智能体。
//  - Claude Code 等在 root 下会拒绝执行任务；普通用户运行也让写出的文件不归 root
//  - 旧版本以 root 写过的 /data 卷，在这里一次性改回运行用户
//  - 智能体默认在 /workspace 工作（挂载项目目录到这里）
// 已用 `docker run --user` 指定非 root 用户时，直接启动，不做任何改动。
'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.HOME || '/data';
const WORKSPACE = process.env.TOKENBANK_WORKDIR || '/workspace';

function toId(v, fallback) {
  const n = Number.parseInt(String(v == null ? '' : v), 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** 递归改属主（不跟随软链接）；只在顶层属主不对时调用 */
function chownTree(root, uid, gid) {
  const stack = [root];
  while (stack.length) {
    const p = stack.pop();
    let st;
    try { st = fs.lstatSync(p); } catch { continue; }
    if (st.uid !== uid || st.gid !== gid) {
      try { fs.lchownSync(p, uid, gid); } catch (e) { console.warn('[docker-entry] chown', p, e.message); }
    }
    if (st.isDirectory()) {
      let names = [];
      try { names = fs.readdirSync(p); } catch { /* ignore */ }
      for (const n of names) stack.push(path.join(p, n));
    }
  }
}

function prepareAndDropPrivileges() {
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) return;
  const uid = toId(process.env.TOKENBANK_UID, 1000);
  const gid = toId(process.env.TOKENBANK_GID, uid);
  if (uid === 0) return; // 显式要求以 root 运行

  for (const dir of [DATA_DIR, WORKSPACE]) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
  }
  // /data 归运行用户（含旧版本 root 写下的文件）；/workspace 只改顶层，不动挂进来的项目文件
  try {
    const st = fs.statSync(DATA_DIR);
    if (st.uid !== uid) {
      console.log(`[docker-entry] fixing ownership of ${DATA_DIR} → ${uid}:${gid}`);
      chownTree(DATA_DIR, uid, gid);
    }
  } catch (e) { console.warn('[docker-entry]', e.message); }
  try {
    const st = fs.statSync(WORKSPACE);
    if (st.uid === 0) fs.chownSync(WORKSPACE, uid, gid);
  } catch { /* ignore */ }

  process.setgroups([gid]);
  process.setgid(gid);
  process.setuid(uid);
  console.log(`[docker-entry] running as ${uid}:${gid}`);
}

prepareAndDropPrivileges();
try { if (fs.existsSync(WORKSPACE)) process.chdir(WORKSPACE); } catch { /* ignore */ }

require('./gateway.js');
