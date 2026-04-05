#!/bin/bash
# ============================================================
# Meme Perp DEX — Contabo VPS 一键部署脚本
# 使用方法:
#   1. SSH 到 VPS: ssh root@your-vps-ip
#   2. 运行: curl -sSL https://raw.githubusercontent.com/whha111/meme-perp-dex/main/deploy/setup-vps.sh | bash
#   或者手动: bash setup-vps.sh
# ============================================================

set -e

echo "============================================"
echo "  Meme Perp DEX — VPS 部署"
echo "============================================"

# 1. 系统更新 + 安装依赖
echo "[1/6] 安装系统依赖..."
apt-get update -qq
apt-get install -y -qq curl git ufw certbot

# 2. 安装 Docker
if ! command -v docker &> /dev/null; then
    echo "[2/6] 安装 Docker..."
    curl -fsSL https://get.docker.com | sh
    systemctl enable docker
    systemctl start docker
else
    echo "[2/6] Docker 已安装"
fi

# 安装 Docker Compose (v2 plugin)
if ! docker compose version &> /dev/null; then
    echo "  安装 Docker Compose..."
    apt-get install -y -qq docker-compose-plugin
fi

# 3. 防火墙
echo "[3/6] 配置防火墙..."
ufw allow 22/tcp   # SSH
ufw allow 80/tcp   # HTTP
ufw allow 443/tcp  # HTTPS
ufw --force enable

# 4. 克隆代码
echo "[4/6] 克隆代码..."
DEPLOY_DIR="/opt/meme-perp-dex"
if [ -d "$DEPLOY_DIR" ]; then
    echo "  目录已存��，拉取最新代码..."
    cd "$DEPLOY_DIR"
    git pull origin main
else
    git clone https://github.com/whha111/meme-perp-dex.git "$DEPLOY_DIR"
    cd "$DEPLOY_DIR"
fi

# 5. 生成 .env.production
echo "[5/6] 配置环境变量..."
ENV_FILE="$DEPLOY_DIR/.env.production"
if [ ! -f "$ENV_FILE" ]; then
    # 生成随机密码
    PG_PASS=$(openssl rand -base64 24 | tr -d '/+=' | head -c 32)
    REDIS_PASS=$(openssl rand -base64 24 | tr -d '/+=' | head -c 32)
    JWT_SEC=$(openssl rand -base64 48 | tr -d '/+=' | head -c 64)

    cat > "$ENV_FILE" << ENVEOF
# ============================================================
# Production Environment — 自动生成于 $(date)
# ============================================================

# 数据库密码 (自动生成)
POSTGRES_PASSWORD=${PG_PASS}
REDIS_PASSWORD=${REDIS_PASS}
JWT_SECRET=${JWT_SEC}

# ============================================================
# 区块链配置 — BSC Testnet (Chain 97)
# ============================================================
RPC_URL=https://data-seed-prebsc-1-s1.binance.org:8545/
CHAIN_ID=97

# ⚠️ 必填: Keeper 钱包私钥 (不带 0x 前缀)
KEEPER_PRIVATE_KEY=FILL_IN_YOUR_PRIVATE_KEY

# ============================================================
# 合约地址 — BSC Testnet (2026-04-05 部署)
# ============================================================
TOKEN_FACTORY_ADDRESS=0xB40541Ff9f24883149fc6F9CD1021dB9C7BCcB83
POSITION_ADDRESS=0x50d3e039Efe373D9d52676D482E732FD9C411b05
SETTLEMENT_V2_ADDRESS=0xF83D5d2E437D0e27144900cb768d2B5933EF3d6b
PERP_VAULT_ADDRESS=0xF0db95eD967318BC7757A671399f0D4FFC853e05
PRICE_FEED_ADDRESS=0xB480517B96558E4467cfa1d91d8E6592c66B564D
VAULT_ADDRESS=0xE70b128aA233Fa6e54C1EDCACDdC11C5465760Ac
FUNDING_RATE_ADDRESS=0x246d00Bfb4DC18d199Fecaf4045A2F6f2A018A9C
LIQUIDATION_ADDRESS=0x5587Cf6b94E52e2Da0B8412381fcdfe4D39CA562
INSURANCE_FUND_ADDRESS=0xa20488Ed2CEABD0e6441496c2F4F5fBA18F4cE83
COLLATERAL_TOKEN_ADDRESS=0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd
FEE_RECEIVER_ADDRESS=0xAecb229194314999E396468eb091b42E44Bc3c8c
LENDING_POOL_ADDRESS=

# ============================================================
# 匹配引擎额外配置
# ============================================================
PLATFORM_SIGNER_KEY=FILL_IN_YOUR_SIGNER_KEY
SKIP_BALANCE_SYNC=true
SNAPSHOT_INTERVAL_MS=300000

# ============================================================
# 前端 URL (部署后替换为你的域名)
# ============================================================
API_URL=http://YOUR_VPS_IP:80
WS_URL=ws://YOUR_VPS_IP:80/ws
ENVEOF

    echo ""
    echo "  ⚠️  请编辑 $ENV_FILE 填入:"
    echo "     - KEEPER_PRIVATE_KEY (Keeper 钱包私钥)"
    echo "     - PLATFORM_SIGNER_KEY (签名私钥)"
    echo "     - API_URL / WS_URL (你的 VPS IP 或域名)"
    echo ""
    echo "  编辑命令: nano $ENV_FILE"
    echo ""
    echo "  填好后运行: bash $DEPLOY_DIR/deploy/start.sh"
    exit 0
else
    echo "  .env.production 已存在，跳过生成"
fi

echo "[6/6] 准备完成！"
echo ""
echo "============================================"
echo "  下一步:"
echo "  1. 编辑环境变量: nano $ENV_FILE"
echo "  2. 启动服务: bash $DEPLOY_DIR/deploy/start.sh"
echo "  3. (可选) 配SSL: bash $DEPLOY_DIR/deploy/setup-ssl.sh your-domain.com"
echo "============================================"
