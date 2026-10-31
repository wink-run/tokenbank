'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { compileAppsDoc, resolveAppsRuntime } = require('../apps-compiler');

describe('apps-compiler', () => {
  test('compileAppsDoc expands handler capabilities to sections', () => {
    const doc = compileAppsDoc({
      app_entities: [{
        id: 'openclaw',
        handler: 'openclaw-api',
        name: 'OpenClaw',
        vars: {
          capabilities: {
            gateway_proxy: true,
            session_trace: false,
            session_usage_import: false,
          },
        },
      }],
    });
    assert.equal(doc.tools.length, 0);
    assert.equal(doc.api_key_apps.length, 1);
    assert.equal(doc.api_key_apps[0].id, 'openclaw');
    assert.equal(doc.session_sources.length, 0);
    assert.equal(doc.entities_expanded[0].capabilities.gateway_proxy, true);
  });

  test('session-only entity compiles session_sources with trace flags', () => {
    const doc = compileAppsDoc({
      app_entities: [{
        id: 'claude-code',
        handler: 'claude-code-cli',
        vars: {
          capabilities: {
            gateway_proxy: false,
            session_trace: true,
            session_usage_import: true,
          },
        },
      }],
    });
    assert.equal(doc.tools.length, 0);
    assert.equal(doc.session_sources.length, 1);
    const s = doc.session_sources[0];
    assert.equal(s.agent_id, 'claude-code');
    assert.equal(s.session_trace, true);
    assert.equal(s.session_usage_import, true);
    assert.equal(s.standalone, false);
  });

  test('resolveAppsRuntime falls back to default_entities when section missing', () => {
    const rt = resolveAppsRuntime({
      tools: [{ id: 'stale-tool', name: 'Stale' }],
    });
    assert.ok(rt.app_entities.length > 0);
    assert.ok(rt.tools.length > 0);
  });

  test('resolveAppsRuntime compiles from app_entities', () => {
    const rt = resolveAppsRuntime({
      app_entities: [{
        id: 'hermes',
        handler: 'hermes-cli',
        vars: { capabilities: { gateway_proxy: true, session_trace: false, session_usage_import: false } },
      }],
    });
    // 提供的实体一定编译出来（新增默认会被回填，故不再断言独占数量）
    assert.ok(rt.tools.some(t => t.id === 'hermes'));
  });

  test('resolveAppsRuntime backfills newly-bundled default entities into a populated list', () => {
    // 持久化的 app_entities 只有 hermes，且不含 deepseek-harness（新捆绑应用）。
    // 回填后：既有实体保留，新默认按 id 补入；用户没删过的新应用应出现在百宝箱。
    const rt = resolveAppsRuntime({
      app_entities: [{ id: 'hermes', handler: 'hermes-cli' }],
    });
    const ids = (rt.app_entities || []).map(e => e.id);
    assert.ok(ids.includes('hermes'), 'existing entity preserved');
    assert.ok(ids.includes('deepseek-harness'), 'new default backfilled');
    // dsh 是 config-file（api_key）型应用 → 编译进 api_key_apps，patch 写 settings.yaml
    const dsh = rt.api_key_apps.find(t => t.id === 'deepseek-harness');
    assert.ok(dsh, 'deepseek-harness compiles to an api_key app');
    assert.equal(dsh.command, 'dsh');
    assert.ok(dsh.config_file.includes('settings.yaml'));
    assert.equal(dsh.patch['agent-default-model.provider'], 'tokenbank');
    assert.equal(dsh.patch['llm-pi-ai.providers.tokenbank.baseURL'], '{BASE}/v1');
    assert.equal(dsh.patch['llm-pi-ai.providers.tokenbank.apiKeyEnv'], 'TOKENBANK_DSH_API_KEY');
    const pi = rt.api_key_apps.find(t => t.id === 'pi');
    assert.ok(pi, 'pi compiles to an api_key app');
    assert.equal(pi.command, 'pi');
    assert.ok(String(pi.config_file).includes('models.json'));
    assert.equal(pi.patch['providers.tokenbank.api'], 'openai-completions');
    for (const id of ['omo', 'prime', 'omp']) {
      const app = rt.api_key_apps.find(t => t.id === id);
      assert.ok(app, `${id} compiles to an api_key app`);
      assert.equal(app.patch['providers.tokenbank.api'], 'openai-completions');
    }
    assert.equal(rt.api_key_apps.find(t => t.id === 'omp').command, 'omp');
    assert.ok(String(rt.api_key_apps.find(t => t.id === 'omo').config_file).includes('models.json'));
  });

  // kimi-code-cli：云端实体依赖内置 handler，避免「未知 handler」被 skip
  test('kimi-code-cli compiles to tools with KIMI_MODEL_* inject', () => {
    // 单实体编译用 compileAppsDoc（纯编译，不做默认回填）
    const rt = compileAppsDoc({
      app_entities: [{
        id: 'kimi-code',
        handler: 'kimi-code-cli',
        vars: { capabilities: { gateway_proxy: true, session_trace: false, session_usage_import: false } },
      }],
    });
    assert.equal(rt.tools.length, 1);
    assert.equal(rt.tools[0].id, 'kimi-code');
    assert.equal(rt.tools[0].detect.command, 'kimi');
    assert.equal(rt.tools[0].protocol, 'anthropic');
    assert.equal(rt.tools[0].inject.env.KIMI_MODEL_PROVIDER_TYPE, 'anthropic');
    assert.ok(rt.tools[0].inject.env.KIMI_MODEL_BASE_URL);
    assert.ok(rt.tools[0].inject.env.KIMI_MODEL_API_KEY);
  });

  test('kimi-code-cli with session caps emits session_sources', () => {
    const rt = compileAppsDoc({
      app_entities: [{
        id: 'kimi-code',
        handler: 'kimi-code-cli',
        vars: {
          capabilities: {
            gateway_proxy: true,
            session_trace: true,
            session_usage_import: true,
          },
        },
      }],
    });
    assert.equal(rt.session_sources.length, 1);
    assert.equal(rt.session_sources[0].id, 'kimi');
    assert.equal(rt.entities_expanded[0].trace_profile, 'kimi-code-trace');
  });

  test('vars provider_id overlays session source', () => {
    const doc = compileAppsDoc({
      app_entities: [{
        id: 'cursor',
        handler: 'cursor-stats',
        vars: {
          capabilities: { gateway_proxy: false, session_trace: true, session_usage_import: true },
          provider_id: 'cursor-custom',
        },
      }],
    });
    assert.equal(doc.session_sources[0].provider_id, 'cursor-custom');
  });
});
