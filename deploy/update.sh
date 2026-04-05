#!/bin/bash
# ============================================================
# 更新部署 (拉取最新代码 + 重新构建 + 重启)
# ============================================================

set -e
DEPLOY_DIR="/opt/meme-perp-dex"
cd "$DEPLOY_DIR"

echo "============================================"
echo "  更新 Meme Perp DEX"
echo "============================================"

# 1. 拉取最新代码
echo "[1/4] 拉取最新代码..."
git pull origin main

# 2. 重新构建变化的镜像
echo "[2/4] 重新构建..."
docker compose -f docker-compose.production.yml --env-file .env.production build

# 3. 滚动重启 (先重启后端，再前端)
echo "[3/4] 重启服务..."
docker compose -f docker-compose.production.yml --env-file .env.production up -d

# 4. 清理旧镜像
echo "[4/4] 清理旧镜像..."
docker image prune -f

echo ""
echo "✅ 更新完成！"
docker compose -f docker-compose.production.yml ps
