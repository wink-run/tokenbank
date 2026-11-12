#!/usr/bin/env bash
# Token Bank 部署配置验证脚本

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info() {
    echo -e "${GREEN}[✓]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[!]${NC} $1"
}

log_error() {
    echo -e "${RED}[✗]${NC} $1"
}

test_result=0

echo "=========================================="
echo "Token Bank 部署配置验证"
echo "=========================================="
echo ""

# 1. 检查 Docker Compose 可用性
echo "1. 检查 Docker Compose..."
if command -v docker &> /dev/null && docker compose version &> /dev/null; then
    log_info "Docker Compose 可用: $(docker compose version --short)"
else
    log_warn "Docker Compose 不可用，跳过 Docker 相关测试"
    DOCKER_AVAILABLE=false
fi

# 2. 验证 compose 文件语法
echo ""
echo "2. 验证 docker-compose.yml 语法..."
if [[ "$DOCKER_AVAILABLE" != "false" ]]; then
    if docker compose config -q; then
        log_info "docker-compose.yml 语法正确"
    else
        log_error "docker-compose.yml 语法错误"
        test_result=1
    fi
else
    log_warn "跳过 Docker Compose 语法检查"
fi

# 3. 检查部署脚本语法
echo ""
echo "3. 检查部署脚本语法..."
if bash -n deploy.sh; then
    log_info "deploy.sh 语法正确"
else
    log_error "deploy.sh 语法错误"
    test_result=1
fi

# 4. 测试各个 profile 的服务选择
echo ""
echo "4. 测试各个 profile 的服务选择..."

if [[ "$DOCKER_AVAILABLE" != "false" ]]; then
    # 4.1 server profile
    echo "   4.1 测试 --profile server"
    services=$(docker compose --profile server config --services | sort)
    expected="migrate
nginx
nginx-gateway
postgres
proxy"
    if [[ "$services" == "$expected" ]]; then
        log_info "server profile 包含正确的服务: postgres, proxy"
    else
        log_error "server profile 服务不符合预期"
        echo "期望: postgres, proxy"
        echo "实际: $services"
        test_result=1
    fi

    # 4.2 gateway profile
    echo "   4.2 测试 --profile gateway"
    services=$(docker compose --profile gateway config --services | sort)
    expected="gateway
migrate
nginx
nginx-gateway
postgres
proxy"
    if [[ "$services" == "$expected" ]]; then
        log_info "gateway profile 包含正确的服务: gateway"
    else
        log_error "gateway profile 服务不符合预期"
        echo "期望: gateway"
        echo "实际: $services"
        test_result=1
    fi

    # 4.3 https profile
    echo "   4.3 测试 --profile https"
    services=$(docker compose --profile https config --services | sort)
    expected="gateway
migrate
nginx
nginx-gateway
postgres
proxy"
    if [[ "$services" == "$expected" ]]; then
        log_info "https profile 包含正确的服务: nginx (+ 依赖的 proxy, postgres)"
    else
        log_error "https profile 服务不符合预期"
        echo "实际: $services"
        test_result=1
    fi

    # 4.4 组合 profile
    echo "   4.4 测试 --profile server --profile gateway"
    services=$(docker compose --profile server --profile gateway config --services | sort)
    expected="gateway
migrate
nginx
nginx-gateway
postgres
proxy"
    if [[ "$services" == "$expected" ]]; then
        log_info "server+gateway profile 包含所有核心服务"
    else
        log_error "server+gateway profile 服务不符合预期"
        echo "实际: $services"
        test_result=1
    fi
else
    log_warn "跳过 profile 测试"
fi

# 5. 检查必要文件存在
echo ""
echo "5. 检查必要文件..."
files=(
    "docker-compose.yml"
    "deploy.sh"
    "DEPLOY.md"
    ".env.example"
    "server/Dockerfile"
    "client/Dockerfile.cli"
)

for file in "${files[@]}"; do
    if [[ -f "$file" ]]; then
        log_info "$file 存在"
    else
        log_error "$file 不存在"
        test_result=1
    fi
done

# 6. 检查 deploy.sh 可执行
echo ""
echo "6. 检查 deploy.sh 权限..."
if [[ -x "deploy.sh" ]]; then
    log_info "deploy.sh 可执行"
else
    log_warn "deploy.sh 不可执行，自动添加权限"
    chmod +x deploy.sh
    log_info "已添加可执行权限"
fi

# 7. 模拟命令测试（dry-run）
echo ""
echo "7. 模拟部署命令测试..."

if [[ "$DOCKER_AVAILABLE" != "false" ]]; then
    echo "   7.1 测试 server 部署命令"
    if docker compose --profile server config --services > /dev/null 2>&1; then
        log_info "docker compose --profile server up -d --build [模拟成功]"
    else
        log_error "server 部署命令配置错误"
        test_result=1
    fi

    echo "   7.2 测试 gateway 部署命令"
    if docker compose --profile gateway config --services > /dev/null 2>&1; then
        log_info "docker compose --profile gateway up -d --build [模拟成功]"
    else
        log_error "gateway 部署命令配置错误"
        test_result=1
    fi

    echo "   7.3 测试 --no-deps 命令"
    if docker compose --profile server config --services > /dev/null 2>&1; then
        log_info "docker compose --profile server up -d --build --no-deps proxy [模拟成功]"
    else
        log_error "server --no-deps 部署命令配置错误"
        test_result=1
    fi
else
    log_warn "跳过命令模拟测试"
fi

# 8. 检查服务依赖关系
echo ""
echo "8. 检查服务依赖关系..."

if [[ "$DOCKER_AVAILABLE" != "false" ]]; then
    # 检查 proxy 依赖 postgres
    if docker compose config | grep -A5 "^  proxy:" | grep -q "postgres:"; then
        log_info "proxy 正确依赖 postgres"
    else
        log_error "proxy 未依赖 postgres"
        test_result=1
    fi

    # 检查 nginx 依赖 proxy
    if docker compose config | grep -A10 "^  nginx:" | grep -q "proxy"; then
        log_info "nginx 正确依赖 proxy"
    else
        log_error "nginx 未依赖 proxy"
        test_result=1
    fi

    # 检查 gateway 不依赖 proxy（独立）
    if ! docker compose config | grep -A10 "^  gateway:" | grep -q "proxy"; then
        log_info "gateway 独立于 proxy（不依赖）"
    else
        log_warn "gateway 似乎依赖 proxy，可能影响独立部署"
    fi
else
    log_warn "跳过依赖关系检查"
fi

# 9. 检查 profile 配置
echo ""
echo "9. 检查 profile 配置..."

if [[ "$DOCKER_AVAILABLE" != "false" ]]; then
    # 检查 proxy 有 server profile
    if docker compose config | grep -A5 "^  proxy:" | grep -q "profiles:"; then
        log_info "proxy 配置了 profile"
    else
        log_error "proxy 缺少 profile 配置"
        test_result=1
    fi

    # 检查 gateway 有 gateway profile
    if docker compose config | grep -A5 "^  gateway:" | grep -q "profiles:"; then
        log_info "gateway 配置了 profile"
    else
        log_error "gateway 缺少 profile 配置"
        test_result=1
    fi
else
    log_warn "跳过 profile 配置检查"
fi

# 10. 文档一致性检查
echo ""
echo "10. 检查文档一致性..."

# 检查 DEPLOY.md 提到的关键命令
if grep -q "./deploy.sh server" DEPLOY.md && \
   grep -q "./deploy.sh gateway" DEPLOY.md && \
   grep -q "\-\-no-deps" DEPLOY.md; then
    log_info "DEPLOY.md 包含关键部署命令说明"
else
    log_error "DEPLOY.md 缺少关键命令说明"
    test_result=1
fi

# 检查 README.md 更新
if grep -q "独立部署" README.md && grep -q "DEPLOY.md" README.md; then
    log_info "README.md 已更新独立部署说明"
else
    log_error "README.md 未更新独立部署说明"
    test_result=1
fi

# 检查中文 README
if grep -q "独立部署" README.zh-CN.md && grep -q "DEPLOY.md" README.zh-CN.md; then
    log_info "README.zh-CN.md 已更新独立部署说明"
else
    log_error "README.zh-CN.md 未更新独立部署说明"
    test_result=1
fi

# 总结
echo ""
echo "=========================================="
if [[ $test_result -eq 0 ]]; then
    echo -e "${GREEN}验证通过！部署配置正确。${NC}"
    echo ""
    echo "你可以使用以下命令部署："
    echo "  ./deploy.sh server --https  # 部署服务端"
    echo "  ./deploy.sh gateway         # 部署 Gateway"
    echo "  ./deploy.sh all             # 全量部署"
    echo ""
    echo "详细说明见 DEPLOY.md"
else
    echo -e "${RED}验证失败！请检查上述错误。${NC}"
fi
echo "=========================================="

exit $test_result
