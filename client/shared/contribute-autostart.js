'use strict';
// CommonJS 入口。实现在 contribute-autostart.mjs，这样 Vite 能做具名 ESM 导入，
// Electron 主进程和 node:test 继续 require() 这一份。
module.exports = require('./contribute-autostart.mjs');
