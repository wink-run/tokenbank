# Token Bank 独立部署指南

## 快速开始

### 首次部署

```bash
# 1. 准备配置
cp .env.example .env
vim .env  # 编辑必要配置

# 2. 部署服务端（会自动启动postgres）
./deploy.sh server --https --with-deps

# 3. 部署Gateway
./deploy.sh gateway
```

### 更新已运行的服务

```bash
# 仅更新服务端（不重启postgres）
./deploy.sh server

# 仅更新Gateway（不影响服务端）
./deploy.sh gateway

# 从git更新后部署
./deploy.sh server --git-pull
```

---

## 部署范围

| 命令 | 包含服务 | 用途 |
|------|---------|------|
| `./deploy.sh server` | proxy | 更新服务端API |
| `./deploy.sh server --https` | proxy + nginx | 服务端 + HTTPS反代 |
| `./deploy.sh server --with-deps` | postgres + proxy | 首次部署或需要重启数据库 |
| `./deploy.sh gateway` | gateway | 更新Gateway |
| `./deploy.sh gateway --gateway-https` | gateway + nginx-gateway | Gateway + HTTPS反代 |
| `./deploy.sh all` | postgres + proxy + gateway | 全量部署 |

**关键说明：**
- 默认仅重建目标服务，不重启其他服务
- 首次部署server需要 `--with-deps` 启动postgres
- postgres未运行时会提示，不会静默失败

---

## 常见场景

### 场景1: 生产环境更新服务端

```bash
cd /path/to/tokenbank
git pull
./deploy.sh server
# postgres和gateway保持运行，不受影响
```

### 场景2: 更新Gateway前端

```bash
git pull
./deploy.sh gateway
# 服务端完全不受影响
```

### 场景3: 资源受限环境（< 2GB RAM）

**问题**: Gateway的Vite构建占用~1.5GB内存

**方案**: 分步部署，降低并发构建压力

```bash
# 先部署服务端
./deploy.sh server --https --with-deps
# 等待完成后部署Gateway
./deploy.sh gateway
```

**注意**: 这不能完全避免OOM（Gateway本身构建仍可能OOM），但避免了同时构建多个服务。

### 场景4: 从现有部署迁移

```bash
# 1. 备份
docker compose exec postgres pg_dump -U root tokenbank > backup.sql
cp -r gateway-data .backup/

# 2. 使用新脚本重新部署
./deploy.sh all --https
```

---

## 传统命令（向后兼容）

旧的docker compose命令继续有效：

```bash
# 启动服务端 + HTTPS（依赖会自动拉起）
docker compose --profile https up -d

# 启动Gateway
docker compose up -d gateway

# 全部
docker compose up -d
```

---

## 设备网络（证书、地址簿、中继）

用户名下的设备互相直连（`client/electron/mesh/`，WebSocket），云端只负责签设备证书、地址簿和吊销列表（`server/mesh_router.py`）。连不上时先经用户自己的某台设备中继，没有再走 TokenBank 官方中继。设备之间端到端加密，云端和中继都看不到内容。

**服务端环境变量**（`.env`）：

| 变量 | 说明 |
|---|---|
| `MESH_ISSUER_KEY` | 签证书的密钥：32 字节随机数的 hex（`python3 -c "import os;print(os.urandom(32).hex())"`）。多台服务端要配同一把。不配时用 `data/mesh_issuer.key`，第一次用时生成，只适合单实例 |
| `MESH_ISSUER_OLD_KEYS` | 换钥匙时把旧公钥（`kid:x`，逗号分隔）放这里，旧证书到期前仍能互相校验 |
| `MESH_RELAY_URLS` | 官方中继地址，逗号分隔：`wss://<DOMAIN>/mesh/ws`。设备领证书时一起拿到；不填就没有官方中继，只能直连或经自己的设备中继 |
| `MESH_RELAY_ACCESS_TOKEN` | 官方中继拉吊销列表（`/mesh/revoked-endpoints`）时带的令牌，服务端和 `mesh-relay` 用同一个值 |
| `MESH_DIAL_BACK` | 设备上报地址时，云端回拨它的公网地址验证能不能从外面连到（验证过的设备才会被自动选成中继）。默认开，`0` 关掉 |

**官方中继**（可选）：

```bash
docker compose --profile mesh up -d mesh-relay
docker compose --profile https up -d nginx      # nginx 已把 wss://<DOMAIN>/mesh/ws 转给 mesh-relay
```

中继和每个 app 里的中继是同一份代码（`client/electron/mesh/relay-server.js`），每分钟从服务端拉签发公钥和吊销列表；只接持有效设备证书的设备，只在同一账号的设备之间转发。`MESH_RELAY_MAX_PER_USER` 限制每个账号同时连几台（默认 20）。不用 Docker 也能直接跑：

```bash
PORT=8790 MESH_REVOCATIONS_URL=https://<DOMAIN>/mesh/revoked-endpoints MESH_RELAY_ACCESS_TOKEN=<令牌> node client/electron/mesh/relay-server.js
```

设备自己当中继：设备入口默认监听 41750 端口（TCP）。有公网 IP 或做了端口映射的设备，云端回拨验证通过后会被自动选成中继；也可以在 app 的「本机设置」里手动指定。

## 监控和维护

### 查看状态

```bash
docker compose ps
docker compose logs -f proxy
docker compose logs -f gateway
```

### 健康检查

```bash
curl http://localhost:8000/health
curl http://localhost:11431/api/gateway/status
docker compose exec postgres pg_isready -U root -d tokenbank
```

### 备份和恢复

```bash
# 备份数据库
docker compose exec postgres pg_dump -U root tokenbank | gzip > backup.sql.gz

# 恢复
gunzip < backup.sql.gz | docker compose exec -T postgres psql -U root tokenbank

# 配置会自动备份到 .backup/YYYYmmdd-HHMMSS/
```

---

## 故障排查

### 依赖服务未运行

```bash
# 错误: postgres未运行且未指定 --with-deps
# 解决:
docker compose up -d postgres
# 然后重试
./deploy.sh server
```

### 构建内存不足

```bash
# 分步部署
./deploy.sh server
# 等待完成
./deploy.sh gateway

# 或限制并发
docker compose build --memory 1.5g gateway
```

### 配置丢失

```bash
# 查看备份
ls -lt .backup/

# 恢复最新备份
cp .backup/20241112-143000/local-config.json gateway-data/
docker compose restart gateway
```

---

## 参考

- `./deploy.sh --help` - 查看所有选项
- [docker-compose.yml](./docker-compose.yml) - 服务配置
- [.env.example](./.env.example) - 环境变量示例
