#!/bin/bash
# ============================================================
# 启动所有服务
# ============================================================

set -e
DEPLOY_DIR="/opt/meme-perp-dex"
cd "$DEPLOY_DIR"

# 检查 .env.production
if [ ! -f .env.production ]; then
    echo "❌ .env.production 不存在，先运行 setup-vps.sh"
    exit 1
fi

# 检查私钥是否已填
if grep -q "FILL_IN_YOUR" .env.production; then
    echo "❌ .env.production 中有未填写的字段 (FILL_IN_YOUR_*)，请先编辑"
    echo "   nano .env.production"
    exit 1
fi

# 加载环境变量
set -a
source .env.production
set +a

echo "============================================"
echo "  启动 Meme Perp DEX 服务"
echo "============================================"

# 构建并启动
echo "[1/3] 构建 Docker 镜像..."
docker compose -f docker-compose.production.yml --env-file .env.production build

echo "[2/3] 启动服务..."
docker compose -f docker-compose.production.yml --env-file .env.production up -d

echo "[3/3] 等待服务健康..."
sleep 15

# 检查服务状态
echo ""
echo "============================================"
echo "  服务状态"
echo "============================================"
docker compose -f docker-compose.production.yml ps

echo ""
echo "  健康检查:"

# Check each service
for service in postgres redis backend matching-engine keeper frontend; do
    status=$(docker inspect --format='{{.State.Health.Status}}' memeperp-$service 2>/dev/null || echo "no-healthcheck")
    running=$(docker inspect --format='{{.State.Running}}' memeperp-$service 2>/dev/null || echo "false")
    if [ "$running" = "true" ]; then
        echo "  ✅ $service: running ($status)"
    else
        echo "  ❌ $service: not running"
    fi
done

echo ""
VPS_IP=$(curl -s ifconfig.me 2>/dev/null || echo "YOUR_VPS_IP")
echo "============================================"
echo "  访问地址:"
echo "  前端: http://$VPS_IP"
echo "  API:  http://$VPS_IP/api/"
echo "  WS:   ws://$VPS_IP/ws"
echo "============================================"
echo ""
echo "  常用命令:"
echo "  查看日志:   docker compose -f docker-compose.production.yml logs -f"
echo "  重启服务:   docker compose -f docker-compose.production.yml restart"
echo "  停止服务:   docker compose -f docker-compose.production.yml down"
echo "  更新部署:   bash deploy/update.sh"
echo "============================================"
