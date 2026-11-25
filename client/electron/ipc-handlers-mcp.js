// client/electron/ipc-handlers-mcp.js
// MCP 供给源 IPC 处理器
'use strict';

const { ipcMain } = require('electron');
const mcpManager = require('./mcp-manager');
const { MCP_CATEGORY_GROUPS } = require('./mcp-catalog');

function registerMcpHandlers() {
  ipcMain.handle('mcp:listServers', async () => {
    try {
      mcpManager.init();
      return { success: true, servers: mcpManager.listServers() };
    } catch (error) {
      console.error('[IPC] mcp:listServers error:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('mcp:listCatalog', async () => {
    try {
      mcpManager.init();
      return {
        success: true,
        catalog: mcpManager.listCatalog(),
        grouped: mcpManager.listCatalogGrouped(),
        categoryLabels: MCP_CATEGORY_GROUPS,
      };
    } catch (error) {
      console.error('[IPC] mcp:listCatalog error:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('mcp:installCatalog', async (_event, { catalogId, config }) => {
    try {
      mcpManager.init();
      const result = mcpManager.installFromCatalog(catalogId, config || {});
      return result;
    } catch (error) {
      console.error('[IPC] mcp:installCatalog error:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('mcp:uninstallServer', async (_event, serverId) => {
    try {
      mcpManager.init();
      return mcpManager.uninstallServer(serverId);
    } catch (error) {
      console.error('[IPC] mcp:uninstallServer error:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('mcp:setServerStatus', async (_event, { serverId, status }) => {
    try {
      mcpManager.init();
      return mcpManager.setServerStatus(serverId, status);
    } catch (error) {
      console.error('[IPC] mcp:setServerStatus error:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('mcp:saveServer', async (_event, data) => {
    try {
      mcpManager.init();
      return mcpManager.saveServer(data || {});
    } catch (error) {
      console.error('[IPC] mcp:saveServer error:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('mcp:listProfiles', async () => {
    try {
      mcpManager.init();
      return { success: true, profiles: mcpManager.listProfiles() };
    } catch (error) {
      console.error('[IPC] mcp:listProfiles error:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('mcp:getProfile', async (_event, profileId) => {
    try {
      mcpManager.init();
      const profile = mcpManager.getProfile(profileId);
      if (!profile) return { success: false, error: 'Profile not found' };
      return { success: true, profile };
    } catch (error) {
      console.error('[IPC] mcp:getProfile error:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('mcp:saveProfile', async (_event, { profileId, ...patch }) => {
    try {
      mcpManager.init();
      return mcpManager.saveProfile(profileId, patch);
    } catch (error) {
      console.error('[IPC] mcp:saveProfile error:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('mcp:syncClients', async (_event, options = {}) => {
    try {
      mcpManager.init();
      const result = mcpManager.syncToClients(options);
      return {
        success: true,
        ...result,
        hint: require('./mcp-client-sync').getPostSyncHint({
          clientIds: options.clientIds,
          results: result.results,
        }),
      };
    } catch (error) {
      console.error('[IPC] mcp:syncClients error:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('mcp:setServerSyncClients', async (_event, params = {}) => {
    try {
      mcpManager.init();
      const { serverId, clientIds, syncClientIds } = params;
      return mcpManager.setServerSyncClients(serverId, clientIds, { syncClientIds });
    } catch (error) {
      console.error('[IPC] mcp:setServerSyncClients error:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('mcp:toggleServerSyncClient', async (_event, { serverId, clientId }) => {
    try {
      mcpManager.init();
      return mcpManager.toggleServerSyncClient(serverId, clientId);
    } catch (error) {
      console.error('[IPC] mcp:toggleServerSyncClient error:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('mcp:removeFromAgent', async (_event, params) => {
    try {
      mcpManager.init();
      return mcpManager.removeFromAgent(params || {});
    } catch (error) {
      console.error('[IPC] mcp:removeFromAgent error:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('mcp:importFromClient', async (_event, { clientKey }) => {
    try {
      mcpManager.init();
      return mcpManager.importFromClient(clientKey);
    } catch (error) {
      console.error('[IPC] mcp:importFromClient error:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('mcp:importFromAgent', async (_event, params = {}) => {
    try {
      mcpManager.init();
      return mcpManager.importFromAgent(params || {});
    } catch (error) {
      console.error('[IPC] mcp:importFromAgent error:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('mcp:getSyncStatus', async () => {
    try {
      mcpManager.init();
      return { success: true, ...mcpManager.getClientSyncStatus() };
    } catch (error) {
      console.error('[IPC] mcp:getSyncStatus error:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('mcp:listAgentInstallations', async () => {
    try {
      mcpManager.init();
      return { success: true, ...mcpManager.listAgentInstallations() };
    } catch (error) {
      console.error('[IPC] mcp:listAgentInstallations error:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('mcp:setServerGatewayRouted', async (_event, { serverId, enabled, clientIds }) => {
    try {
      mcpManager.init();
      return mcpManager.setServerGatewayRouted(serverId, !!enabled, clientIds);
    } catch (error) {
      console.error('[IPC] mcp:setServerGatewayRouted error:', error);
      return { success: false, error: error.message };
    }
  });

  // 应用专属：owner 为空 = 取消
  ipcMain.handle('mcp:setServerExclusive', async (_event, { serverId, owner } = {}) => {
    try {
      mcpManager.init();
      return mcpManager.setServerExclusive(serverId, owner || '');
    } catch (error) {
      console.error('[IPC] mcp:setServerExclusive error:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('mcp:setServersGatewayRouted', async (_event, { serverIds, enabled, clientIds }) => {
    try {
      mcpManager.init();
      return mcpManager.setServersGatewayRouted(serverIds || [], !!enabled, clientIds);
    } catch (error) {
      console.error('[IPC] mcp:setServersGatewayRouted error:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('mcp:getGatewayInfo', async () => {
    try {
      mcpManager.init();
      return { success: true, ...mcpManager.getGatewayInfo() };
    } catch (error) {
      console.error('[IPC] mcp:getGatewayInfo error:', error);
      return { success: false, error: error.message };
    }
  });

  // 本机各应用用 Token Bank 工具的权限（off / read / operate / full，没设过是 full）
  ipcMain.handle('mcp:appLevels', async () => {
    try {
      const access = require('./mcp-access');
      return { success: true, levels: access.appLevels(), defaultLevel: access.DEFAULT_APP_LEVEL };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('mcp:setAppLevel', async (_event, { clientId, level } = {}) => {
    try {
      return { success: true, level: require('./mcp-access').setAppLevel(clientId, level) };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });
}

module.exports = { registerMcpHandlers };
