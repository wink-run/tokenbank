import React from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App';
import { isElectron } from './api/adapter';
import { installWebBridge } from './api/webBridge';

if (isElectron()) {
  document.documentElement.classList.add('tb-electron');
}

// Docker / CLI：先挂上资产管理与命令行智能体的 bridge，再渲染（桌面版直接跳过）
installWebBridge().finally(() => {
  createRoot(document.getElementById('root')).render(<App />);
});
