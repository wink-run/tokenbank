# Token Bank 部署指南

本文档说明如何独立部署 Token Bank 的服务端和 Gateway，以及如何在资源受限环境中安全更新。

## 架构概览

Token Bank 由两个独立的组件构成：

### 1. 服务端 (Server)
- **PostgreSQL** - 数据库 (端口 5432)
- **API Backend** - FastAPI 后端服务 (端口 8000)
- **Nginx** - 可选的 HTTPS 反向代理 (端口 80/443)

### 2. Gateway (客户端)
- **CLI Gateway** - Node.js 网关服务，包含 Web UI (端口 11430/11431)
- **Nginx Gateway** - 可选的 HTTPS 反向代理 (端口 8080/8443)

**关键特性：**
- 服务端和 Gateway 完全独立，可分别部署和更新
- Gateway 的 Vite 前端构建占用较多内存 (~1.5GB)，在资源受限环境中应避免不必要的重建
- 数据库和配置文件使用持久化卷，更新不影响数据

---

## 快速开始

### 使用部署脚本（推荐）

```bash
# 首次部署服务端
./deploy.sh server --https

# 首次部署 Gateway
./deploy.sh gateway

# 全量部署
./deploy.sh all --https
```

### 直接使用 Docker Compose

```bash
# 服务端
docker compose --profile server up -d --build

# Gateway
docker compose --profile gateway up -d --build

# 全量部署
docker compose --profile server --profile gateway up -d --build

# 带 HTTPS 的服务端（nginx 的 depends_on 会自动启动 proxy 和 postgres）
docker compose --profile https up -d --build
```

---

## 部署场景

### 场景 1: 首次部署

#### 1.1 首次部署服务端

```bash
# 准备环境
cp .env.example .env
# 编辑 .env 配置数据库密码等

# 部署服务端（会自动启动 postgres 和 proxy）
./deploy.sh server

# 或带 HTTPS（需先放置证书到 nginx/certs/）
./deploy.sh server --https
```

**说明：**
- 首次部署会自动创建数据库和持久化卷
- PostgreSQL 健康检查通过后才会启动 API 服务
- `--https` 需要证书文件：`nginx/certs/{fullchain.pem,privkey.pem}`

**端口访问：**
- API: http://localhost:8000
- HTTPS: https://${DOMAIN} (配置见 .env)

#### 1.2 首次部署 Gateway

```bash
# 部署 Gateway
./deploy.sh gateway

# 或带 HTTPS（需先放置证书）
./deploy.sh gateway --gateway-https
```

**说明：**
- 首次启动会自动创建 `gateway-data/local-config.json` 配置文件
- 配置和用量数据持久化在 `gateway_home` 卷和 `gateway-data/` 目录
- Gateway 不依赖服务端的 PostgreSQL，可独立运行

**端口访问：**
- LLM API: http://localhost:11430/v1
- Web UI: http://localhost:11431
- Gateway HTTPS: https://${GATEWAY_DOMAIN}:8443

---

### 场景 2: 更新已运行的服务

**关键原则：**
- 使用 `--no-deps` 标志避免重启无关服务
- 更新前先 git pull 获取最新代码
- 配置文件会自动备份到 `.backup/` 目录

#### 2.1 仅更新服务端代码

```bash
# 拉取代码
git pull

# 仅重建和重启 proxy，不重启 postgres 和 gateway
./deploy.sh server --no-deps

# 或直接用 compose（更精确控制）
docker compose --profile server up -d --build --no-deps proxy
```

**说明：**
- `--no-deps` 确保 PostgreSQL 保持运行，不会中断连接
- Gateway 完全不受影响，继续运行
- 只重建 `proxy` 服务的镜像和容器

**验证：**
```bash
# 检查 proxy 日志
docker compose logs -f proxy

# 确认其他服务未重启
docker compose ps
```

#### 2.2 仅更新 Gateway

```bash
# 拉取代码
git pull

# 仅重建和重启 gateway，不影响服务端
./deploy.sh gateway --no-deps

# 或直接用 compose
docker compose --profile gateway up -d --build --no-deps gateway
```

**说明：**
- Gateway 的 Vite 构建会占用 ~1.5GB 内存
- 服务端（proxy + postgres）完全不受影响
- 配置文件 `gateway-data/{config.json,local-config.json}` 不会被覆盖

**验证：**
```bash
# 检查 gateway 日志
docker compose logs -f gateway

# 测试健康检查
curl http://localhost:11431/api/gateway/status
```

---

### 场景 3: 资源受限环境（< 2GB RAM）

**问题：** 在 1.9GB RAM 无 swap 的环境中，同时构建服务端和 Gateway 会导致 OOM。

**解决方案：** 分步部署，避免并发构建。

#### 3.1 首次部署策略

```bash
# 步骤 1: 先部署服务端（Python 后端构建内存占用小）
./deploy.sh server --https
# 等待完成...

# 步骤 2: 再部署 Gateway（Vite 构建内存占用大）
./deploy.sh gateway
```

#### 3.2 更新策略

```bash
# 仅更新改动的组件

# 如果只改了服务端代码：
git pull
./deploy.sh server --no-deps

# 如果只改了 Gateway 代码：
git pull
./deploy.sh gateway --no-deps

# 如果两者都改了，分步更新：
git pull
./deploy.sh server --no-deps
# 等待完成，内存释放后...
./deploy.sh gateway --no-deps
```

**监控内存：**
```bash
# 实时监控内存使用
watch -n 1 free -h

# 监控 Docker 构建进程
docker stats
```

---

### 场景 4: 完全重建（清理后重新部署）

```bash
# 停止所有服务
docker compose down

# 可选：删除未使用的镜像释放空间（保留卷）
docker system prune -a

# 重新部署
./deploy.sh all --https
```

**注意：** `docker compose down` 不会删除卷，数据库和配置文件会保留。

---

## Docker Compose Profile 说明

| Profile | 包含的服务 | 用途 |
|---------|-----------|------|
| `server` | postgres, proxy | 服务端：数据库 + API 后端 |
| `gateway` | gateway | Gateway：LLM 网关 + Web UI |
| `https` | nginx | 服务端的 HTTPS 反向代理 |
| `gateway-https` | nginx-gateway | Gateway 的 HTTPS 反向代理 |
| `migrate` | migrate | 一次性 SQLite → PostgreSQL 迁移 |

**组合使用：**
```bash
# 服务端 + HTTPS
docker compose --profile server --profile https up -d

# Gateway + HTTPS
docker compose --profile gateway --profile gateway-https up -d

# 全部 + HTTPS
docker compose --profile server --profile gateway --profile https up -d
```

**依赖关系：**
- `nginx` 依赖 `proxy`，会自动启动 `proxy` 和 `postgres`
- `nginx-gateway` 依赖 `gateway`，会自动启动 `gateway`
- 使用 `--profile https` 时无需额外指定 `--profile server`（依赖自动满足）

---

## 常见命令速查

### 查看状态和日志

```bash
# 查看所有服务状态
docker compose ps

# 查看服务端日志
docker compose logs -f proxy
docker compose logs -f postgres

# 查看 Gateway 日志
docker compose logs -f gateway

# 查看最近 100 行日志
docker compose logs --tail=100 proxy
```

### 重启单个服务

```bash
# 重启服务端（不重建镜像）
docker compose restart proxy

# 重启 Gateway（不重建镜像）
docker compose restart gateway

# 重启数据库
docker compose restart postgres
```

### 配置管理

```bash
# 查看当前配置（包括环境变量展开）
docker compose config

# 验证 compose 文件语法
docker compose config -q

# 查看特定 profile 的配置
docker compose --profile server config
```

### 数据库操作

```bash
# 连接到 PostgreSQL
docker compose exec postgres psql -U root -d tokenbank

# 备份数据库
docker compose exec postgres pg_dump -U root tokenbank > backup.sql

# 恢复数据库
cat backup.sql | docker compose exec -T postgres psql -U root -d tokenbank
```

---

## 配置文件保护

### 自动备份

部署脚本会自动备份以下文件到 `.backup/YYYYmmdd_HHMMSS/`：
- `gateway-data/config.json`
- `gateway-data/local-config.json`
- `.env`

### 手动备份

```bash
# 备份 Gateway 配置
mkdir -p .backup
cp -r gateway-data/ .backup/gateway-data-$(date +%Y%m%d)

# 备份数据库
docker compose exec postgres pg_dump -U root tokenbank | gzip > .backup/db-$(date +%Y%m%d).sql.gz
```

### 恢复配置

```bash
# 恢复 Gateway 配置
cp .backup/gateway-data-20241112/config.json gateway-data/
cp .backup/gateway-data-20241112/local-config.json gateway-data/

# 重启 Gateway 生效
docker compose restart gateway
```

---

## 健康检查和验证

### 服务端健康检查

```bash
# PostgreSQL 健康检查
docker compose exec postgres pg_isready -U root -d tokenbank

# API 健康检查
curl http://localhost:8000/health || echo "API 未响应"

# 查看 API 版本
curl http://localhost:8000/api/version
```

### Gateway 健康检查

```bash
# Gateway 状态检查
curl http://localhost:11431/api/gateway/status

# 测试 LLM API 端点
curl http://localhost:11430/v1/models
```

### 完整验证流程

```bash
# 1. 检查所有容器运行状态
docker compose ps

# 2. 检查端口监听
ss -tlnp | grep -E ':(8000|5432|11430|11431)'

# 3. 检查日志无错误
docker compose logs --tail=50 proxy | grep -i error
docker compose logs --tail=50 gateway | grep -i error

# 4. 功能测试
curl -f http://localhost:8000/health && echo "✓ 服务端正常"
curl -f http://localhost:11431/api/gateway/status && echo "✓ Gateway 正常"
```

---

## 故障排查

### 构建失败

**问题：** 内存不足导致 Vite 构建失败

```bash
# 解决方案 1: 限制并发构建
export DOCKER_BUILDKIT=1
docker compose --profile gateway build --memory 1.5g

# 解决方案 2: 使用预构建镜像（如果可用）
./deploy.sh gateway --no-build
```

### 服务无法启动

```bash
# 检查依赖服务状态
docker compose ps postgres

# 检查健康检查状态
docker compose ps proxy

# 查看详细错误
docker compose logs proxy
docker compose logs postgres

# 重新创建容器
docker compose up -d --force-recreate proxy
```

### 端口冲突

```bash
# 检查端口占用
ss -tlnp | grep -E ':(8000|5432|11430|11431)'

# 修改端口（编辑 .env）
POSTGRES_PORT=5433
# 然后重新部署
./deploy.sh server
```

### 配置丢失

```bash
# 从备份恢复
ls -lt .backup/
cp .backup/20241112_143000/local-config.json gateway-data/

# 如果没有备份，重新初始化
rm gateway-data/local-config.json
docker compose restart gateway
# 首次启动会重新创建默认配置
```

---

## 生产环境最佳实践

### 1. 资源分配

```yaml
# 在 docker-compose.yml 中调整资源限制
services:
  proxy:
    deploy:
      resources:
        limits:
          cpus: '2'
          memory: 1G
        reservations:
          cpus: '0.5'
          memory: 512M
```

### 2. 日志管理

```yaml
# 已配置日志轮转
logging:
  driver: "json-file"
  options:
    max-size: "20m"
    max-file: "5"
```

### 3. 定期备份

```bash
# 添加到 crontab
# 每天凌晨 2 点备份数据库
0 2 * * * cd /path/to/tokenbank && docker compose exec -T postgres pg_dump -U root tokenbank | gzip > /backup/db-$(date +\%Y\%m\%d).sql.gz

# 每周备份配置文件
0 3 * * 0 cd /path/to/tokenbank && tar czf /backup/config-$(date +\%Y\%m\%d).tar.gz gateway-data/ .env
```

### 4. 监控和告警

```bash
# 检查服务健康
#!/bin/bash
if ! curl -f http://localhost:8000/health > /dev/null 2>&1; then
    echo "服务端异常" | mail -s "TokenBank Alert" admin@example.com
fi

if ! curl -f http://localhost:11431/api/gateway/status > /dev/null 2>&1; then
    echo "Gateway 异常" | mail -s "TokenBank Alert" admin@example.com
fi
```

### 5. 更新策略

```bash
# 生产更新流程
# 1. 在测试环境验证
# 2. 备份生产数据
# 3. 非高峰期更新
# 4. 分步部署（先服务端，后 Gateway）
# 5. 验证功能正常

# 示例脚本
./scripts/backup-production.sh
git pull
./deploy.sh server --no-deps
# 验证服务端正常后...
./deploy.sh gateway --no-deps
./scripts/verify-production.sh
```

---

## 迁移到独立部署

如果你之前使用 `docker compose --profile https up -d` 部署全部服务，迁移到独立部署：

### 方法 1: 保持现有方式（向后兼容）

```bash
# 旧命令继续有效，nginx 的 depends_on 会自动启动 proxy
docker compose --profile https up -d --build
```

但这样会同时构建服务端，如果只想更新 Gateway：

### 方法 2: 迁移到独立部署

```bash
# 停止现有服务（不删除卷）
docker compose down

# 分步重新部署
./deploy.sh server --https  # 先部署服务端
./deploy.sh gateway          # 再部署 Gateway

# 后续更新只需更新改动的部分
git pull
./deploy.sh server --no-deps  # 只更新服务端
# 或
./deploy.sh gateway --no-deps # 只更新 Gateway
```

---

## 参考链接

- [README.md](./README.md) - 项目总览和功能介绍
- [.env.example](./.env.example) - 环境变量配置示例
- [docker-compose.yml](./docker-compose.yml) - Docker Compose 配置
- [gateway-data/README.md](./gateway-data/README.md) - Gateway 配置说明

---

## 获取帮助

```bash
# 查看部署脚本帮助
./deploy.sh --help

# 查看 Docker Compose 帮助
docker compose --help
docker compose up --help

# 查看服务日志
docker compose logs -f [service_name]
```

如有问题，请查看 [GitHub Issues](https://github.com/wink-run/tokenbank/issues)。
