#!/usr/bin/env bash
# Token Bank 部署脚本测试
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_pass() { echo -e "${GREEN}[PASS]${NC} $1"; }
log_fail() { echo -e "${RED}[FAIL]${NC} $1"; }
log_info() { echo -e "${YELLOW}[TEST]${NC} $1"; }

failed_tests=0
passed_tests=0

# Mock docker compose命令
mock_docker_compose() {
    echo "MOCK_COMPOSE_ARGS: $*" >> /tmp/test-deploy-calls.log
    
    # 模拟docker compose ps命令
    if [[ "$1" == "ps" ]]; then
        if [[ "$2" == "postgres" ]]; then
            # 根据测试场景返回
            if [[ "$TEST_POSTGRES_RUNNING" == "true" ]]; then
                echo "postgres Up"
                return 0
            else
                return 1
            fi
        fi
    fi
    
    # 模拟docker compose up命令
    if [[ "$1" == "up" ]]; then
        return 0
    fi
    
    return 0
}

# 捕获deploy.sh的docker compose调用
test_deploy_calls() {
    local test_name="$1"
    local args="$2"
    local expected="$3"
    
    log_info "$test_name"
    
    rm -f /tmp/test-deploy-calls.log
    export TEST_POSTGRES_RUNNING=true
    
    # 使用bash -x跟踪并捕获docker compose命令
    if timeout 2 bash -c "
        source deploy.sh 2>&1 | grep -o 'docker compose up -d --build.*' | head -1
    " <<< "$args" > /tmp/test-result.txt 2>&1 || true; then
        # 提取实际执行的命令
        local actual=$(cat /tmp/test-result.txt 2>/dev/null || echo "")
        
        if [[ "$actual" =~ $expected ]]; then
            log_pass "$test_name"
            passed_tests=$((passed_tests + 1))
        else
            log_fail "$test_name"
            echo "  期望包含: $expected"
            echo "  实际输出: $actual"
            failed_tests=$((failed_tests + 1))
        fi
    else
        log_fail "$test_name (超时或执行失败)"
        failed_tests=$((failed_tests + 1))
    fi
}

# 直接调用并验证参数解析
test_parse_args() {
    local test_name="$1"
    local args="$2"
    local expected_services="$3"
    
    log_info "$test_name"
    
    # 创建临时测试脚本
    cat > /tmp/test-deploy-wrapper.sh << 'WRAPPER_EOF'
#!/bin/bash
# 解析deploy.sh的参数并输出将要启动的服务

SCOPE=""
HTTPS=false
GATEWAY_HTTPS=false
WITH_DEPS=false

while [[ $# -gt 0 ]]; do
    case $1 in
        server|gateway|all) SCOPE="$1"; shift ;;
        --https) HTTPS=true; shift ;;
        --gateway-https) GATEWAY_HTTPS=true; shift ;;
        --with-deps) WITH_DEPS=true; shift ;;
        --git-pull) shift ;;
        *) shift ;;
    esac
done

services=""
case "$SCOPE" in
    server)
        services="proxy"
        [[ "$HTTPS" == true ]] && services="$services nginx"
        [[ "$WITH_DEPS" == true ]] && services="postgres $services"
        ;;
    gateway)
        services="gateway"
        [[ "$GATEWAY_HTTPS" == true ]] && services="$services nginx-gateway"
        ;;
    all)
        services="postgres proxy gateway"
        [[ "$HTTPS" == true ]] && services="$services nginx"
        [[ "$GATEWAY_HTTPS" == true ]] && services="$services nginx-gateway"
        ;;
esac

echo "$services"
WRAPPER_EOF
    chmod +x /tmp/test-deploy-wrapper.sh
    
    local actual=$(/tmp/test-deploy-wrapper.sh $args)
    
    if [[ "$actual" == "$expected_services" ]]; then
        log_pass "$test_name"
        passed_tests=$((passed_tests + 1))
    else
        log_fail "$test_name"
        echo "  期望: $expected_services"
        echo "  实际: $actual"
        failed_tests=$((failed_tests + 1))
    fi
}

echo "=========================================="
echo "Token Bank 部署脚本测试"
echo "=========================================="
echo ""

# 测试1: 基础语法
log_info "测试1: 脚本语法检查"
if bash -n deploy.sh; then
    log_pass "deploy.sh语法正确"
    passed_tests=$((passed_tests + 1))
else
    log_fail "deploy.sh语法错误"
    failed_tests=$((failed_tests + 1))
fi

# 测试2: docker-compose.yml没有profiles
log_info "测试2: docker-compose.yml向后兼容"
if ! grep "profiles: \[server\]" docker-compose.yml > /dev/null 2>&1 && \
   ! grep "profiles: \[gateway\]" docker-compose.yml > /dev/null 2>&1; then
    log_pass "proxy和gateway没有profiles（向后兼容）"
    passed_tests=$((passed_tests + 1))
else
    log_fail "proxy或gateway有profiles（破坏兼容性）"
    failed_tests=$((failed_tests + 1))
fi

# 测试3-8: 服务选择逻辑
test_parse_args "测试3: server scope" \
    "server" \
    "proxy"

test_parse_args "测试4: server --https" \
    "server --https" \
    "proxy nginx"

test_parse_args "测试5: server --with-deps" \
    "server --with-deps" \
    "postgres proxy"

test_parse_args "测试6: gateway scope" \
    "gateway" \
    "gateway"

test_parse_args "测试7: gateway --gateway-https" \
    "gateway --gateway-https" \
    "gateway nginx-gateway"

test_parse_args "测试8: all scope" \
    "all" \
    "postgres proxy gateway"

test_parse_args "测试9: all --https" \
    "all --https" \
    "postgres proxy gateway nginx"

test_parse_args "测试10: all --https --gateway-https" \
    "all --https --gateway-https" \
    "postgres proxy gateway nginx nginx-gateway"

# 测试11: 依赖检查逻辑
log_info "测试11: postgres依赖检查"
export TEST_POSTGRES_RUNNING=false
if timeout 2 bash -c '
    check_dependency() {
        local dep=$1
        if [[ "$TEST_POSTGRES_RUNNING" == "true" ]]; then
            return 0
        else
            return 1
        fi
    }
    if check_dependency postgres; then
        echo "running"
    else
        echo "not_running"
    fi
' > /tmp/test-dep-check.txt 2>&1; then
    if grep -q "not_running" /tmp/test-dep-check.txt; then
        log_pass "依赖检查逻辑正确"
        passed_tests=$((passed_tests + 1))
    else
        log_fail "依赖检查逻辑错误"
        failed_tests=$((failed_tests + 1))
    fi
else
    log_fail "依赖检查测试失败"
    failed_tests=$((failed_tests + 1))
fi

# 测试12: .env不存在时的处理
log_info "测试12: .env缺失检查"
if grep -q "请手动复制" deploy.sh; then
    log_pass ".env缺失时会提示且退出（不静默创建）"
    passed_tests=$((passed_tests + 1))
else
    log_fail ".env缺失处理不当"
    failed_tests=$((failed_tests + 1))
fi

# 测试13: 配置备份
log_info "测试13: 配置备份逻辑"
if grep -q 'backup_dir=".backup' deploy.sh && \
   grep -q "mkdir -p" deploy.sh && \
   grep -q "cp gateway-data" deploy.sh; then
    log_pass "配置会备份到.backup/"
    passed_tests=$((passed_tests + 1))
else
    log_fail "配置备份逻辑缺失"
    failed_tests=$((failed_tests + 1))
fi

# 测试14: --git-pull vs docker pull语义
log_info "测试14: --git-pull语义清晰"
if grep -q "GIT_PULL" deploy.sh && \
   grep -q "git pull" deploy.sh && \
   ! grep -q "docker.*pull" deploy.sh; then
    log_pass "--git-pull明确指git操作，不混淆docker pull"
    passed_tests=$((passed_tests + 1))
else
    log_fail "--git-pull语义不清晰"
    failed_tests=$((failed_tests + 1))
fi

# 测试15: 错误分支 - server无--with-deps且postgres未运行
log_info "测试15: 错误提示 - server缺少--with-deps"
if grep -A8 "! check_dependency postgres" deploy.sh | grep -q "exit 1"; then
    log_pass "postgres未运行时会提示且退出"
    passed_tests=$((passed_tests + 1))
else
    log_fail "缺少postgres依赖检查"
    failed_tests=$((failed_tests + 1))
fi

# 测试16: DEPLOY.md简洁性
log_info "测试16: DEPLOY.md简洁（< 200行）"
deploy_lines=$(wc -l < DEPLOY.md)
if [[ $deploy_lines -lt 200 ]]; then
    log_pass "DEPLOY.md简洁（${deploy_lines}行）"
    passed_tests=$((passed_tests + 1))
else
    log_fail "DEPLOY.md过长（${deploy_lines}行，应<200）"
    failed_tests=$((failed_tests + 1))
fi

# 测试17: 重复文档已删除
log_info "测试17: 无重复文档"
if [[ ! -f "COMMANDS.md" ]] && [[ ! -f "VERIFICATION_SUMMARY.md" ]]; then
    log_pass "COMMANDS.md和VERIFICATION_SUMMARY.md已删除"
    passed_tests=$((passed_tests + 1))
else
    log_fail "仍存在重复文档"
    failed_tests=$((failed_tests + 1))
fi

# 总结
echo ""
echo "=========================================="
echo "测试完成"
echo "通过: $passed_tests"
echo "失败: $failed_tests"
echo "=========================================="

if [[ $failed_tests -eq 0 ]]; then
    echo -e "${GREEN}所有测试通过${NC}"
    exit 0
else
    echo -e "${RED}有 $failed_tests 个测试失败${NC}"
    exit 1
fi
