const { contextBridge, ipcRenderer } = require('electron');

/** 个人页计费 API 鉴权（跨终端同步用） */
function billingAuth() {
  return {
    token: localStorage.getItem('token') || '',
    serverUrl: localStorage.getItem('serverUrl') || '',
  };
}

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,   // darwin | win32 | linux — 百宝箱说明等平台差异
  version: ipcRenderer.sendSync('app:version'),
  decision: {
    status: () => ipcRenderer.invoke('decision:status'),
    probe: () => ipcRenderer.invoke('decision:probe'),
    setMode: mode => ipcRenderer.invoke('decision:setMode', mode),
  },
  app: {
    defaultServerUrl: () => ipcRenderer.sendSync('app:defaultServerUrl'),
    getDeviceIdentity: (opts) => ipcRenderer.sendSync('app:getDeviceIdentity', opts || {}),
    setHideDockIcon: (hide) => ipcRenderer.invoke('app:setHideDockIcon', hide),
    // light/dark/system → 同步 Windows 原生标题栏
    setThemeSource: (source) => ipcRenderer.invoke('app:setThemeSource', source),
  },
  auth: {
    request: (opts) => ipcRenderer.invoke('auth:request', opts),
  },
  agent: {
    start: () => ipcRenderer.invoke('agent:start'),
    stop: () => ipcRenderer.invoke('agent:stop'),
    getStatus: () => ipcRenderer.invoke('agent:status'),
    onStatus: (cb) => {
      const handler = (_e, data) => cb(data);
      ipcRenderer.on('agent:status', handler);
      return () => ipcRenderer.removeListener('agent:status', handler);
    },
    getLogs: () => ipcRenderer.invoke('agent:getLogs'),
    onLog: (cb) => {
      const handler = (_e, line) => cb(line);
      ipcRenderer.on('agent:log', handler);
      return () => ipcRenderer.removeListener('agent:log', handler);
    },
    // Agent 聚合系统 API
    listAgents: (opts) => ipcRenderer.invoke('agent:list', opts || {}),
    execute: (params) => ipcRenderer.invoke('agent:execute', params),
    cancel: (taskId) => ipcRenderer.invoke('agent:cancel', taskId),
    cancelAllActive: () => ipcRenderer.invoke('agent:cancelAllActive'),
    getTaskStatus: (taskId) => ipcRenderer.invoke('agent:getStatus', taskId),
    listActiveTasks: () => ipcRenderer.invoke('agent:listActiveTasks'),
    listRecentTasks: (opts) => ipcRenderer.invoke('agent:listRecentTasks', opts),
    pickWorkingDir: (opts) => ipcRenderer.invoke('agent:pickWorkingDir', opts),
    // 兼容旧调用
    list: (opts) => ipcRenderer.invoke('agent:list', opts || {}),
    // 社区武将雇佣
    listHiredCommunity: () => ipcRenderer.invoke('community:listHired'),
    hireCommunity: (card) => ipcRenderer.invoke('community:hire', card),
    unhireCommunity: (id) => ipcRenderer.invoke('community:unhire', id),
    onStep: (cb) => {
      const handler = (_e, data) => cb(data);
      ipcRenderer.on('agent:task:step', handler);
      return () => ipcRenderer.removeListener('agent:task:step', handler);
    },
    onDispatched: (cb) => {
      const handler = (_e, data) => cb(data);
      ipcRenderer.on('agent:task:dispatched', handler);
      return () => ipcRenderer.removeListener('agent:task:dispatched', handler);
    },
    onCompleted: (cb) => {
      const handler = (_e, data) => cb(data);
      ipcRenderer.on('agent:task:completed', handler);
      return () => ipcRenderer.removeListener('agent:task:completed', handler);
    },
    onFailed: (cb) => {
      const handler = (_e, data) => cb(data);
      ipcRenderer.on('agent:task:failed', handler);
      return () => ipcRenderer.removeListener('agent:task:failed', handler);
    },
    onCancelled: (cb) => {
      const handler = (_e, data) => cb(data);
      ipcRenderer.on('agent:task:cancelled', handler);
      return () => ipcRenderer.removeListener('agent:task:cancelled', handler);
    },
    onCliSession: (cb) => {
      const handler = (_e, data) => cb(data);
      ipcRenderer.on('agent:task:cliSession', handler);
      return () => ipcRenderer.removeListener('agent:task:cliSession', handler);
    },
  },
  mcp: {
    listServers: () => ipcRenderer.invoke('mcp:listServers'),
    listCatalog: () => ipcRenderer.invoke('mcp:listCatalog'),
    installCatalog: (params) => ipcRenderer.invoke('mcp:installCatalog', params),
    uninstallServer: (serverId) => ipcRenderer.invoke('mcp:uninstallServer', serverId),
    setServerStatus: (params) => ipcRenderer.invoke('mcp:setServerStatus', params),
    saveServer: (data) => ipcRenderer.invoke('mcp:saveServer', data),
    listProfiles: () => ipcRenderer.invoke('mcp:listProfiles'),
    getProfile: (profileId) => ipcRenderer.invoke('mcp:getProfile', profileId),
    saveProfile: (params) => ipcRenderer.invoke('mcp:saveProfile', params),
    syncClients: (options) => ipcRenderer.invoke('mcp:syncClients', options || {}),
    getSyncStatus: () => ipcRenderer.invoke('mcp:getSyncStatus'),
    listAgentInstallations: () => ipcRenderer.invoke('mcp:listAgentInstallations'),
    importFromClient: (params) => ipcRenderer.invoke('mcp:importFromClient', params),
    importFromAgent: (params) => ipcRenderer.invoke('mcp:importFromAgent', params || {}),
    setServerSyncClients: (params) => ipcRenderer.invoke('mcp:setServerSyncClients', params),
    toggleServerSyncClient: (params) => ipcRenderer.invoke('mcp:toggleServerSyncClient', params),
    removeFromAgent: (params) => ipcRenderer.invoke('mcp:removeFromAgent', params),
    setServerGatewayRouted: (params) => ipcRenderer.invoke('mcp:setServerGatewayRouted', params),
    setServersGatewayRouted: (params) => ipcRenderer.invoke('mcp:setServersGatewayRouted', params),
    getGatewayInfo: () => ipcRenderer.invoke('mcp:getGatewayInfo'),
  },
  resource: {
    listCatalog: (filters) => ipcRenderer.invoke('resource:listCatalog', filters || {}),
    listResources: (filters) => ipcRenderer.invoke('resource:listResources', filters || {}),
    installCatalog: (params) => ipcRenderer.invoke('resource:installCatalog', params || {}),
    syncCommunityCatalog: () => ipcRenderer.invoke('resource:syncCommunityCatalog'),
    upsertCommunitySkill: (params) => ipcRenderer.invoke('resource:upsertCommunitySkill', params || {}),
    ensureBuiltinAssistants: () => ipcRenderer.invoke('resource:ensureBuiltinAssistants'),
    saveResource: (data) => ipcRenderer.invoke('resource:saveResource', data || {}),
    pickImportPath: (options) => ipcRenderer.invoke('resource:pickImportPath', options || {}),
    importFromPath: (params) => ipcRenderer.invoke('resource:importFromPath', params || {}),
    // 兼容旧调用 deleteResource(id)；新调用可带 { force: true } 强制卸载
    deleteResource: (resourceId, options) => ipcRenderer.invoke(
      'resource:deleteResource',
      { resourceId, ...(options && typeof options === 'object' ? options : {}) },
    ),
    project: (params) => ipcRenderer.invoke('resource:project', params || {}),
    unproject: (params) => ipcRenderer.invoke('resource:unproject', params || {}),
    verifyProjections: (params) => ipcRenderer.invoke('resource:verifyProjections', params || {}),
    listAgentTargets: () => ipcRenderer.invoke('resource:listAgentTargets'),
    listScanRoots: (filters) => ipcRenderer.invoke('resource:listScanRoots', filters || {}),
    scanDiscovered: (filters) => ipcRenderer.invoke('resource:scanDiscovered', filters || {}),
    syncDiscovered: (filters) => ipcRenderer.invoke('resource:syncDiscovered', filters || {}),
    importDiscovered: (params) => ipcRenderer.invoke('resource:importDiscovered', params || {}),
    listAgentInstallations: (filters) => ipcRenderer.invoke('resource:listAgentInstallations', filters || {}),
    importFromAgent: (params) => ipcRenderer.invoke('resource:importFromAgent', params || {}),
    removeFromAgent: (params) => ipcRenderer.invoke('resource:removeFromAgent', params || {}),
    openPath: (params) => ipcRenderer.invoke('resource:openPath', params || {}),
    previewFile: (params) => ipcRenderer.invoke('resource:previewFile', params || {}),
    listIdleSkills: (options) => ipcRenderer.invoke('resource:listIdleSkills', options || {}),
    cleanupSkills: (params) => ipcRenderer.invoke('resource:cleanupSkills', params || {}),
    mineDemand: (options) => ipcRenderer.invoke('resource:mineDemand', options || {}),
    installSkillhub: (params) => ipcRenderer.invoke('resource:installSkillhub', params || {}),
    installGithubSkill: (params) => ipcRenderer.invoke('resource:installGithubSkill', params || {}),
    extractDescription: (params) => ipcRenderer.invoke('resource:extractDescription', params || {}),
    // 点将/取用命中息票
    onHit: (cb) => {
      const h = (_e, data) => cb(data);
      ipcRenderer.on('resource:hit', h);
      return () => ipcRenderer.removeListener('resource:hit', h);
    },
    /** 轮询最近命中（IPC 丢事件时兜底） */
    pollHit: () => ipcRenderer.invoke('resource:pollHit'),
  },
  config: {
    read:  () => ipcRenderer.invoke('config:read'),
    write: (cfg) => ipcRenderer.invoke('config:write', cfg),
    scan:  () => ipcRenderer.invoke('config:scan'),
    importKeys: () => ipcRenderer.invoke('config:importKeys'),
  },
  oauth: {
    start:        (provider, opts) => ipcRenderer.invoke('oauth:start', { provider, ...(opts || {}) }),
    exchange:     (sessionId, code) => ipcRenderer.invoke('oauth:exchange', { sessionId, code }),
    poll:         (sessionId) => ipcRenderer.invoke('oauth:poll', { sessionId }),
    openExternal: (url) => ipcRenderer.invoke('oauth:openExternal', { url }),
  },
  claude: {
    configure: (baseUrl, apiKey, models) => ipcRenderer.invoke('claude:configure', { baseUrl, apiKey, models }),
    status: () => ipcRenderer.invoke('claude:status'),
  },
  chatgptWeb: {
    add:       () => ipcRenderer.invoke('chatgptweb:add'),
    remove:    (id) => ipcRenderer.invoke('chatgptweb:remove', id),
    list:      () => ipcRenderer.invoke('chatgptweb:list'),
    status:    (id) => ipcRenderer.invoke('chatgptweb:status', id),
    login:     (id) => ipcRenderer.invoke('chatgptweb:login', id),
    hideLogin: (id) => ipcRenderer.invoke('chatgptweb:hideLogin', id),
    conn:      (id) => ipcRenderer.invoke('chatgptweb:conn', id),
    test:      (id) => ipcRenderer.invoke('chatgptweb:test', id),
  },
  usage: {
    fetch:    (provider) => ipcRenderer.invoke('usage:fetch', { provider }),
    fetchAll: ()         => ipcRenderer.invoke('usage:fetchAll'),
  },
  claude3p: {
    sync: () => ipcRenderer.invoke('claude3p:sync'),
  },
  llm: {
    fetch: (url, options) => ipcRenderer.invoke('llm:fetch', { url, ...options }),
    stream: ({ url, method, headers, body }, onChunk, onDone, onError) => {
      const reqId = Math.random().toString(36).slice(2);
      const onChunkH = (_e, d) => { if (d.reqId === reqId) onChunk(d.data); };
      const onDoneH  = (_e, d) => { if (d.reqId === reqId) { cleanup(); onDone(); } };
      const onErrorH = (_e, d) => { if (d.reqId === reqId) { cleanup(); onError(d.error); } };
      function cleanup() {
        ipcRenderer.removeListener('llm:stream-chunk', onChunkH);
        ipcRenderer.removeListener('llm:stream-done',  onDoneH);
        ipcRenderer.removeListener('llm:stream-error', onErrorH);
      }
      ipcRenderer.on('llm:stream-chunk', onChunkH);
      ipcRenderer.on('llm:stream-done',  onDoneH);
      ipcRenderer.on('llm:stream-error', onErrorH);
      ipcRenderer.send('llm:stream', { reqId, url, method, headers, body });
      return cleanup;
    },
  },
  updater: {
    onAvailable: (cb) => {
      const h = (_e, d) => cb(d);
      ipcRenderer.on('update:available', h);
      return () => ipcRenderer.removeListener('update:available', h);
    },
    onProgress: (cb) => {
      const h = (_e, d) => cb(d);
      ipcRenderer.on('update:progress', h);
      return () => ipcRenderer.removeListener('update:progress', h);
    },
    onDownloaded: (cb) => {
      const h = (_e, d) => cb(d);
      ipcRenderer.on('update:downloaded', h);
      return () => ipcRenderer.removeListener('update:downloaded', h);
    },
    onError: (cb) => {
      const h = (_e, d) => cb(d || {});
      ipcRenderer.on('update:error', h);
      return () => ipcRenderer.removeListener('update:error', h);
    },
    install: () => ipcRenderer.invoke('update:install'),
    getStatus: () => ipcRenderer.invoke('updater:status'),
    getSettings: () => ipcRenderer.invoke('updater:getSettings'),
    setAllowPrerelease: (allow) => ipcRenderer.invoke('updater:setAllowPrerelease', allow),
    checkNow: () => ipcRenderer.invoke('updater:checkNow'),
    onNotAvailable: (cb) => {
      const h = (_e, d) => cb(d || {});
      ipcRenderer.on('update:not-available', h);
      return () => ipcRenderer.removeListener('update:not-available', h);
    },
  },
  gateway: {
    status:          () => ipcRenderer.invoke('gateway:status'),
    getLog:          () => ipcRenderer.invoke('gateway:getLog'),
    cooldowns:       () => ipcRenderer.invoke('gateway:cooldowns'),
    clearCooldown:   (key) => ipcRenderer.invoke('gateway:clearCooldown', key),
    refreshOpenrouterModels: () => ipcRenderer.invoke('openrouter:refreshModels'),
    openrouterModelsStatus:  () => ipcRenderer.invoke('openrouter:modelsStatus'),
    speedMap:        () => ipcRenderer.invoke('gateway:speedMap'),
    probeModel:      (model) => ipcRenderer.invoke('gateway:probeModel', model),
    setStrategy:     (s) => ipcRenderer.invoke('gateway:setStrategy', s),
    testProvider:    (p) => ipcRenderer.invoke('gateway:testProvider', p),
    restart:         () => ipcRenderer.invoke('gateway:restart'),
    refreshPeerModels: () => ipcRenderer.invoke('gateway:refreshPeerModels'),
    setUserAuth:       (jwt) => ipcRenderer.invoke('gateway:setUserAuth', jwt),
  },
  localStats: {
    query: (days) => ipcRenderer.invoke('localStats:query', days),
    modelLatency: (days) => ipcRenderer.invoke('localStats:modelLatency', days),
    todaySummary: () => ipcRenderer.invoke('localStats:todaySummary'),
    compression: (days) => ipcRenderer.invoke('localStats:compression', days),
    appsUsage: (days) => ipcRenderer.invoke('localStats:appsUsage', days),
    // days 数字或 { days, limit }；清理分析等场景需要更高 limit
    skillUsage: (daysOrOpts) => ipcRenderer.invoke('localStats:skillUsage', daysOrOpts),
    toolUsage: (days) => ipcRenderer.invoke('localStats:toolUsage', days),
    mcpUsage: (days) => ipcRenderer.invoke('localStats:mcpUsage', days),
    reassignProviderTier: (providerId, tier) =>
      ipcRenderer.invoke('localStats:reassignProviderTier', providerId, tier),
    onChanged: (cb) => {
      const h = () => cb();
      ipcRenderer.on('localStats:changed', h);
      return () => ipcRenderer.removeListener('localStats:changed', h);
    },
  },
  sessionImport: {
    run: () => ipcRenderer.invoke('sessionImport:run'),
  },
  detectTools: {
    scan: () => ipcRenderer.invoke('detectTools:scan'),
  },
  agents: {
    list:      () => ipcRenderer.invoke('agents:list'),
    apply:     (id) => ipcRenderer.invoke('agents:apply', id),
    revert:    (id) => ipcRenderer.invoke('agents:revert', id),
    applyAll:  () => ipcRenderer.invoke('agents:applyAll'),
    revertAll: () => ipcRenderer.invoke('agents:revertAll'),
  },
  toolsConfig: {
    load:        () => ipcRenderer.invoke('toolsConfig:load'),
    importFile:  () => ipcRenderer.invoke('toolsConfig:importFile'),
    importUrl:   (url, token, opts) => ipcRenderer.invoke('toolsConfig:importUrl', { url, token, replace: !!opts?.replace }),
    syncRemote:  (opts) => ipcRenderer.invoke('toolsConfig:syncRemote', opts || {}),
    reset:       () => ipcRenderer.invoke('toolsConfig:reset'),
  },
  policies: {
    list:   ()                        => ipcRenderer.invoke('policies:list'),
    create: (d)                       => ipcRenderer.invoke('policies:create', d),
    update: (d)                       => ipcRenderer.invoke('policies:update', d),
    delete: (id)                      => ipcRenderer.invoke('policies:delete', id),
  },
  apps: {
    list:          ()       => ipcRenderer.invoke('apps:list'),
    supported:     ()       => ipcRenderer.invoke('apps:supported'),
    npmGlobalInstall: (id)  => ipcRenderer.invoke('apps:npmGlobalInstall', { id }),
    npmGlobalUninstall: (id) => ipcRenderer.invoke('apps:npmGlobalUninstall', { id }),
    stats:         (list)   => ipcRenderer.invoke('apps:stats', list),
    detail:        (app, days) => ipcRenderer.invoke('apps:detail', { app, days }),
    sessionTrace:  (agent_id, session_id) => ipcRenderer.invoke('apps:sessionTrace', { agent_id, session_id }),
    create:        (d)      => ipcRenderer.invoke('apps:create', d),
    update:        (d)      => ipcRenderer.invoke('apps:update', d),
    delete:        (id)     => ipcRenderer.invoke('apps:delete', id),
    regenKey:      (id)     => ipcRenderer.invoke('apps:regenKey', id),
    rescanInstances: ()     => ipcRenderer.invoke('cli:rescanInstances'),
    selectDirectory: ()     => ipcRenderer.invoke('dialog:selectDirectory'),
    scanAccounts:  (tool)   => ipcRenderer.invoke('cli:scanAccounts', tool),
    addInstance:   (opts)   => ipcRenderer.invoke('cli:addInstance', opts),
    accountsUsage: ()       => ipcRenderer.invoke('cli:accountsUsage'),
    ensureShimApp: (d)      => ipcRenderer.invoke('apps:ensureShimApp', d),
    writeEnv:      (env)    => ipcRenderer.invoke('apps:writeEnv', env),
    presets:       ()       => ipcRenderer.invoke('apps:presets'),
    writeConfigFile: (d)    => ipcRenderer.invoke('apps:writeConfigFile', d),
    revertConfigFile: (d)   => ipcRenderer.invoke('apps:revertConfigFile', d),
    handoffTargets: () => ipcRenderer.invoke('apps:handoffTargets'),
    claudeModels:        () => ipcRenderer.invoke('apps:claudeModels'),
    // 配置下发/变更后主进程通知刷新应用列表
    onChanged: (cb) => {
      const h = () => cb();
      ipcRenderer.on('apps:changed', h);
      return () => ipcRenderer.removeListener('apps:changed', h);
    },
  },
  sessions: {
    listAll:  (opts)    => ipcRenderer.invoke('sessions:listAll', opts),
    setMeta:  (payload) => ipcRenderer.invoke('sessions:setMeta', payload),
    export:   (payload) => ipcRenderer.invoke('sessions:export', payload),
    continue: (payload) => ipcRenderer.invoke('sessions:continue', payload),
    launch:   (payload) => ipcRenderer.invoke('sessions:launch', payload),
    knowledgeStart:  (opts)    => ipcRenderer.invoke('sessions:knowledgeStart', opts || {}),
    knowledgeResult: ()        => ipcRenderer.invoke('sessions:knowledgeResult'),
    saveAgentsMd:    (payload) => ipcRenderer.invoke('sessions:saveAgentsMd', payload),
  },
  diagnostics: {
    export:            ()  => ipcRenderer.invoke('diagnostics:export'),
  },
  localConfig: {
    get:               ()  => ipcRenderer.invoke('localConfig:get'),
    createSceneRoute:  (d) => ipcRenderer.invoke('localConfig:createSceneRoute', d),
    updateSceneRoute:  (d) => ipcRenderer.invoke('localConfig:updateSceneRoute', d),
    deleteSceneRoute:  (id) => ipcRenderer.invoke('localConfig:deleteSceneRoute', id),
    createKey:         (d) => ipcRenderer.invoke('localConfig:createKey', d),
    deleteKey:         (id) => ipcRenderer.invoke('localConfig:deleteKey', id),
    bindKey:           (d) => ipcRenderer.invoke('localConfig:bindKey', d),
    setCloudConfig:    (d) => ipcRenderer.invoke('localConfig:setCloudConfig', d),
    getBilling:      ()  => ipcRenderer.invoke('localConfig:getBilling', billingAuth()),
    setBilling:      (d) => ipcRenderer.invoke('localConfig:setBilling', { ...d, ...billingAuth() }),
    resetBilling:    (d) => ipcRenderer.invoke('localConfig:resetBilling', { ...d, ...billingAuth() }),
    getUserAccounts: (opts = {}) => ipcRenderer.invoke('localConfig:getUserAccounts', { ...billingAuth(), ...opts }),
    setUserAccounts: (d) => ipcRenderer.invoke('localConfig:setUserAccounts', { ...d, ...billingAuth() }),
    pushUserAccountsToCloud: () => ipcRenderer.invoke('localConfig:pushUserAccountsToCloud', billingAuth()),
    setLiveCatalog: (payload) => ipcRenderer.invoke('localConfig:setLiveCatalog', payload),
    getProviderCatalog: () => ipcRenderer.invoke('localConfig:getProviderCatalog'),
    getBuiltinCatalog:  () => ipcRenderer.invoke('localConfig:getBuiltinCatalog'),
    syncProviderCatalog: () => ipcRenderer.invoke('localConfig:syncProviderCatalog'),
    onCatalogUpdated: (cb) => {
      const h = () => cb();
      ipcRenderer.on('catalog:updated', h);
      return () => ipcRenderer.removeListener('catalog:updated', h);
    },
    // 服务端配置下发 / 同步后刷新报价
    onBillingChanged: (cb) => {
      const h = () => cb();
      ipcRenderer.on('billing:changed', h);
      return () => ipcRenderer.removeListener('billing:changed', h);
    },
  },
  tray: {
    setLang:      (lang)     => ipcRenderer.send('tray:lang', lang),
    setAuthState: (loggedIn) => ipcRenderer.send('tray:auth', loggedIn),
  },
  app: {
    onNavigate: (cb) => {
      const h = (_e, path) => cb(path);
      ipcRenderer.on('app:navigate', h);
      return () => ipcRenderer.removeListener('app:navigate', h);
    },
  },
});
