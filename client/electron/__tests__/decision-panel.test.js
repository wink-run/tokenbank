'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const vm = require('vm');
const Module = require('module');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { transformSync } = require('esbuild');
const filename = path.resolve(__dirname, '../../src/components/DecisionPanel.jsx');
const source = transformSync(fs.readFileSync(filename, 'utf8'), { loader: 'jsx', format: 'cjs' }).code;
const compiled = new Module(filename, module);
compiled.filename = filename;
compiled.paths = Module._nodeModulePaths(path.dirname(filename));
const originalRequire = compiled.require.bind(compiled);
compiled.require = name => name === '../store/lang' ? { useLang: () => ({ lang: 'zh' }) } : originalRequire(name);
compiled._compile(source, filename);
const { DecisionPanelView } = compiled.exports;
const base = {
  mode: 'off', supported: true, endpoint: 'http://127.0.0.1:18080/v1/systemone',
  circuit: { state: 'unused', retryAfterMs: 0 }, metrics: { shadow: { total: 10, comparable: 4, agreed: 3, errors: 2 }, decisions: {} },
};
const render = props => renderToStaticMarkup(React.createElement(DecisionPanelView, { status: base, available: true, onAction() {}, ...props }));

test('panel renders comparable-only agreement and does not claim untested availability', () => {
  const html = render({});
  assert.match(html, /75.0%/);
  assert.match(html, /服务状态未知/);
  assert.match(html, /开启旁路/);
  assert.ok(!html.includes('开启正式路由</button>'));
});
test('browser/old preload displays unsupported state, not working-looking controls', () => {
  const html = render({ available: false });
  assert.match(html, /新版桌面端/);
  assert.ok(!html.includes('<button'));
});
test('active routing remains visible with a disable action, in English too', () => {
  const html = render({ lang: 'en', status: { ...base, mode: 'active', activeEndpoint: base.endpoint, activeProvider: 'opendecision' } });
  assert.match(html, /Live routing/);
  assert.match(html, /Disable &amp; revert/);
  assert.match(html, /cannot enable live routing/);
});
test('busy/unsupported services cannot be enabled through the panel', () => {
  const tree = DecisionPanelView({ status: { ...base, supported: false }, available: true, busy: '', onAction() {} });
  const buttons = [];
  function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(walk);
    if (node.type === 'button') buttons.push(node);
    walk(node.props?.children);
  }
  walk(tree);
  assert.equal(buttons.find(b => b.props.children === '开启旁路').props.disabled, true);
  assert.equal(buttons.find(b => b.props.children === '检查连接与分类').props.disabled, true);
});
test('preload wiring invokes only the intended management channels', async () => {
  let api;
  const calls = [];
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../preload.js'), 'utf8'), {
    process: { platform: 'win32' },
    require: name => {
      assert.equal(name, 'electron');
      return {
        contextBridge: { exposeInMainWorld: (name, value) => { assert.equal(name, 'electronAPI'); api = value; } },
        ipcRenderer: { sendSync: () => 'test', invoke: (...args) => { calls.push(args); return Promise.resolve({}); } },
      };
    },
  });
  await api.decision.status(); await api.decision.probe(); await api.decision.setMode('shadow');
  assert.deepEqual(calls, [['decision:status'], ['decision:probe'], ['decision:setMode', 'shadow']]);
});
