/**
 * 社区接单的智能体只能读写自己的工作目录。
 * 用系统沙箱挡住目录外的文件操作，不改 CLI 的免确认参数，避免弹窗把任务挂住。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

// 进程要读到解释器、库和网络配置，否则 CLI 起不来
const SYSTEM_READ = [
  '/usr', '/bin', '/sbin', '/opt', '/Library', '/System', '/Applications',
  '/private', '/dev', '/etc', '/var',
];

// 登录态和会话记在这些目录。不放行的话续聊和鉴权会失败
const TOOL_STATE = [
  '.claude', '.codex', '.cursor', '.kimi', '.kimi-code', '.pi',
  '.npm', '.nvm', '.local', '.bun', '.cache',
  path.join('Library', 'Caches'),
  path.join('Library', 'Logs'),
  path.join('Library', 'Application Support', 'Claude'),
  path.join('Library', 'Application Support', 'Cursor'),
];

function quote(p) {
  return `"${String(p).replace(/[\\"]/g, '\\$&')}"`;
}

function realpathOrSelf(p) {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

function buildSeatbeltProfile({ workspace, home, pathEnv, executable, tmpDir } = {}) {
  const logical = path.resolve(String(workspace || ''));
  const root = realpathOrSelf(logical);
  const homeDir = path.resolve(home || os.homedir());
  const reads = new Set(SYSTEM_READ);
  const writes = new Set([logical, root, '/private/tmp', '/tmp', '/private/var/folders']);
  reads.add(logical);
  reads.add(root);
  for (const dir of String(pathEnv || '').split(path.delimiter)) {
    if (!dir) continue;
    reads.add(path.resolve(dir));
  }
  if (tmpDir) {
    const tmp = path.resolve(String(tmpDir));
    reads.add(tmp);
    writes.add(tmp);
  }
  // CLI 本体可能在家目录里。只放行它所在的目录，不放行整个家目录
  if (executable) {
    try {
      const binDir = path.dirname(fs.realpathSync(String(executable)));
      reads.add(binDir);
    } catch { /* 找不到就靠 PATH */ }
  }
  for (const rel of TOOL_STATE) {
    const abs = path.join(homeDir, rel);
    reads.add(abs);
    writes.add(abs);
  }
  // Claude 的登录文件在家目录这一层，不在 .claude 里面
  for (const name of ['.claude.json', '.claude.json.backup']) {
    const file = path.join(homeDir, name);
    reads.add(file);
    writes.add(file);
  }
  const lines = [
    '(version 1)',
    '(deny default)',
    // 允许起子进程和访问模型接口，文件权限仍按下面的目录收口
    '(allow process-exec)',
    '(allow process-fork)',
    '(allow signal)',
    '(allow sysctl-read)',
    '(allow mach-lookup)',
    '(allow ipc-posix-shm)',
    '(allow ipc-posix-sem)',
    '(allow system-socket)',
    '(allow network*)',
    '(allow file-ioctl)',
    '(allow file-map-executable)',
    // 只放行根目录这一层，否则解析 /bin、/usr 时会直接中止
    '(allow file-read* (literal "/"))',
    // 家目录本身不能读内容，但要能穿过它走进工作目录。否则一写文件就是 Operation not permitted
    '(allow file-read-metadata (subpath "/"))',
    // 工具会把丢弃的输出写到这里。不放行的话很多命令一重定向就失败
    '(allow file-write* (literal "/dev/null"))',
  ];
  for (const dir of reads) lines.push(`(allow file-read* (subpath ${quote(dir)}))`);
  for (const dir of writes) lines.push(`(allow file-write* (subpath ${quote(dir)}))`);
  return `${lines.join('\n')}\n`;
}

/** macOS 上把命令包进沙箱。其它系统维持原样。 */
function wrapConfinedSpawn({ executable, args, workingDir, env } = {}) {
  if (process.platform !== 'darwin') return null;
  if (!fs.existsSync(SANDBOX_EXEC)) {
    throw new Error('无法把智能体限制在工作目录内');
  }
  const profile = buildSeatbeltProfile({
    workspace: workingDir,
    home: env && env.HOME,
    pathEnv: env && env.PATH,
    executable,
    tmpDir: env && (env.TMPDIR || env.TMP),
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-sandbox-'));
  const profilePath = path.join(dir, 'workspace.sb');
  fs.writeFileSync(profilePath, profile);
  return {
    command: SANDBOX_EXEC,
    args: ['-f', profilePath, executable, ...(args || [])],
    cleanup() {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 进程已退出 */ }
    },
  };
}

module.exports = {
  buildSeatbeltProfile,
  wrapConfinedSpawn,
};
