'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const catalog = require('../mcp-catalog');

describe('mcp-catalog', () => {
  beforeEach(() => {
    catalog.resetCatalogCache();
  });

  it('loads items from config/mcp-catalog.yaml', () => {
    const items = catalog.listCatalogItems();
    assert.ok(items.length > 1, 'catalog should have multiple items');
    const builtin = items.find(i => i.catalogId === 'tokenbank');
    assert.ok(builtin);
    assert.equal(builtin.alwaysInstalled, true);
    assert.ok(!items.some(i => i.catalogId === 'tokenbank-agent-bridge'), '旧的四条内置已合并');
  });

  it('groups catalog by categoryGroup', () => {
    const groups = catalog.listCatalogGrouped();
    assert.ok(groups.length > 0);
    const ids = groups.map(g => g.id);
    assert.ok(ids.includes('tokenbank') || ids.includes('official'));
  });

  it('normalizes yaml config_fields', () => {
    const item = catalog.normalizeYamlItem({
      catalog_id: 'test',
      name: 'test',
      display_name: 'Test',
      config_fields: [{
        key: 'dir',
        label: 'Dir',
        type: 'path',
        default_value: '~/projects',
        append_arg: true,
        env_key: 'DIR',
        header_key: 'X-API-Key',
        required: true,
      }],
    });
    assert.equal(item.configFields[0].defaultValue.includes('projects'), true);
    assert.equal(item.configFields[0].appendArg, true);
    assert.equal(item.configFields[0].envKey, 'DIR');
    assert.equal(item.configFields[0].headerKey, 'X-API-Key');
  });

  it('yaml file exists at electron config path', () => {
    const p = path.join(__dirname, '..', 'config', 'mcp-catalog.yaml');
    const fs = require('fs');
    assert.ok(fs.existsSync(p), `missing ${p}`);
  });

  it('includes pipeworx as remote http catalog item', () => {
    const item = catalog.getCatalogItem('pipeworx');
    assert.ok(item);
    assert.equal(item.type, 'http');
    assert.equal(item.url, 'https://gateway.pipeworx.io/mcp');
    assert.equal(item.alwaysInstalled, false);
    assert.equal(item.configFields[0].key, 'pipeworxApiKey');
    assert.equal(item.configFields[0].headerKey, 'X-API-Key');
    assert.equal(item.configFields[0].required, false);
  });

  it('normalizes yaml url for remote http items', () => {
    const item = catalog.normalizeYamlItem({
      catalog_id: 'remote-demo',
      name: 'remote-demo',
      type: 'http',
      url: 'https://example.com/mcp',
    });
    assert.equal(item.type, 'http');
    assert.equal(item.url, 'https://example.com/mcp');
  });
});
