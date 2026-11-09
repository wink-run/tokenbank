// 本机网关地址：智能功能（一句话生成、自动打标签、闲置判断等）统一从这里取，不再各写一份。
// 桌面版读网关状态里的端口；Docker / Web 版没有 gateway.status，用默认口（经 bridge 在容器内访问）。
export async function resolveGatewayBase() {
  let base = 'http://127.0.0.1:11430';
  if (!window.electronAPI?.gateway?.status) return base;
  try {
    const st = await window.electronAPI.gateway.status();
    const port = st?.port || st?.listenPort || st?.localPort;
    if (port) base = `http://127.0.0.1:${port}`;
    else if (st?.url || st?.baseUrl) base = String(st.url || st.baseUrl).replace(/\/$/, '');
  } catch { /* 默认口 */ }
  return base;
}
