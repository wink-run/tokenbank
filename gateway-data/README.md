# gateway-data（Docker 持久化目录）

`docker-compose.yml` 将此目录挂载到容器 `/data/.llm-agent`（`HOME=/data`）。请求记录和用量库在子目录 `tokenbank/`，挂到容器 `/data/.tokenbank`，容器重建后仍在。

**无需提前创建 `local-config.json`** — 网关首次启动时会自动生成默认空配置；场景路由、应用、P2P 等均在 Web UI（`:11431`）中配置。

## 自动生成的文件

| 文件 | 说明 |
|------|------|
| `local-config.json` | 场景路由、`apps`、P2P `cloud_config` 等（UI 写入，不入库） |
| `config.json` | Agent 贡献节点配置，含本机 `device_id`（不入库） |
| `tokenbank/local-stats.db` | 请求用量，重启后保留 |
| `tokenbank/gateway-route-log.json` | 最近路由明细，重启后保留 |

Docker 可通过环境变量 `TOKEN_SERVER_URL` 在首次创建时预填 `cloud_config.url`。这两个 JSON 已在 `.gitignore` 中，避免各环境共用同一 `device_id`。
