#!/bin/bash
# 一键启动本地开发环境 + ngrok 内网穿透
# 使用: ./scripts/start-local-ngrok.sh

set -e

echo "========================================="
echo "  Meme Perp DEX - 本地 + ngrok 穿透"
echo "========================================="

# 1. 检查 Docker 是否运行
if ! docker info &>/dev/null; then
  echo "❌ Docker 未运行，请先启动 Docker Desktop"
  exit 1
fi

# 2. 检查 ngrok
if ! command -v ngrok &>/dev/null; then
  echo "❌ ngrok 未安装，请先安装: brew install ngrok"
  exit 1
fi

# 3. 确保 nginx 日志目录存在
mkdir -p nginx/logs nginx/ssl

# 4. 构建并启动所有服务
echo ""
echo "📦 启动 Docker 服务 (postgres, redis, matching-engine, backend, frontend, nginx)..."
docker compose build --no-cache frontend  # 重建前端（bake 新的空 API URL）
docker compose up -d

echo ""
echo "⏳ 等待服务启动..."
sleep 10

# 5. 检查健康状态
echo ""
echo "🔍 检查服务状态..."
docker compose ps

# 6. 启动 ngrok
echo ""
echo "🌐 启动 ngrok 内网穿透 (端口 80)..."
echo "   分享下面的 URL 给其他人即可访问！"
echo ""
ngrok http 80
