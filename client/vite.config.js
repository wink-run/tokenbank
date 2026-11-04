import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { DEFAULT_TOKEN_SERVER_URL } = require('./shared/default-server-url.js');

const DEV_API_PROXY_PREFIX = '/__tokenbank_api__';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  // 构建时 TOKEN_SERVER_URL → 前端默认服务地址
  const tokenServerUrl = env.TOKEN_SERVER_URL || env.VITE_TOKEN_SERVER_URL || DEFAULT_TOKEN_SERVER_URL;

  return {
    plugins: [react()],
    base: './',
    build: { outDir: 'dist' },
    server: {
      port: 5173,
      // 端口被占用时直接失败，避免 Vite 静默换端口而 Electron 仍连 5173 导致白屏
      strictPort: true,
      // 开发态不缓存页面和脚本，改完下拉后刷新就能看到
      headers: { 'Cache-Control': 'no-store' },
      // 浏览器 dev 直连远程 API 会触发 CORS，经同源代理转发
      proxy: {
        [DEV_API_PROXY_PREFIX]: {
          target: tokenServerUrl,
          changeOrigin: true,
          secure: true,
          rewrite: (path) => path.replace(new RegExp(`^${DEV_API_PROXY_PREFIX}`), ''),
        },
      },
    },
    define: {
      'import.meta.env.VITE_TOKEN_SERVER_URL': JSON.stringify(tokenServerUrl),
    },
  };
});
