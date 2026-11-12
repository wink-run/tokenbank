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
