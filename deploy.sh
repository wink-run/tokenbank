#!/usr/bin/env bash
# Token Bank 独立部署脚本
# 用法: ./deploy.sh [server|gateway|all] [options]

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

usage() {
    cat << EOF
用法: $0 <scope> [options]

部署范围 (scope):
  server   - 仅部署服务端 (PostgreSQL + API backend)
  gateway  - 仅部署 Gateway (CLI Gateway + Web UI)
  all      - 部署全部服务 (server + gateway)

选项 (options):
  --https           - 为服务端启用 HTTPS 反向代理 (需要证书)
  --gateway-https   - 为 Gateway 启用 HTTPS 反向代理 (需要证书)
  --build           - 强制重新构建镜像 (默认开启)
  --no-build        - 不重新构建，使用现有镜像
  --pull            - 部署前先拉取最新代码
  --no-deps         - 不启动/重启依赖服务（仅更新目标服务）
  -h, --help        - 显示此帮助信息

示例:
  # 首次部署服务端（会自动启动 postgres）
  $0 server --https

  # 仅更新服务端代码（不重启数据库）
  $0 server --no-deps

  # 首次部署 Gateway
  $0 gateway

  # 仅更新 Gateway（不影响服务端）
  $0 gateway --no-deps

  # 全量部署
  $0 all --https

  # 从 git 拉取最新代码后部署
  $0 server --pull

注意事项:
  - 首次部署某个 scope 时，不要使用 --no-deps，否则依赖服务不会启动
  - 运行中更新时使用 --no-deps 可避免重启无关服务
  - gateway-data/config.json 和 local-config.json 不会被覆盖
  - 使用 --https 前需在 nginx/certs/ 放置证书文件
  - 部署前会自动备份配置文件到 .backup/

EOF
    exit 0
}

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# 解析参数
SCOPE=""
BUILD_FLAG="--build"
NO_DEPS_FLAG=""
PULL_FLAG=false
HTTPS_FLAG=""
GATEWAY_HTTPS_FLAG=""

while [[ $# -gt 0 ]]; do
    case $1 in
        server|gateway|all)
            SCOPE="$1"
            shift
            ;;
        --https)
            HTTPS_FLAG="--profile https"
            shift
            ;;
        --gateway-https)
            GATEWAY_HTTPS_FLAG="--profile gateway-https"
            shift
            ;;
        --build)
            BUILD_FLAG="--build"
            shift
            ;;
        --no-build)
            BUILD_FLAG=""
            shift
            ;;
        --pull)
            PULL_FLAG=true
            shift
            ;;
        --no-deps)
            NO_DEPS_FLAG="--no-deps"
            shift
            ;;
        -h|--help)
            usage
            ;;
        *)
            log_error "未知参数: $1"
            usage
            ;;
    esac
done

if [[ -z "$SCOPE" ]]; then
    log_error "必须指定部署范围: server, gateway 或 all"
    usage
fi

# 检查 docker compose
if ! command -v docker &> /dev/null; then
    log_error "未找到 docker 命令，请先安装 Docker"
    exit 1
fi

# 拉取代码
if [[ "$PULL_FLAG" == true ]]; then
    log_info "拉取最新代码..."
    git pull || log_warn "git pull 失败，继续使用本地代码"
fi

# 备份配置文件
backup_config() {
    local backup_dir=".backup/$(date +%Y%m%d_%H%M%S)"
    mkdir -p "$backup_dir"
    
    if [[ -f "gateway-data/config.json" ]]; then
        log_info "备份 gateway-data/config.json"
        cp gateway-data/config.json "$backup_dir/"
    fi
    
    if [[ -f "gateway-data/local-config.json" ]]; then
        log_info "备份 gateway-data/local-config.json"
        cp gateway-data/local-config.json "$backup_dir/"
    fi
    
    if [[ -f ".env" ]]; then
        log_info "备份 .env"
        cp .env "$backup_dir/"
    fi
    
    log_info "配置已备份到: $backup_dir"
}

# 验证 HTTPS 证书
check_https_certs() {
    if [[ -n "$HTTPS_FLAG" ]] && [[ ! -f "nginx/certs/fullchain.pem" || ! -f "nginx/certs/privkey.pem" ]]; then
        log_error "启用 HTTPS 需要证书文件: nginx/certs/{fullchain.pem,privkey.pem}"
        exit 1
    fi
    
    if [[ -n "$GATEWAY_HTTPS_FLAG" ]] && [[ ! -f "nginx/certs/gateway-fullchain.pem" || ! -f "nginx/certs/gateway-privkey.pem" ]]; then
        log_error "启用 Gateway HTTPS 需要证书文件: nginx/certs/{gateway-fullchain.pem,gateway-privkey.pem}"
        exit 1
    fi
}

# 验证配置文件
check_env_file() {
    if [[ ! -f ".env" ]]; then
        log_warn ".env 文件不存在，从 .env.example 复制"
        cp .env.example .env
        log_warn "请编辑 .env 文件配置必要参数后再次运行"
        exit 1
    fi
}

# 执行部署
deploy() {
    local profile=""
    local services=""
    
    case "$SCOPE" in
        server)
            profile="--profile server"
            if [[ -n "$NO_DEPS_FLAG" ]]; then
                services="proxy"
                log_info "仅更新服务端 (proxy)，不重启数据库"
            else
                log_info "部署服务端 (PostgreSQL + proxy)"
            fi
            ;;
        gateway)
            profile="--profile gateway"
            if [[ -n "$NO_DEPS_FLAG" ]]; then
                services="gateway"
                log_info "仅更新 Gateway，不影响其他服务"
            else
                log_info "部署 Gateway"
            fi
            ;;
        all)
            profile="--profile server --profile gateway"
            log_info "全量部署 (server + gateway)"
            ;;
    esac
    
    # 组合完整命令
    local cmd="docker compose $profile $HTTPS_FLAG $GATEWAY_HTTPS_FLAG up -d $BUILD_FLAG $NO_DEPS_FLAG $services"
    
    log_info "执行命令: $cmd"
    
    # 执行部署
    if eval "$cmd"; then
        log_info "部署成功！"
        
        # 显示服务状态
        log_info "服务状态:"
        docker compose ps
        
        # 显示访问信息
        case "$SCOPE" in
            server)
                log_info "服务端 API: http://localhost:8000"
                if [[ -n "$HTTPS_FLAG" ]]; then
                    log_info "HTTPS 访问: https://\${DOMAIN} (参见 .env 配置)"
                fi
                ;;
            gateway)
                log_info "Gateway LLM API: http://localhost:11430/v1"
                log_info "Gateway Web UI: http://localhost:11431"
                if [[ -n "$GATEWAY_HTTPS_FLAG" ]]; then
                    log_info "Gateway HTTPS: https://\${GATEWAY_DOMAIN} (参见 .env 配置)"
                fi
                ;;
            all)
                log_info "服务端 API: http://localhost:8000"
                log_info "Gateway LLM API: http://localhost:11430/v1"
                log_info "Gateway Web UI: http://localhost:11431"
                ;;
        esac
        
        # 健康检查提示
        if [[ -z "$NO_DEPS_FLAG" ]]; then
            log_info "等待服务健康检查..."
            sleep 3
            docker compose ps
        fi
    else
        log_error "部署失败！"
        log_error "查看日志: docker compose logs -f"
        exit 1
    fi
}

# 主流程
log_info "Token Bank 独立部署工具"
log_info "部署范围: $SCOPE"

# 检查环境
check_env_file
check_https_certs

# 备份配置
backup_config

# 执行部署
deploy

log_info "完成！"
