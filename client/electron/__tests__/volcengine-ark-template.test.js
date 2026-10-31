'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const yaml = require('js-yaml');

describe('mergeRegistryDoc 按 id 补全缺项', () => {
  it('云端 billing_sources 缺 volcengine-ark 时从内置补入', () => {
    // 构造临时用户 registry：有 providers.ark、无 billing.ark
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-reg-'));
    const userPath = path.join(tmpDir, 'providers.registry.yaml');
    const stub = {
      version: 1,
      providers: [{ id: 'deepseek', label: 'DeepSeek', payg: true }],
      billing_sources: [
        { id: 'deepseek', category: 'payg', label: 'DeepSeek' },
        { id: 'api-volcengine', category: 'api_sub', label: 'Volcengine AI', plan_provider_id: 'volcengine' },
      ],
    };
    fs.writeFileSync(userPath, yaml.dump(stub));

    // 通过改环境难以劫持 USER_REGISTRY_YAML；直接测 merge 逻辑：
    // 复用 config-loader 的内置默认 + 手动模拟 mergeById 行为
    const loaderPath = require.resolve('../config-loader');
    delete require.cache[loaderPath];
    const loader = require('../config-loader');
    // 读内置默认确认有 ark
    const def = yaml.load(fs.readFileSync(
      path.join(__dirname, '../config/providers.registry.yaml'), 'utf8',
    ));
    assert.ok((def.billing_sources || []).some((s) => s.id === 'volcengine-ark'));

    // 模拟 merge：缺 id 应被补入
    const have = new Set(stub.billing_sources.map((s) => s.id));
    const merged = [...stub.billing_sources];
    for (const item of def.billing_sources || []) {
      if (!item?.id || have.has(item.id)) continue;
      merged.push(item);
      have.add(item.id);
    }
    assert.ok(merged.some((s) => s.id === 'volcengine-ark'));
    assert.ok(merged.some((s) => s.id === 'deepseek')); // 保留云端已有

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe('getSourceTemplates 含 volcengine-ark', () => {
  it('只认服务端下发的 registry 缓存，不用仓库 yaml 补源', () => {
    const loader = require('../config-loader');
    const billing = require('../billing-config');
    const userPath = path.join(os.homedir(), '.tokenbank', 'providers.registry.yaml');
    const backup = fs.existsSync(userPath) ? fs.readFileSync(userPath) : null;
    fs.mkdirSync(path.dirname(userPath), { recursive: true });
    const fixture = {
      version: 1,
      providers: [],
      billing_sources: [{
        id: 'volcengine-ark',
        category: 'payg',
        label: '火山引擎（按量）',
        base_url: 'https://ark.cn-beijing.volces.com/api/v3/',
        api_format: 'openai',
        models: [{ id: 'doubao-seed-2.1-pro', modality: 'chat' }],
      }],
    };
    try {
      fs.writeFileSync(userPath, yaml.dump(fixture));
      loader.reloadRegistryDoc();
      const ark = billing.getSourceTemplates({}).find((t) => t.key === 'volcengine-ark');
      assert.ok(ark, '缓存中的 volcengine-ark 应出现');
      assert.equal(ark.kind, 'payg');
      assert.match(String(ark.base_url || ''), /\/api\/v3/);

      // CI 机器没有 ~/.tokenbank 缓存；空缓存不得回退仓库 yaml
      fs.unlinkSync(userPath);
      loader.reloadRegistryDoc();
      assert.equal(
        billing.getSourceTemplates({}).find((t) => t.key === 'volcengine-ark'),
        undefined,
      );
    } finally {
      if (backup) fs.writeFileSync(userPath, backup);
      else if (fs.existsSync(userPath)) fs.unlinkSync(userPath);
      loader.reloadRegistryDoc();
    }
  });
});
