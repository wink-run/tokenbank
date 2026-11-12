#!/usr/bin/env bash
# Token Bank 部署配置验证
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

echo "=========================================="
echo "Token Bank 部署配置验证"
echo "=========================================="
echo ""

# 1. 运行部署脚本测试
echo "1. 运行部署脚本测试..."
if ./scripts/test-deploy.sh; then
    echo -e "${GREEN}✓ 部署脚本测试通过${NC}"
else
    echo -e "${RED}✗ 部署脚本测试失败${NC}"
    exit 1
fi

echo ""
echo "2. 检查文档..."
if [[ -f "DEPLOY.md" ]] && [[ -f "deploy.sh" ]]; then
    echo -e "${GREEN}✓ 必要文件存在${NC}"
else
    echo -e "${RED}✗ 缺少必要文件${NC}"
    exit 1
fi

echo ""
echo "=========================================="
echo -e "${GREEN}验证通过！${NC}"
echo ""
echo "部署命令:"
echo "  ./deploy.sh server --https --with-deps  # 首次部署服务端"
echo "  ./deploy.sh gateway                     # 首次部署Gateway"
echo "  ./deploy.sh server                      # 更新服务端"
echo "  ./deploy.sh gateway                     # 更新Gateway"
echo ""
echo "详见: DEPLOY.md"
echo "=========================================="
