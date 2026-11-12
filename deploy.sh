#!/usr/bin/env bash
# Token Bank 独立部署脚本
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info() { echo -e "${GREEN}[✓]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[!]${NC} $1"; }
log_error() { echo -e "${RED}[✗]${NC} $1"; }

usage() {
    cat << 'EOF'
用法: ./deploy.sh <scope> [options]

范围 (scope):
  server    - 仅服务端 (postgres + proxy [+ nginx])
  gateway   - 仅Gateway (gateway [+ nginx-gateway])
  all       - 全部服务

选项:
  --https           - 启用服务端HTTPS反代
  --gateway-https   - 启用Gateway HTTPS反代
  --with-deps       - 同时启动/重启依赖服务（默认不启动，避免干扰）
  --git-pull        - 部署前git pull拉取代码
  -h, --help        - 显示帮助

示例:
  # 首次部署服务端（会自动启动依赖postgres）
  ./deploy.sh server --https --with-deps

  # 更新服务端代码（不重启postgres）
  ./deploy.sh server

  # 从git更新后部署Gateway
  ./deploy.sh gateway --git-pull

  # 全量部署
  ./deploy.sh all --https

说明:
  - 默认仅重建目标服务，不重启已运行的其他服务
  - 首次部署server需要 --with-deps 启动postgres
  - 首次部署缺失依赖时会明确提示
  - 配置文件会备份到 .backup/YYYYmmdd-HHMMSS/
EOF
    exit 0
}

# 解析参数
SCOPE=""
HTTPS=false
GATEWAY_HTTPS=false
WITH_DEPS=false
GIT_PULL=false

while [[ $# -gt 0 ]]; do
    case $1 in
        server|gateway|all) SCOPE="$1"; shift ;;
        --https) HTTPS=true; shift ;;
        --gateway-https) GATEWAY_HTTPS=true; shift ;;
        --with-deps) WITH_DEPS=true; shift ;;
        --git-pull) GIT_PULL=true; shift ;;
        -h|--help) usage ;;
        *) log_error "未知参数: $1"; usage ;;
    esac
done

[[ -z "$SCOPE" ]] && { log_error "必须指定范围: server, gateway 或 all"; usage; }

# 检查docker
if ! command -v docker &> /dev/null; then
    log_error "未找到docker命令"
    exit 1
fi

# Git pull
if [[ "$GIT_PULL" == true ]]; then
    log_info "拉取最新代码..."
    if git pull; then
        log_info "代码已更新"
    else
        log_warn "git pull失败，使用本地代码"
    fi
fi

# 备份配置
backup_config() {
    local backup_dir=".backup/$(date +%Y%m%d-%H%M%S)"
    mkdir -p "$backup_dir"
    
    [[ -f "gateway-data/config.json" ]] && cp gateway-data/config.json "$backup_dir/"
    [[ -f "gateway-data/local-config.json" ]] && cp gateway-data/local-config.json "$backup_dir/"
    [[ -f ".env" ]] && cp .env "$backup_dir/"
    
    log_info "配置已备份到: $backup_dir"
}

# 检查.env
check_env() {
    if [[ ! -f ".env" ]]; then
        log_error ".env 文件不存在"
        log_error "请手动复制: cp .env.example .env 并编辑配置"
        exit 1
    fi
}

# 检查依赖服务是否运行
check_dependency() {
    local dep=$1
    if docker compose ps "$dep" 2>/dev/null | grep -q "Up"; then
        return 0
    else
        return 1
    fi
}

# 部署
deploy() {
    local services=""
    local deps_check=""
    
    case "$SCOPE" in
        server)
            services="proxy"
            deps_check="postgres"
            [[ "$HTTPS" == true ]] && services="$services nginx"
            
            log_info "部署服务端: $services"
            
            if [[ "$WITH_DEPS" == true ]]; then
                services="postgres $services"
                log_info "同时启动依赖: postgres"
            elif ! check_dependency postgres; then
                log_error "postgres未运行且未指定 --with-deps"
                log_error "首次部署请使用: ./deploy.sh server --with-deps"
                log_error "或手动启动: docker compose up -d postgres"
                exit 1
            fi
            ;;
            
        gateway)
            services="gateway"
            [[ "$GATEWAY_HTTPS" == true ]] && services="$services nginx-gateway"
            
            log_info "部署Gateway: $services"
            ;;
            
        all)
            services="postgres proxy gateway"
            [[ "$HTTPS" == true ]] && services="$services nginx"
            [[ "$GATEWAY_HTTPS" == true ]] && services="$services nginx-gateway"
            
            log_info "全量部署: $services"
            ;;
    esac
    
    # 执行部署
    log_info "执行: docker compose up -d --build $services"
    
    if docker compose up -d --build $services; then
        log_info "部署成功"
        echo ""
        docker compose ps
        
        # 显示访问信息
        echo ""
        case "$SCOPE" in
            server)
                log_info "服务端API: http://localhost:8000"
                [[ "$HTTPS" == true ]] && log_info "HTTPS: https://\${DOMAIN}"
                ;;
            gateway)
                log_info "Gateway API: http://localhost:11430/v1"
                log_info "Gateway UI: http://localhost:11431"
                [[ "$GATEWAY_HTTPS" == true ]] && log_info "HTTPS: https://\${GATEWAY_DOMAIN}"
                ;;
            all)
                log_info "服务端API: http://localhost:8000"
                log_info "Gateway API: http://localhost:11430/v1"
                log_info "Gateway UI: http://localhost:11431"
                ;;
        esac
    else
        log_error "部署失败"
        log_error "查看日志: docker compose logs -f $services"
        exit 1
    fi
}

# 主流程
log_info "Token Bank 独立部署"
check_env
backup_config
deploy

log_info "完成"
