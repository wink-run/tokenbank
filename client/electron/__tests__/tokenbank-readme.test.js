'use strict';
// 网关挂上时在 ~/.tokenbank 放一份 README：智能体自己翻这个目录时，第一眼看到要用 tokenbank 的工具查
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-readme-'));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
const relay = require('../mcp-gateway-server');
const tools = require('../tokenbank-tools');

test('网关挂上后 ~/.tokenbank/README.md 在，写着用哪些工具查', () => {
  relay.attachToGateway({ port: 18777, listRoutedFn: () => [] });
  const text = fs.readFileSync(path.join(HOME, '.tokenbank', 'README.md'), 'utf8');
  for (const name of ['tb_capabilities', 'tb_list_resources', 'tb_list_models', 'tb_list_agents']) assert.match(text, new RegExp(name));
  relay.stopMcpGateway();
});

test('工具说明写清什么时候用、别去读文件', () => {
  const byName = Object.fromEntries(tools.listTools({ level: 'full' }).map((t) => [t.name, t.description]));
  assert.match(byName.tb_capabilities, /用户问 Token Bank/);
  assert.match(byName.tb_capabilities, /~\/\.tokenbank/);
  assert.match(byName.tb_list_resources, /我有哪些技能/);
  assert.match(tools.INSTRUCTIONS, /不要去读 ~\/\.tokenbank/);
});
