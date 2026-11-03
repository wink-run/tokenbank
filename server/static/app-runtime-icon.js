// 出租的默认应用（app:claude-code 等）用应用图标，自定义智能体仍用首字。
(function () {
  var ICONS = {
    'claude-code': '/static/brand/claudecode-color.svg',
    codex: '/static/brand/codex-color.svg',
    cursor: '/static/brand/cursor.svg',
    'kimi-code': '/static/brand/kimi-color.svg',
  };

  function runtimeOf(agent) {
    var id = String((agent && (agent.id || agent.assistant_id)) || '');
    var m = id.match(/(?:^|:)app:([A-Za-z0-9._-]+)/);
    return m ? m[1].split('@')[0] : '';
  }

  function url(agent) {
    var rt = typeof agent === 'string' ? agent : runtimeOf(agent);
    return ICONS[rt] || '';
  }

  window.TBAppIcon = { runtimeOf: runtimeOf, url: url };
})();
