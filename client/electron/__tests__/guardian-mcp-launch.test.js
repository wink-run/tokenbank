'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { claudeArgs, piArgs, placeBeforeDoubleDash, attach } = require('../guardian/mcp-launch');

test('guardian claude launch carries the tokenbank mcp servers, and only its resources process can write', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-guardian-mcp-'));
  const args = claudeArgs({ dir });
  assert.deepEqual(args.slice(0, 1), ['--mcp-config']);
  const doc = JSON.parse(fs.readFileSync(args[1], 'utf8'));
  assert.deepEqual(Object.keys(doc.mcpServers).sort(), [
    'tokenbank-agent-bridge',
    'tokenbank-models',
    'tokenbank-prompts',
    'tokenbank-resources',
  ]);
  const launcher = doc.mcpServers['tokenbank-resources'].args[0];
  const script = fs.readFileSync(launcher, 'utf8');
  assert.match(script, /TB_GUARDIAN='1'/);
  assert.match(script, /TB_CLIENT_ID='guardian-chat'/);
  const prompts = fs.readFileSync(doc.mcpServers['tokenbank-prompts'].args[0], 'utf8');
  assert.doesNotMatch(prompts, /TB_GUARDIAN/);
});

test('guardian pi launch registers the same servers for this process only', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-guardian-pi-'));
  const args = piArgs({ dir });
  assert.deepEqual(args.slice(0, 1), ['--extension']);
  const ext = fs.readFileSync(args[1], 'utf8');
  assert.match(ext, /registerMcpServer/);
  assert.match(ext, /exposure: "direct"/);
  assert.match(ext, /guardian-/);
  assert.match(ext, /tokenbank-resources/);
  const doc = JSON.parse(fs.readFileSync(path.join(dir, 'mcp.json'), 'utf8'));
  const launcher = doc.mcpServers['tokenbank-resources'].args[0];
  assert.match(fs.readFileSync(launcher, 'utf8'), /TB_GUARDIAN='1'/);
  const placed = placeBeforeDoubleDash(['--mode', 'json', '--', '修复视频'], args);
  assert.ok(placed.indexOf('--extension') < placed.lastIndexOf('--'));
  assert.equal(placed[placed.length - 1], '修复视频');
});

test('guardian attach covers every managed runtime without moving the prompt', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-guardian-attach-'));
  const claude = attach('claude-code', ['-p', '修复视频'], { dir });
  assert.equal(claude.args[claude.args.length - 2], '--mcp-config');
  assert.equal(claude.args[1], '修复视频');

  const codex = attach('codex', ['exec', '--json', '修复视频'], { dir });
  assert.equal(codex.args[0], 'exec');
  assert.equal(codex.args[1], '-c');
  assert.match(codex.args[2], /mcp_servers\.guardian_tokenbank_resources\.command=/);
  assert.equal(codex.args[codex.args.length - 1], '修复视频');

  const cursor = attach('cursor', ['-p', '--workspace', '/proj', '修复视频'], { dir, workingDir: '/proj' });
  const ws = cursor.args.indexOf('--workspace');
  assert.notEqual(cursor.args[ws + 1], '/proj');
  assert.ok(fs.existsSync(path.join(cursor.args[ws + 1], '.cursor', 'mcp.json')));
  assert.ok(cursor.args.includes('--add-dir'));
  assert.ok(cursor.args.includes('/proj'));
  assert.equal(cursor.args[cursor.args.length - 1], '修复视频');

  const kimi = attach('kimi-code', ['--output-format', 'stream-json', '-p', '修复视频'], { dir, workingDir: '/proj' });
  assert.equal(kimi.cwd, path.join(dir, 'kimi-session'));
  assert.ok(fs.existsSync(path.join(kimi.cwd, '.kimi-code', 'mcp.json')));
  assert.ok(kimi.args.indexOf('--add-dir') < kimi.args.indexOf('-p'));
  assert.equal(kimi.args[kimi.args.length - 1], '修复视频');
});
