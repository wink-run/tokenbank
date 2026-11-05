# gateway-data（Docker 持久化目录）

`docker-compose.yml` 将此目录挂载到容器 `/data/.llm-agent`（`HOME=/data`）。请求记录和用量库在子目录 `tokenbank/`，挂到容器 `/data/.tokenbank`，容器重建后仍在。

**无需提前创建 `local-config.json`** — 网关首次启动时会自动生成默认空配置；场景路由、应用、P2P 等均在 Web UI（`:11431`）中配置。

## 自动生成的文件

| 文件 | 说明 |
|------|------|
| `local-config.json` | 场景路由、`apps`、P2P `cloud_config` 等（UI 写入） |
| `config.json` | Agent 贡献节点配置（若使用独立 Agent） |
| `tokenbank/local-stats.db` | 请求用量，重启后保留 |
| `tokenbank/gateway-route-log.json` | 最近路由明细，重启后保留 |

Docker 可通过环境变量 `TOKEN_SERVER_URL` 在首次创建时预填 `cloud_config.url`。

## 可选：结构参考

见 `local-config.json.example`（仅文档用途，安装不必复制）。
