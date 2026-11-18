// 智能管家启动时带上的 Token Bank 接口。改资产走这些工具，不直接改数据库。
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeElectronAsNodeLauncher, mcpStdioFromLauncher } = require('../mcp-manager');

const SERVERS = [
  ['tokenbank-resources', 'resources-mcp.js', { TB_CLIENT_ID: 'guardian-chat', TB_GUARDIAN: '1' }],
  ['tokenbank-prompts', 'prompt-mcp.js', { TB_CLIENT_ID: 'guardian-chat' }],
  ['tokenbank-models', 'models-mcp.js', {}],
  ['tokenbank-agent-bridge', 'agent-dispatch-mcp.js', {}],
];

function configDir(dir) {
  return dir || path.join(os.homedir(), '.tokenbank', 'guardian');
}

/** 写出智能管家这次启动要用的 MCP 配置，不改用户自己的 mcp.json。 */
function writeConfig(dir) {
  const folder = configDir(dir);
  fs.mkdirSync(folder, { recursive: true });
  const mcpDir = path.join(folder, 'mcp-launchers');
  const mcpServers = {};
  for (const [name, script, env] of SERVERS) {
    const launcher = writeElectronAsNodeLauncher({
      name: `guardian-${name}`,
      scriptPath: path.join(__dirname, '..', script),
      env,
      mcpDir,
    });
    const entry = mcpStdioFromLauncher(launcher);
    mcpServers[name] = { command: entry.command, args: entry.args };
  }
  const file = path.join(folder, 'mcp.json');
  fs.writeFileSync(file, `${JSON.stringify({ mcpServers }, null, 2)}\n`);
  return { folder, file, mcpServers };
}

/**
 * Claude 参数：--mcp-config <配置文件>。
 * 这个选项会吞掉后面所有非选项参数，调用方必须把它放在提示词之后。
 */
function claudeArgs({ dir } = {}) {
  return ['--mcp-config', writeConfig(dir).file];
}

/**
 * Pi 没有单次启动的 --mcp-config。用一个只在这次进程里生效的扩展注册接口，
 * 不写 ~/.pi/agent/mcp.json。工具设为 direct，模型能直接调用。
 * 扩展参数必须放在 `--` 前面，否则会被当成提示词。
 */
function piArgs({ dir } = {}) {
  const { folder, mcpServers } = writeConfig(dir);
  const ext = path.join(folder, 'pi-mcp.ts');
  const body = [
    'export default function (pi) {',
    `  const servers = ${JSON.stringify(mcpServers)};`,
    '  for (const [name, config] of Object.entries(servers)) {',
    '    // 用户 mcp.json 里的同名服务会盖住扩展注册，所以加前缀，只在这次进程里出现',
    '    pi.registerMcpServer("guardian-" + name, { ...config, exposure: "direct" });',
    '  }',
    '}',
    '',
  ].join('\n');
  fs.writeFileSync(ext, body);
  return ['--extension', ext];
}

/** 插到 Pi 的 `--` 之前，避免扩展参数被吃进提示词。 */
function placeBeforeDoubleDash(args, extra) {
  const out = Array.isArray(args) ? [...args] : [];
  const dash = out.lastIndexOf('--');
  if (dash >= 0) out.splice(dash, 0, ...extra);
  else out.push(...extra);
  return out;
}

function tomlString(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function codexServerKey(name) {
  return `guardian_${String(name).replace(/[^A-Za-z0-9_]/g, '_')}`;
}

/** Codex 的 -c 只覆盖这一次启动，不写 ~/.codex/config.toml。 */
function codexOverrideArgs(servers) {
  const extra = [];
  for (const [name, spec] of Object.entries(servers || {})) {
    const key = `mcp_servers.${codexServerKey(name)}`;
    extra.push('-c', `${key}.command=${tomlString(spec.command)}`);
    extra.push('-c', `${key}.args=${JSON.stringify(spec.args || [])}`);
  }
  return extra;
}

function insertAfterToken(args, token, extra) {
  const out = [...args];
  const at = out.indexOf(token);
  out.splice(at >= 0 ? at + 1 : 0, 0, ...extra);
  return out;
}

function insertBeforeFlag(args, flag, extra) {
  if (!extra.length) return [...args];
  const out = [...args];
  const at = out.indexOf(flag);
  if (at >= 0) out.splice(at, 0, ...extra);
  else out.push(...extra);
  return out;
}

/** 写成各应用认识的 mcpServers。名字加前缀，避免盖住用户配置里的同名服务。 */
function writeNamedMcp(file, servers) {
  const mcpServers = {};
  for (const [name, spec] of Object.entries(servers || {})) {
    mcpServers[`guardian-${name}`] = spec;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ mcpServers }, null, 2)}\n`);
}

function retargetCursor(args, overlay, workingDir) {
  const out = [...args];
  const idx = out.indexOf('--workspace');
  const original = idx >= 0 && out[idx + 1] ? out[idx + 1] : workingDir;
  if (idx >= 0 && out[idx + 1]) out[idx + 1] = overlay;
  else out.unshift('--workspace', overlay);
  if (original && original !== overlay && !out.includes(original)) {
    const promptAt = out.length - 1;
    const tail = out[promptAt];
    if (typeof tail === 'string' && !tail.startsWith('-')) out.splice(promptAt, 0, '--add-dir', original);
    else out.push('--add-dir', original);
  }
  return out;
}

/**
 * 智能管家这次启动带上 Token Bank 接口。
 * 只作用于这一次进程，不改 Claude / Codex / Cursor / Kimi / Pi 自己的配置。
 * @returns {{ args: string[], cwd: string|null }}
 */
function attach(runtimeId, args, { workingDir, dir } = {}) {
  const list = Array.isArray(args) ? [...args] : [];
  const id = String(runtimeId || '');
  if (id === 'claude-code') return { args: list.concat(claudeArgs({ dir })), cwd: null };
  if (id === 'pi') return { args: placeBeforeDoubleDash(list, piArgs({ dir })), cwd: null };
  const { mcpServers } = writeConfig(dir);
  if (id === 'codex') return { args: insertAfterToken(list, 'exec', codexOverrideArgs(mcpServers)), cwd: null };
  if (id === 'cursor') {
    const overlay = path.join(configDir(dir), 'cursor-workspace');
    writeNamedMcp(path.join(overlay, '.cursor', 'mcp.json'), mcpServers);
    return { args: retargetCursor(list, overlay, workingDir), cwd: null };
  }
  if (id === 'kimi-code') {
    const overlay = path.join(configDir(dir), 'kimi-session');
    writeNamedMcp(path.join(overlay, '.kimi-code', 'mcp.json'), mcpServers);
    const add = workingDir && workingDir !== overlay ? ['--add-dir', workingDir] : [];
    return { args: insertBeforeFlag(list, '-p', add), cwd: overlay };
  }
  // 没有一次性参数的应用，仍用系统说明里的本机接口。
  return { args: list, cwd: null };
}

module.exports = { claudeArgs, piArgs, placeBeforeDoubleDash, attach, SERVERS };
