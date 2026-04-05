#!/bin/bash
# ============================================================
# 配置 Let's Encrypt SSL 证书 (免费)
# 使用: bash deploy/setup-ssl.sh yourdomain.com
# ============================================================

set -e

DOMAIN=$1
if [ -z "$DOMAIN" ]; then
    echo "用法: bash setup-ssl.sh yourdomain.com"
    echo "  确保域名已指向此服务器 IP"
    exit 1
fi

DEPLOY_DIR="/opt/meme-perp-dex"
cd "$DEPLOY_DIR"

echo "============================================"
echo "  为 $DOMAIN 配置 SSL 证书"
echo "============================================"

# 1. 先停 nginx (释放 80 端口给 certbot)
echo "[1/4] 停止 nginx..."
docker compose -f docker-compose.production.yml stop nginx 2>/dev/null || true

# 2. 申请证书
echo "[2/4] 申请 Let's Encrypt 证书..."
certbot certonly --standalone -d "$DOMAIN" --non-interactive --agree-tos --email admin@$DOMAIN

# 3. 复制证书到 nginx 目录
echo "[3/4] 配置证书..."
mkdir -p nginx/ssl
cp /etc/letsencrypt/live/$DOMAIN/fullchain.pem nginx/ssl/fullchain.pem
cp /etc/letsencrypt/live/$DOMAIN/privkey.pem nginx/ssl/privkey.pem

# 更新 nginx.conf 中的域名
sed -i "s/memeperp.xyz/$DOMAIN/g" nginx/nginx.conf

# 4. 更新 .env.production 中的 URL
echo "[4/4] 更新环境变量..."
sed -i "s|API_URL=.*|API_URL=https://$DOMAIN|" .env.production
sed -i "s|WS_URL=.*|WS_URL=wss://$DOMAIN/ws|" .env.production

# 重启所有服务 (前端需要重新构建以注入新 URL)
echo "重新构建前端 (注入新域名)..."
docker compose -f docker-compose.production.yml --env-file .env.production build frontend
docker compose -f docker-compose.production.yml --env-file .env.production up -d

# 设置证书自动续期
echo "设置自动续期 cron..."
(crontab -l 2>/dev/null; echo "0 3 * * * certbot renew --quiet && cp /etc/letsencrypt/live/$DOMAIN/fullchain.pem $DEPLOY_DIR/nginx/ssl/ && cp /etc/letsencrypt/live/$DOMAIN/privkey.pem $DEPLOY_DIR/nginx/ssl/ && docker compose -f $DEPLOY_DIR/docker-compose.production.yml restart nginx") | crontab -

echo ""
echo "============================================"
echo "  ✅ SSL 配置完成！"
echo "  前端: https://$DOMAIN"
echo "  API:  https://$DOMAIN/api/"
echo "  WS:   wss://$DOMAIN/ws"
echo "  证书自动续期: 每天凌晨 3 点"
echo "============================================"
