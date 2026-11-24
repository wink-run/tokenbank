'use strict';
// 社区推荐目录:缓存优先 + 内置 MCP 永不丢失
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const yaml = require('js-yaml');

const CACHE = path.join(os.homedir(), '.tokenbank', 'community-catalog.yaml');

function writeCache(doc) {
  fs.mkdirSync(path.dirname(CACHE), { recursive: true });
  fs.writeFileSync(CACHE, yaml.dump(doc), 'utf8');
}
function clearCache() {
  try { fs.unlinkSync(CACHE); } catch {}
}

test('mcp-catalog: 缓存项覆盖同 id 且保留内置 MCP', () => {
  const mcpCatalog = require('../mcp-catalog');
  writeCache({
    version: 1,
    mcp: [{
      catalog_id: 'community-demo', id: 'community-demo', name: 'community-demo',
      display_name: 'Community Demo', type: 'stdio', command: 'npx', args: ['-y', 'demo'],
      metadata: { categoryGroup: 'official' }, config_fields: [],
    }, {
      // 云端还没更新时下发的旧内置条目
      catalog_id: 'tokenbank-prompts', id: 'tokenbank-prompts', name: 'tokenbank-prompts',
      type: 'stdio', command: '__DYNAMIC_ELECTRON__', metadata: { categoryGroup: 'tokenbank' }, always_installed: true,
    }],
    prompts: [], skills: [], assistants: [],
  });
  mcpCatalog.resetCatalogCache();
  const ids = new Set(mcpCatalog.listCatalogItems().map(i => i.catalogId));
  assert.ok(ids.has('community-demo'), '缓存项应出现');
  assert.ok(ids.has('tokenbank'), '内置 tokenbank 永不丢');
  assert.ok(!ids.has('tokenbank-prompts'), '下发的旧内置条目不要');
  clearCache();
  mcpCatalog.resetCatalogCache();
});

test('mcp-catalog: 无缓存时回退本地内置 yaml', () => {
  const mcpCatalog = require('../mcp-catalog');
  clearCache();
  mcpCatalog.resetCatalogCache();
  const ids = new Set(mcpCatalog.listCatalogItems().map(i => i.catalogId));
  assert.ok(ids.has('tokenbank'));
});

test('resource-catalog: 缓存优先返回下发项', () => {
  const resCatalog = require('../resource-catalog');
  writeCache({
    version: 1, mcp: [],
    prompts: [{ catalogId: 'srv-prompt', type: 'prompt', name: 'srv-prompt',
      display_name: '服务端提示词', description: 'from server', content: 'X' }],
    skills: [], assistants: [],
  });
  resCatalog.resetCatalogCache();
  const names = resCatalog.listCatalogItems().map(i => i.name);
  assert.ok(names.includes('srv-prompt'), '应含下发 prompt');
  assert.ok(!names.includes('code-review'), '缓存存在时不混入 BUILTIN');
  assert.equal(resCatalog.getCatalogItem('srv-prompt').display_name, '服务端提示词');
  clearCache();
  resCatalog.resetCatalogCache();
});

test('resource-catalog: 无缓存回退 BUILTIN', () => {
  const resCatalog = require('../resource-catalog');
  clearCache();
  resCatalog.resetCatalogCache();
  const names = resCatalog.listCatalogItems().map(i => i.name);
  assert.ok(names.includes('code-review'), '无缓存时用内置');
});

test('resource-catalog: 缺 name 的缓存项被剔除,不抛异常', () => {
  const resCatalog = require('../resource-catalog');
  writeCache({
    version: 1, mcp: [],
    prompts: [
      { catalog_id: 'valid-x', type: 'prompt', name: 'valid-x', description: 'ok' },
      { catalog_id: 'no-name-x', type: 'prompt', description: 'missing name' },
    ],
    skills: [], assistants: [],
  });
  resCatalog.resetCatalogCache();
  assert.doesNotThrow(() => resCatalog.listCatalogItems({ query: 'x' }));
  const names = resCatalog.listCatalogItems({ query: 'x' }).map(i => i.name);
  assert.ok(names.includes('valid-x'), '有效项应保留');
  assert.ok(!names.includes(undefined), '缺 name 的项不应混入');
  clearCache();
  resCatalog.resetCatalogCache();
});

test('writeCommunityCatalogCache: 空 payload 不覆盖已存在的缓存内容', () => {
  const catalogSync = require('../catalog-sync');
  clearCache();
  writeCache({
    version: 1, mcp: [],
    prompts: [{ catalog_id: 'existing', type: 'prompt', name: 'existing' }],
    skills: [], assistants: [],
  });
  const before = fs.readFileSync(CACHE, 'utf8');

  const wrote = catalogSync.writeCommunityCatalogCache({ mcp: [], prompts: [], skills: [], assistants: [] });

  assert.equal(wrote, false);
  assert.ok(fs.existsSync(CACHE), '已存在的缓存文件应保留');
  const after = fs.readFileSync(CACHE, 'utf8');
  assert.equal(after, before, '空 payload 不应改动已有缓存内容');

  clearCache();
});

test('writeCommunityCatalogCache: 有内容才写,空 payload 不动缓存', () => {
  const catalogSync = require('../catalog-sync');
  clearCache();
  const wrote = catalogSync.writeCommunityCatalogCache({
    version: 1, mcp: [], prompts: [{ catalog_id: 'p', type: 'prompt', name: 'p' }],
    skills: [], assistants: [],
  });
  assert.equal(wrote, true);
  assert.ok(fs.existsSync(CACHE));
  const back = yaml.load(fs.readFileSync(CACHE, 'utf8'));
  assert.equal(back.prompts[0].name, 'p');

  clearCache();
  const wrote2 = catalogSync.writeCommunityCatalogCache({ mcp: [], prompts: [], skills: [], assistants: [] });
  assert.equal(wrote2, false);
  assert.ok(!fs.existsSync(CACHE), '空 payload 不落缓存');
});
