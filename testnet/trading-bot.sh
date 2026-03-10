#!/bin/bash
# ============================================================
# MEME Perp DEX - 24h Automated Trading Bot (Multi-Wallet)
# ============================================================
# 模拟真实用户行为 — 所有操作与前端完全一致:
#   - 存款: 链上 Settlement.depositETH() (同前端 useWriteContract)
#   - 合约交易: POST /api/order/submit (同前端 orderSigning.ts)
#   - 平仓: POST /api/position/{id}/close (同前端 requestClosePair)
#   - 现货: cast send TokenFactory.buy/sell (同前端 useWriteContract)
#   - 借贷: cast send LendingPool.deposit/withdraw (同前端 useWriteContract)
#
# 每个操作后验证结果并输出前端可见 URL
# 使用 20 个测试钱包模拟多用户交易环境
#
# Run modes:
#   ./trading-bot.sh              # Run 24h loop
#   ./trading-bot.sh --once       # Run one cycle only
#   ./trading-bot.sh --spot-only  # Only spot trading
#   ./trading-bot.sh --perp-only  # Only perpetual trading
#   ./trading-bot.sh --wallets=N  # Use N wallets (default 20)
# ============================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
LOG_DIR="$SCRIPT_DIR/logs"
BOT_LOG="$LOG_DIR/trading-bot.log"
PID_DIR="$SCRIPT_DIR/pids"
WALLETS_JSON="$PROJECT_DIR/backend/src/matching/main-wallets.json"

# Load environment from project root .env (used by docker-compose)
if [ -f "$PROJECT_DIR/.env" ]; then
    set -a; source "$PROJECT_DIR/.env"; set +a
fi
if [ -f "$SCRIPT_DIR/.env.testnet" ]; then
    set -a; source "$SCRIPT_DIR/.env.testnet"; set +a
fi

# Colors
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; MAGENTA='\033[0;35m'; NC='\033[0m'

# ============================================================
# Configuration
# ============================================================
# AUDIT-FIX DP-C01: Read key from env — no hardcoded fallback
DEPLOYER_KEY="${MEMEPERP_BLOCKCHAIN_PRIVATE_KEY:-${DEPLOYER_PRIVATE_KEY:-}}"
if [ -z "$DEPLOYER_KEY" ]; then
    echo "ERROR: Set MEMEPERP_BLOCKCHAIN_PRIVATE_KEY or DEPLOYER_PRIVATE_KEY env var"
    exit 1
fi
DEPLOYER_ADDRESS="0x5AF11d4784c3739cf2FD51Fdc272ae4957ADf7fE"

MATCHING_ENGINE="http://localhost:${MATCHING_ENGINE_PORT:-8081}"
RPC_URL="${MEMEPERP_BLOCKCHAIN_RPC_URL:-https://base-sepolia.g.alchemy.com/v2/Dr8sMe-1MYIF7jBYuZZj8PMOPAAeJ16d}"
BLOCK_EXPLORER="https://sepolia.basescan.org"

TOKEN_FACTORY_ADDRESS="${MEMEPERP_TOKEN_FACTORY_ADDRESS:-0x583d35e9d407Ea03dE5A2139e792841353CB67b1}"
SETTLEMENT_ADDRESS="${MEMEPERP_BLOCKCHAIN_POSITION_ADDRESS:-0x027131BbC5EF6427826F64D12BACAAb447Ee1B13}"
LENDING_POOL_ADDRESS="${LENDING_POOL_ADDRESS:-0x7Ddb15B5E680D8a74FE44958d18387Bb3999C633}"

NUM_WALLETS=20          # How many test wallets to use
SPOT_INTERVAL=120       # Spot trade every 2 minutes
PERP_INTERVAL=60        # Perp trade every 1 minute
LENDING_INTERVAL=300    # Lending action every 5 minutes
CYCLE_COUNT=0
DURATION_24H=86400
START_TIME=$(date +%s)
FUND_AMOUNT="0.005"     # ETH per wallet
DEPOSIT_AMOUNT="0.003"  # ETH deposit to Settlement per wallet

# Dummy signature (works with SKIP_SIGNATURE_VERIFY=true in matching engine)
DUMMY_SIG="0x0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"

# Parse arguments
ONCE_MODE=false; SPOT_ONLY=false; PERP_ONLY=false
for arg in "$@"; do
    case $arg in
        --once) ONCE_MODE=true ;;
        --spot-only) SPOT_ONLY=true ;;
        --perp-only) PERP_ONLY=true ;;
        --wallets=*) NUM_WALLETS="${arg#*=}" ;;
    esac
done

mkdir -p "$LOG_DIR" "$PID_DIR"

# ============================================================
# Wallet Arrays (loaded from main-wallets.json)
# ============================================================
WALLET_ADDRESSES=()
WALLET_KEYS=()
NONCE_DIR="$PID_DIR/nonces"
mkdir -p "$NONCE_DIR"

# Nonce helpers (file-based, compatible with bash 3.x on macOS)
get_nonce() {
    local addr=$(echo "$1" | tr '[:upper:]' '[:lower:]')
    local f="$NONCE_DIR/$addr"
    if [ -f "$f" ]; then cat "$f"; else echo "0"; fi
}
set_nonce() {
    local addr=$(echo "$1" | tr '[:upper:]' '[:lower:]')
    echo "$2" > "$NONCE_DIR/$addr"
}
inc_nonce() {
    local addr=$(echo "$1" | tr '[:upper:]' '[:lower:]')
    local cur=$(get_nonce "$addr")
    set_nonce "$addr" $((cur + 1))
}

# ============================================================
# Utility Functions
# ============================================================

log() {
    local msg="[$(date '+%Y-%m-%d %H:%M:%S')] $1"
    echo -e "$msg"
    echo -e "$msg" >> "$BOT_LOG" 2>/dev/null || true
}
log_ok()    { log "${GREEN}✅ $1${NC}"; }
log_fail()  { log "${RED}❌ $1${NC}"; }
log_info()  { log "${BLUE}ℹ️  $1${NC}"; }
log_trade() { log "${CYAN}📊 $1${NC}"; }
log_verify(){ log "${MAGENTA}🔍 $1${NC}"; }

rand_between() {
    echo $(( RANDOM % ($2 - $1 + 1) + $1 ))
}

api_call() {
    local method=$1 url=$2 data=${3:-}
    if [ "$method" = "GET" ]; then
        curl -s --connect-timeout 10 --max-time 30 "$url" 2>/dev/null || echo '{"error":"timeout"}'
    else
        curl -s --connect-timeout 10 --max-time 30 -X "$method" -H "Content-Type: application/json" -d "$data" "$url" 2>/dev/null || echo '{"error":"timeout"}'
    fi
}

json_get() {
    python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('$1',''))" 2>/dev/null <<< "$2" || echo ""
}

# Parse nested JSON safely
json_parse() {
    python3 -c "
import json, sys
try:
    d = json.loads(sys.stdin.read())
    $1
except: print('')
" 2>/dev/null <<< "$2" || echo ""
}

elapsed_time() { echo $(( $(date +%s) - START_TIME )); }

# Get random wallet index
rand_wallet() {
    echo $(( RANDOM % ${#WALLET_ADDRESSES[@]} ))
}

# Get two different random wallet indices
rand_pair() {
    local a=$(rand_wallet)
    local b=$(rand_wallet)
    while [ "$a" = "$b" ]; do
        b=$(rand_wallet)
    done
    echo "$a $b"
}

# Short address for logging
short_addr() {
    echo "${1:0:6}...${1: -4}"
}

# Format wei to ETH (rough, for display)
wei_to_eth() {
    python3 -c "print(f'{int(\"${1:-0}\") / 1e18:.6f}')" 2>/dev/null || echo "0.000000"
}

# ============================================================
# Verification Functions (post-action checks)
# ============================================================

# Check and log wallet balance from matching engine
verify_balance() {
    local addr=$1
    local short=$(short_addr "$addr")
    local result
    result=$(api_call "GET" "$MATCHING_ENGINE/api/user/$addr/balance")
    local avail
    avail=$(json_parse "print(d.get('availableBalance', d.get('available','0')))" "$result")
    local margin
    margin=$(json_parse "print(d.get('usedMargin', d.get('locked','0')))" "$result")
    local avail_eth=$(wei_to_eth "$avail")
    local margin_eth=$(wei_to_eth "$margin")
    log_verify "[$short] Balance: ${avail_eth} ETH available | ${margin_eth} ETH in margin"
}

# Check and log open positions count
verify_positions() {
    local addr=$1
    local short=$(short_addr "$addr")
    local result
    result=$(api_call "GET" "$MATCHING_ENGINE/api/user/$addr/positions")
    local count
    count=$(python3 -c "
import json
try:
    data = json.loads('''$result''')
    if isinstance(data, list): print(len(data))
    elif isinstance(data, dict) and 'positions' in data: print(len(data['positions']))
    else: print(0)
except: print(0)
" 2>/dev/null || echo "0")
    log_verify "[$short] Open positions: $count"
}

# Parse and log order submission result
verify_order_result() {
    local result=$1
    local short=$2
    local orderId
    orderId=$(json_get "orderId" "$result")
    local status
    status=$(json_get "status" "$result")
    local matches_count
    matches_count=$(python3 -c "
import json
try:
    d = json.loads('''$result''')
    m = d.get('matches', [])
    print(len(m) if isinstance(m, list) else 0)
except: print(0)
" 2>/dev/null || echo "0")
    log_verify "[$short] Order ${orderId:0:12}... → Status: $status | Matches: $matches_count"
}

# Log frontend URL where action is visible
log_frontend_url() {
    local page=$1
    local detail=${2:-}
    log "${YELLOW}   🌐 Frontend: http://localhost:3000${page}${NC}"
    [ -n "$detail" ] && log "${YELLOW}      ${detail}${NC}"
}

# Log block explorer URL for a transaction
log_tx() {
    local tx_hash=$1
    if [ -n "$tx_hash" ] && [ "$tx_hash" != "" ] && [ "$tx_hash" != "null" ]; then
        log "${YELLOW}   🔗 TX: ${BLOCK_EXPLORER}/tx/${tx_hash}${NC}"
    fi
}

# ============================================================
# Load & Setup Wallets
# ============================================================

load_wallets() {
    log_info "Loading $NUM_WALLETS wallets from main-wallets.json..."

    if [ ! -f "$WALLETS_JSON" ]; then
        log_fail "Wallet file not found: $WALLETS_JSON"
        exit 1
    fi

    # Parse wallets using Python (fast, reliable)
    eval "$(python3 -c "
import json
with open('$WALLETS_JSON') as f:
    wallets = json.load(f)
n = min($NUM_WALLETS, len(wallets))
for i in range(n):
    w = wallets[i]
    print(f'WALLET_ADDRESSES[{i}]=\"{w[\"address\"]}\"')
    print(f'WALLET_KEYS[{i}]=\"{w[\"privateKey\"]}\"')
print(f'TOTAL_LOADED={n}')
" 2>/dev/null)"

    log_ok "Loaded $TOTAL_LOADED wallets"
}

setup_wallets() {
    log_info "Setting up $NUM_WALLETS wallets (fund + on-chain deposit + sync)..."
    log_info "Human-like flow: ETH transfer → Settlement.depositETH() → balance sync"

    local funded=0 deposited=0 skipped=0
    local deployer_bal
    deployer_bal=$(cast balance "$DEPLOYER_ADDRESS" --rpc-url "$RPC_URL" --ether 2>/dev/null || echo "0")
    log_info "Deployer balance: $deployer_bal ETH"

    for i in "${!WALLET_ADDRESSES[@]}"; do
        local addr="${WALLET_ADDRESSES[$i]}"
        local key="${WALLET_KEYS[$i]}"
        local short=$(short_addr "$addr")

        # Check on-chain ETH balance
        local bal
        bal=$(cast balance "$addr" --rpc-url "$RPC_URL" 2>/dev/null || echo "0")
        local needs_fund
        needs_fund=$(python3 -c "print('yes' if int('${bal}') < 3000000000000000 else 'no')" 2>/dev/null || echo "yes")

        if [ "$needs_fund" = "yes" ]; then
            # Step 1: Fund wallet with ETH (like faucet)
            local fund_tx
            fund_tx=$(cast send --private-key "$DEPLOYER_KEY" --rpc-url "$RPC_URL" \
                --value "${FUND_AMOUNT}ether" "$addr" --json 2>/dev/null || echo '{}')
            local fund_hash
            fund_hash=$(json_parse "print(d.get('transactionHash',''))" "$fund_tx")
            if [ -n "$fund_hash" ] && [ "$fund_hash" != "" ]; then
                funded=$((funded + 1))
                log_ok "[$short] Funded ${FUND_AMOUNT} ETH"
            else
                log_fail "[$short] Fund failed"
            fi
            sleep 1
        fi

        # Check Settlement balance — deposit if empty (even if ETH was already there)
        local settlement_bal
        settlement_bal=$(cast call "$SETTLEMENT_ADDRESS" "getUserBalance(address)(uint256,uint256)" "$addr" --rpc-url "$RPC_URL" 2>/dev/null || echo "0 0")
        local settlement_avail
        settlement_avail=$(echo "$settlement_bal" | head -1 | tr -d ' ')

        local needs_deposit
        needs_deposit=$(python3 -c "print('yes' if int('${settlement_avail:-0}') < 1000000000000000 else 'no')" 2>/dev/null || echo "yes")

        if [ "$needs_deposit" = "yes" ]; then
            # Step 2: Deposit to Settlement (same as frontend Settlement.depositETH())
            local dep_tx
            dep_tx=$(cast send --private-key "$key" --rpc-url "$RPC_URL" \
                --value "${DEPOSIT_AMOUNT}ether" "$SETTLEMENT_ADDRESS" "depositETH()" --json 2>/dev/null || echo '{}')
            local dep_hash
            dep_hash=$(json_parse "print(d.get('transactionHash',''))" "$dep_tx")
            if [ -n "$dep_hash" ] && [ "$dep_hash" != "" ]; then
                deposited=$((deposited + 1))
                log_ok "[$short] Deposited ${DEPOSIT_AMOUNT} ETH to Settlement"
                log_tx "$dep_hash"
            else
                log_fail "[$short] Settlement deposit failed"
            fi
            sleep 2  # Wait for chain confirmation
        else
            skipped=$((skipped + 1))
        fi

        # Step 3: Sync balance from chain to matching engine
        # (equivalent to frontend's automatic WebSocket sync after deposit)
        api_call "POST" "$MATCHING_ENGINE/api/balance/sync" "{\"trader\":\"$addr\"}" > /dev/null 2>&1 || true

        # Step 4: Verify synced balance
        local bal_result
        bal_result=$(api_call "GET" "$MATCHING_ENGINE/api/user/$addr/balance")
        local avail
        avail=$(json_parse "print(d.get('availableBalance', d.get('available','0')))" "$bal_result")
        local avail_eth=$(wei_to_eth "$avail")

        # Step 5: Get nonce for order submission
        local nonce_result
        nonce_result=$(api_call "GET" "$MATCHING_ENGINE/api/user/$addr/nonce")
        local fetched_nonce=$(json_get "nonce" "$nonce_result")
        set_nonce "$addr" "${fetched_nonce:-0}"

        # Progress every 5 wallets
        if [ $(( (i + 1) % 5 )) -eq 0 ]; then
            log_info "  Progress: $((i + 1))/$NUM_WALLETS wallets (last: $short → ${avail_eth} ETH)"
        fi
    done

    log_ok "Wallets ready: funded=$funded deposited=$deposited skipped=$skipped"
}

# ============================================================
# FEATURE 1: Spot Trading (On-chain TokenFactory)
# Same as frontend: useWriteContract → TokenFactory.buy/sell/createToken
# ============================================================

get_all_tokens() {
    cast call "$TOKEN_FACTORY_ADDRESS" "getAllTokens()(address[])" --rpc-url "$RPC_URL" 2>/dev/null || echo ""
}

# Check if a token is graduated (graduated tokens can't use buy/sell on TokenFactory)
is_token_graduated() {
    local token=$1
    local raw
    raw=$(cast call "$TOKEN_FACTORY_ADDRESS" "getPoolState(address)" "$token" --rpc-url "$RPC_URL" 2>/dev/null || echo "")
    if [ -z "$raw" ]; then echo "unknown"; return; fi
    # isGraduated is the 5th 32-byte word (index 4, after offset word) = bytes 256-320
    python3 -c "
data = '$raw'.replace('0x','')
if len(data) >= 320:
    word = data[256:320]
    print('yes' if int(word, 16) else 'no')
else:
    print('unknown')
" 2>/dev/null || echo "unknown"
}

# Get list of non-graduated tokens (for spot trading)
get_tradeable_tokens() {
    local all_tokens
    all_tokens=$(get_all_tokens)
    if [ -z "$all_tokens" ] || [ "$all_tokens" = "[]" ]; then echo ""; return; fi

    local token_list
    token_list=$(echo "$all_tokens" | tr -d '[]' | tr ',' '\n' | tr -d ' ')

    local tradeable=""
    while IFS= read -r token; do
        [ -z "$token" ] && continue
        local grad=$(is_token_graduated "$token")
        if [ "$grad" != "yes" ]; then
            [ -n "$tradeable" ] && tradeable="$tradeable,"
            tradeable="$tradeable$token"
        fi
    done <<< "$token_list"
    echo "$tradeable"
}

create_meme_token() {
    # Pick a random wallet to create the token
    local idx=$(rand_wallet)
    local key="${WALLET_KEYS[$idx]}"
    local addr="${WALLET_ADDRESSES[$idx]}"
    local short=$(short_addr "$addr")

    local name="Meme$(rand_between 1 9999)"
    local symbol="M$(rand_between 100 999)"
    local uri="https://example.com/$symbol"

    log_trade "[$short] Creating token: $name ($symbol) [same as frontend createToken()]"

    local tx_result
    tx_result=$(cast send "$TOKEN_FACTORY_ADDRESS" \
        "createToken(string,string,string,uint256)" "$name" "$symbol" "$uri" 0 \
        --value 0.002ether \
        --rpc-url "$RPC_URL" \
        --private-key "$key" \
        --json 2>/dev/null || echo '{}')

    local tx_hash
    tx_hash=$(json_parse "print(d.get('transactionHash',''))" "$tx_result")

    if [ -n "$tx_hash" ] && [ "$tx_hash" != "" ]; then
        log_ok "Token created: $name ($symbol) by $short"
        log_tx "$tx_hash"

        # Verify: count all tokens
        local all_tokens
        all_tokens=$(get_all_tokens)
        local token_count
        token_count=$(echo "$all_tokens" | tr ',' '\n' | wc -l | tr -d ' ')
        log_verify "Total tokens on TokenFactory: $token_count"
        log_frontend_url "/exchange" "New token '$name' visible on spot trading page"
        return 0
    fi
    log_fail "Token creation failed"
    return 1
}

buy_tokens() {
    local token=$1
    # Pick random wallet
    local idx=$(rand_wallet)
    local key="${WALLET_KEYS[$idx]}"
    local addr="${WALLET_ADDRESSES[$idx]}"
    local short=$(short_addr "$addr")

    # Use small amount to avoid graduating tokens too fast
    local buy_amounts=("0.0003" "0.0005" "0.0007" "0.001")
    local buy_eth=${buy_amounts[$((RANDOM % ${#buy_amounts[@]}))]}
    log_trade "[$short] Buying ${token:0:10}... with $buy_eth ETH [same as frontend TokenFactory.buy()]"

    local tx_result
    tx_result=$(cast send "$TOKEN_FACTORY_ADDRESS" \
        "buy(address,uint256)" "$token" 0 \
        --value ${buy_eth}ether \
        --rpc-url "$RPC_URL" \
        --private-key "$key" \
        --json 2>/dev/null || echo '{}')

    local tx_hash
    tx_hash=$(json_parse "print(d.get('transactionHash',''))" "$tx_result")

    if [ -n "$tx_hash" ] && [ "$tx_hash" != "" ]; then
        log_ok "Bought tokens by $short"
        log_tx "$tx_hash"

        # Verify: check token balance
        local new_bal
        new_bal=$(cast call "$token" "balanceOf(address)(uint256)" "$addr" --rpc-url "$RPC_URL" 2>/dev/null || echo "0")
        local new_bal_eth=$(wei_to_eth "$new_bal")
        log_verify "[$short] Token balance after buy: $new_bal_eth"
        log_frontend_url "/exchange" "Trade visible in spot order book"
        return 0
    fi
    log_fail "Buy failed by $short"
    return 1
}

sell_tokens() {
    local token=$1
    # Pick random wallet
    local idx=$(rand_wallet)
    local key="${WALLET_KEYS[$idx]}"
    local addr="${WALLET_ADDRESSES[$idx]}"
    local short=$(short_addr "$addr")

    local balance
    balance=$(cast call "$token" "balanceOf(address)(uint256)" "$addr" --rpc-url "$RPC_URL" 2>/dev/null || echo "0")

    if [ -z "$balance" ] || [ "$balance" = "0" ]; then
        log_info "[$short] No tokens to sell"
        return 1
    fi

    local sell_amount
    sell_amount=$(python3 -c "print(max(int('$balance') // 4, 1))" 2>/dev/null || echo "0")
    if [ "$sell_amount" = "0" ]; then return 1; fi

    log_trade "[$short] Selling tokens at ${token:0:10}... [same as frontend TokenFactory.sell()]"

    # Step 1: Approve (same as frontend ERC20 approve)
    cast send "$token" "approve(address,uint256)" "$TOKEN_FACTORY_ADDRESS" "$sell_amount" \
        --rpc-url "$RPC_URL" --private-key "$key" > /dev/null 2>&1 || true

    # Step 2: Sell
    local tx_result
    tx_result=$(cast send "$TOKEN_FACTORY_ADDRESS" "sell(address,uint256,uint256)" "$token" "$sell_amount" 0 \
        --rpc-url "$RPC_URL" --private-key "$key" --json 2>/dev/null || echo '{}')

    local tx_hash
    tx_hash=$(json_parse "print(d.get('transactionHash',''))" "$tx_result")

    if [ -n "$tx_hash" ] && [ "$tx_hash" != "" ]; then
        log_ok "Sold tokens by $short"
        log_tx "$tx_hash"

        # Verify remaining balance
        local remaining
        remaining=$(cast call "$token" "balanceOf(address)(uint256)" "$addr" --rpc-url "$RPC_URL" 2>/dev/null || echo "0")
        local remaining_eth=$(wei_to_eth "$remaining")
        log_verify "[$short] Token balance after sell: $remaining_eth"
        log_frontend_url "/exchange" "Sell visible in spot trading"
        return 0
    fi
    log_fail "Sell failed by $short"
    return 1
}

run_spot_cycle() {
    log_info "=== Spot Trading Cycle [On-chain: same as frontend useWriteContract] ==="

    # Get tradeable (non-graduated) tokens
    local tradeable
    tradeable=$(get_tradeable_tokens)

    # If no tradeable tokens, create a new one
    if [ -z "$tradeable" ]; then
        log_info "All tokens graduated — creating fresh one for bonding curve trading..."
        create_meme_token || true
        return
    fi

    # 20% chance to create a new token anyway (for variety)
    if [ $(rand_between 1 100) -le 20 ]; then
        create_meme_token || true
    fi

    # Pick random tradeable token
    local token_list
    token_list=$(echo "$tradeable" | tr ',' '\n')
    local token_count
    token_count=$(echo "$token_list" | wc -l | tr -d ' ')
    local pick=$((RANDOM % token_count + 1))
    local selected_token
    selected_token=$(echo "$token_list" | sed -n "${pick}p")

    if [ -z "$selected_token" ]; then
        log_info "No valid token selected, creating one..."
        create_meme_token || true
        return
    fi

    # 65% buy, 35% sell
    if [ $(rand_between 1 100) -le 65 ]; then
        buy_tokens "$selected_token" || true
    else
        sell_tokens "$selected_token" || true
    fi
}

# ============================================================
# FEATURE 2: Perpetual Trading (Matching Engine API)
# Same as frontend: POST /api/order/submit (orderSigning.ts)
# ============================================================

perp_submit_order() {
    local trader=$1 token=$2 is_long=$3 size=$4 leverage=$5
    local nonce=$(get_nonce "$trader")
    local deadline=$(( $(date +%s) + 3600 ))
    local short=$(short_addr "$trader")

    # Get current price (same as frontend reads from market tickers)
    local tickers
    tickers=$(api_call "GET" "$MATCHING_ENGINE/api/v1/market/tickers")
    local price
    price=$(python3 -c "
import json
try:
    data = json.loads('''$tickers''')
    token = '$token'.lower()
    for t in data.get('data', []):
        if token in t.get('instId','').lower():
            print(t['last']); break
    else: print('0')
except: print('0')
" 2>/dev/null || echo "0")

    if [ "$price" = "0" ] || [ -z "$price" ]; then
        log_fail "[$short] No price for ${token:0:10}..."
        return 1
    fi

    local side="LONG"
    [ "$is_long" = "false" ] && side="SHORT"
    local size_eth=$(wei_to_eth "$size")
    log_trade "[$short] Perp $side ${token:0:10}... size=${size_eth} ETH lev=$leverage [same as frontend POST /api/order/submit]"

    # Build order body (same format as frontend orderSigning.ts submitOrder())
    local body="{\"trader\":\"$trader\",\"token\":\"$token\",\"isLong\":$is_long,\"size\":\"$size\",\"leverage\":\"$leverage\",\"price\":\"$price\",\"deadline\":\"$deadline\",\"nonce\":\"$nonce\",\"orderType\":\"market\",\"signature\":\"$DUMMY_SIG\",\"timeInForce\":\"GTC\"}"

    local result
    result=$(curl -s --connect-timeout 10 --max-time 60 -X POST -H "Content-Type: application/json" -d "$body" "$MATCHING_ENGINE/api/order/submit" 2>/dev/null || echo '{"error":"timeout"}')

    local success=$(json_get "success" "$result")

    # Increment nonce regardless (same as frontend)
    inc_nonce "$trader"

    if [ "$success" = "True" ] || [ "$success" = "true" ]; then
        verify_order_result "$result" "$short"
        return 0
    else
        local error=$(json_get "error" "$result")
        log_fail "[$short] Order failed: ${error:0:80}"
        return 1
    fi
}

close_position() {
    local pair_id=$1 trader=$2
    local short=$(short_addr "$trader")

    log_trade "[$short] Closing position ${pair_id:0:12}... [same as frontend POST /api/position/{id}/close]"

    local result
    result=$(api_call "POST" "$MATCHING_ENGINE/api/position/$pair_id/close" "{\"trader\":\"$trader\"}")
    local success=$(json_get "success" "$result")

    if [ "$success" = "True" ] || [ "$success" = "true" ]; then
        log_ok "[$short] Position closed"

        # Verify: check positions and balance after close
        sleep 1
        verify_positions "$trader"
        verify_balance "$trader"
        return 0
    else
        log_fail "[$short] Close failed: $(json_get "error" "$result" | head -c 80)"
        return 1
    fi
}

run_perp_cycle() {
    log_info "=== Perpetual Trading Cycle [API: same as frontend orderSigning.ts] ==="

    # Get available tokens (same as frontend reads market tickers)
    local tickers
    tickers=$(api_call "GET" "$MATCHING_ENGINE/api/v1/market/tickers")
    local token
    token=$(python3 -c "
import json, random
try:
    data = json.loads('''$tickers''')
    tokens = data.get('data', [])
    if tokens:
        t = random.choice(tokens)
        print(t['instId'].split('-')[0])
    else: print('')
except: print('')
" 2>/dev/null || echo "")

    if [ -z "$token" ]; then
        log_info "No tokens for perp trading"
        return
    fi

    # Pick two different wallets (simulates two different users)
    local pair
    pair=$(rand_pair)
    local idx_a=$(echo "$pair" | cut -d' ' -f1)
    local idx_b=$(echo "$pair" | cut -d' ' -f2)
    local addr_a="${WALLET_ADDRESSES[$idx_a]}"
    local addr_b="${WALLET_ADDRESSES[$idx_b]}"

    local action_roll=$(rand_between 1 100)

    if [ $action_roll -le 30 ]; then
        # 30%: A goes LONG, B goes SHORT (counter-parties)
        local size=$(rand_between 3 10)000000000000000  # 0.003-0.01 ETH
        local lev_choices=("2000000000000000000" "3000000000000000000" "5000000000000000000" "10000000000000000000")
        local leverage=${lev_choices[$((RANDOM % ${#lev_choices[@]}))]}

        log_info "Match pair: $(short_addr $addr_a) LONG vs $(short_addr $addr_b) SHORT"
        perp_submit_order "$addr_a" "$token" true "$size" "$leverage" || true
        sleep 1
        perp_submit_order "$addr_b" "$token" false "$size" "$leverage" || true

        # Verify both wallets after matching
        sleep 2
        log_info "--- Post-trade verification ---"
        verify_positions "$addr_a"
        verify_positions "$addr_b"
        verify_balance "$addr_a"
        verify_balance "$addr_b"
        log_frontend_url "/perp" "Orders and trades visible in order book & trade history"

    elif [ $action_roll -le 60 ]; then
        # 30%: A goes SHORT, B goes LONG
        local size=$(rand_between 3 10)000000000000000
        local lev_choices=("2000000000000000000" "5000000000000000000" "7000000000000000000")
        local leverage=${lev_choices[$((RANDOM % ${#lev_choices[@]}))]}

        log_info "Match pair: $(short_addr $addr_a) SHORT vs $(short_addr $addr_b) LONG"
        perp_submit_order "$addr_a" "$token" false "$size" "$leverage" || true
        sleep 1
        perp_submit_order "$addr_b" "$token" true "$size" "$leverage" || true

        # Verify both wallets after matching
        sleep 2
        log_info "--- Post-trade verification ---"
        verify_positions "$addr_a"
        verify_positions "$addr_b"
        verify_balance "$addr_a"
        verify_balance "$addr_b"
        log_frontend_url "/perp" "Orders and trades visible in order book & trade history"

    else
        # 40%: Close a random position
        local close_idx=$(rand_wallet)
        local close_addr="${WALLET_ADDRESSES[$close_idx]}"

        local positions
        positions=$(api_call "GET" "$MATCHING_ENGINE/api/user/$close_addr/positions")
        local pair_id
        pair_id=$(python3 -c "
import json, random
try:
    data = json.loads('''$positions''')
    if isinstance(data, list) and len(data) > 0:
        print(random.choice(data).get('pairId',''))
    else: print('')
except: print('')
" 2>/dev/null || echo "")

        if [ -n "$pair_id" ]; then
            close_position "$pair_id" "$close_addr" || true
            log_frontend_url "/perp" "Position close visible in trade history"
        else
            # No position to close -> open a new pair instead
            local size=$(rand_between 2 5)000000000000000
            log_info "No positions for $(short_addr $close_addr), opening new pair..."
            perp_submit_order "$addr_a" "$token" true "$size" "3000000000000000000" || true
            sleep 1
            perp_submit_order "$addr_b" "$token" false "$size" "3000000000000000000" || true

            sleep 2
            log_info "--- Post-trade verification ---"
            verify_positions "$addr_a"
            verify_positions "$addr_b"
            log_frontend_url "/perp" "New positions visible in order book & trade history"
        fi
    fi
}

# ============================================================
# FEATURE 3: Lending (On-chain LendingPool)
# Same as frontend: useWriteContract → LendingPool.deposit/withdraw/claimInterest
# ============================================================

run_lending_cycle() {
    log_info "=== Lending Cycle [On-chain: same as frontend useLendingPool] ==="

    local enabled_tokens
    enabled_tokens=$(cast call "$LENDING_POOL_ADDRESS" "getEnabledTokens()(address[])" --rpc-url "$RPC_URL" 2>/dev/null || echo "")

    if [ -z "$enabled_tokens" ] || [ "$enabled_tokens" = "[]" ]; then
        log_info "No lending pools enabled (need to enable tokens in LendingPool contract first)"
        return
    fi

    local first_token
    first_token=$(echo "$enabled_tokens" | tr -d '[]' | tr ',' '\n' | tr -d ' ' | head -1)
    if [ -z "$first_token" ] || [ "$first_token" = "()" ]; then return; fi

    # Pick random wallet for lending
    local idx=$(rand_wallet)
    local key="${WALLET_KEYS[$idx]}"
    local addr="${WALLET_ADDRESSES[$idx]}"
    local short=$(short_addr "$addr")
    local action_roll=$(rand_between 1 100)

    if [ $action_roll -le 50 ]; then
        # Deposit tokens to lending pool
        local balance
        balance=$(cast call "$first_token" "balanceOf(address)(uint256)" "$addr" --rpc-url "$RPC_URL" 2>/dev/null || echo "0")
        if [ -n "$balance" ] && [ "$balance" != "0" ]; then
            local deposit_amount
            deposit_amount=$(python3 -c "print(int('$balance') // 4)" 2>/dev/null || echo "0")
            if [ "$deposit_amount" != "0" ]; then
                log_trade "[$short] Lending deposit [same as frontend LendingPool.deposit()]"

                # Approve + Deposit (same two-step as frontend)
                cast send "$first_token" "approve(address,uint256)" "$LENDING_POOL_ADDRESS" "$deposit_amount" \
                    --rpc-url "$RPC_URL" --private-key "$key" > /dev/null 2>&1 || true

                local tx_result
                tx_result=$(cast send "$LENDING_POOL_ADDRESS" "deposit(address,uint256)" "$first_token" "$deposit_amount" \
                    --rpc-url "$RPC_URL" --private-key "$key" --json 2>/dev/null || echo '{}')

                local tx_hash
                tx_hash=$(json_parse "print(d.get('transactionHash',''))" "$tx_result")
                if [ -n "$tx_hash" ] && [ "$tx_hash" != "" ]; then
                    log_ok "[$short] Lending deposit OK"
                    log_tx "$tx_hash"
                    log_frontend_url "/lend" "Deposit visible in lending pools"
                else
                    log_fail "[$short] Lending deposit failed"
                fi
            fi
        else
            log_info "[$short] No tokens for lending"
        fi
    elif [ $action_roll -le 80 ]; then
        # Claim interest
        log_trade "[$short] Claiming interest [same as frontend LendingPool.claimInterest()]"
        local tx_result
        tx_result=$(cast send "$LENDING_POOL_ADDRESS" "claimInterest(address)" "$first_token" \
            --rpc-url "$RPC_URL" --private-key "$key" --json 2>/dev/null || echo '{}')

        local tx_hash
        tx_hash=$(json_parse "print(d.get('transactionHash',''))" "$tx_result")
        if [ -n "$tx_hash" ] && [ "$tx_hash" != "" ]; then
            log_ok "[$short] Interest claimed"
            log_tx "$tx_hash"
        else
            log_info "[$short] No interest to claim"
        fi
    else
        # Withdraw
        local shares
        shares=$(cast call "$LENDING_POOL_ADDRESS" "getUserShares(address,address)(uint256)" "$first_token" "$addr" \
            --rpc-url "$RPC_URL" 2>/dev/null || echo "0")
        if [ -n "$shares" ] && [ "$shares" != "0" ]; then
            local ws
            ws=$(python3 -c "print(int('$shares') // 4)" 2>/dev/null || echo "0")
            if [ "$ws" != "0" ]; then
                log_trade "[$short] Lending withdraw [same as frontend LendingPool.withdraw()]"
                local tx_result
                tx_result=$(cast send "$LENDING_POOL_ADDRESS" "withdraw(address,uint256)" "$first_token" "$ws" \
                    --rpc-url "$RPC_URL" --private-key "$key" --json 2>/dev/null || echo '{}')

                local tx_hash
                tx_hash=$(json_parse "print(d.get('transactionHash',''))" "$tx_result")
                if [ -n "$tx_hash" ] && [ "$tx_hash" != "" ]; then
                    log_ok "[$short] Withdrawal OK"
                    log_tx "$tx_hash"
                    log_frontend_url "/lend" "Withdrawal visible in lending pools"
                else
                    log_fail "[$short] Withdrawal failed"
                fi
            fi
        else
            log_info "[$short] No lending shares"
        fi
    fi
}

# ============================================================
# Periodic State Monitor
# ============================================================

monitor_state() {
    log_info "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    log_info "📊 Portfolio Snapshot (sampling 3 of $NUM_WALLETS wallets)"
    log_info "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    local sample_count=3
    if [ ${#WALLET_ADDRESSES[@]} -lt $sample_count ]; then
        sample_count=${#WALLET_ADDRESSES[@]}
    fi
    for i in $(seq 0 $((sample_count - 1))); do
        local addr="${WALLET_ADDRESSES[$i]}"
        verify_balance "$addr"
        verify_positions "$addr"
    done

    # Also check market data
    local tickers
    tickers=$(api_call "GET" "$MATCHING_ENGINE/api/v1/market/tickers")
    local market_count
    market_count=$(python3 -c "
import json
try:
    data = json.loads('''$tickers''')
    tokens = data.get('data', [])
    print(len(tokens))
except: print(0)
" 2>/dev/null || echo "0")
    log_info "📈 Active markets: $market_count"
    log_info "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
}

# ============================================================
# Main
# ============================================================

echo ""
echo -e "${CYAN}════════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  MEME Perp DEX - Human-Like Trading Bot (${NUM_WALLETS} wallets)${NC}"
echo -e "${CYAN}════════════════════════════════════════════════════════════${NC}"
echo -e "  Mode:       $([ "$ONCE_MODE" = true ] && echo 'Single cycle' || echo '24h continuous')"
echo -e "  Wallets:    $NUM_WALLETS (from main-wallets.json)"
echo -e "  RPC:        ${RPC_URL:0:50}..."
echo -e "  Engine:     $MATCHING_ENGINE"
echo -e "  Settlement: ${SETTLEMENT_ADDRESS:0:20}..."
echo -e "  Explorer:   $BLOCK_EXPLORER"
echo -e "  Log:        $BOT_LOG"
echo -e "${CYAN}════════════════════════════════════════════════════════════${NC}"
echo ""

echo $$ > "$PID_DIR/trading-bot.pid"

# Pre-flight checks
me_health=$(curl -s -o /dev/null -w "%{http_code}" "$MATCHING_ENGINE/health" 2>/dev/null || echo "000")
if [ "$me_health" != "200" ]; then
    log_fail "Matching engine not reachable at $MATCHING_ENGINE"
    exit 1
fi
log_ok "Matching engine healthy"

if ! command -v cast &> /dev/null; then
    log_fail "'cast' not found (install foundry)"
    exit 1
fi

# Load wallets from JSON
load_wallets

# Fund + on-chain deposit + sync all wallets
setup_wallets

# Frontend visibility guide
echo ""
echo -e "${CYAN}════════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  ✅ Setup Complete - Frontend Visibility Guide${NC}"
echo -e "${CYAN}════════════════════════════════════════════════════════════${NC}"
echo -e "  Discovery page:  ${YELLOW}http://localhost:3000/${NC}"
echo -e "  Perp trading:    ${YELLOW}http://localhost:3000/perp${NC}"
echo -e "  Spot trading:    ${YELLOW}http://localhost:3000/exchange${NC}"
echo -e "  Lending:         ${YELLOW}http://localhost:3000/lend${NC}"
echo -e ""
echo -e "  ${GREEN}Visible WITHOUT wallet connection:${NC}"
echo -e "    - Order book (all perp orders from all wallets)"
echo -e "    - Recent trades (all executed trades)"
echo -e "    - Price charts & market data"
echo -e "    - Token list & rankings"
echo -e ""
echo -e "  ${YELLOW}Visible WITH wallet connection:${NC}"
echo -e "    - Personal positions, orders, balance"
echo -e "    - (Connect any test wallet to see its data)"
echo -e "${CYAN}════════════════════════════════════════════════════════════${NC}"
echo ""

LAST_SPOT_TIME=0
LAST_PERP_TIME=0
LAST_LENDING_TIME=0

trap 'log_info "Bot interrupted. Cycles: $CYCLE_COUNT"; rm -f "$PID_DIR/trading-bot.pid"; exit 0' INT TERM

CONSECUTIVE_FAILURES=0
MAX_CONSECUTIVE_FAILURES=10

while true; do
    CYCLE_COUNT=$((CYCLE_COUNT + 1))
    local_elapsed=$(elapsed_time)

    log_info "━━━ Cycle #$CYCLE_COUNT (${local_elapsed}s / ${DURATION_24H}s) | ${NUM_WALLETS} wallets ━━━"

    # Health check at start of each cycle
    HEALTH_RESULT=$(curl -s --connect-timeout 5 --max-time 10 "$MATCHING_ENGINE/health" 2>/dev/null || echo '{"status":"error"}')
    ENGINE_STATUS=$(json_get "status" "$HEALTH_RESULT")
    if [ "$ENGINE_STATUS" != "ok" ]; then
        CONSECUTIVE_FAILURES=$((CONSECUTIVE_FAILURES + 1))
        log_fail "Matching engine unhealthy (attempt $CONSECUTIVE_FAILURES/$MAX_CONSECUTIVE_FAILURES)"
        if [ $CONSECUTIVE_FAILURES -ge $MAX_CONSECUTIVE_FAILURES ]; then
            log_fail "Too many consecutive failures, stopping bot"
            break
        fi
        log_info "Waiting 30s before retry..."
        sleep 30
        continue
    fi
    CONSECUTIVE_FAILURES=0

    NOW=$(date +%s)
    CYCLE_ACTIONS=0

    if [ "$PERP_ONLY" != true ] && [ $((NOW - LAST_SPOT_TIME)) -ge $SPOT_INTERVAL ]; then
        run_spot_cycle || true
        LAST_SPOT_TIME=$NOW
        CYCLE_ACTIONS=$((CYCLE_ACTIONS + 1))
    fi

    if [ "$SPOT_ONLY" != true ] && [ $((NOW - LAST_PERP_TIME)) -ge $PERP_INTERVAL ]; then
        run_perp_cycle || true
        LAST_PERP_TIME=$NOW
        CYCLE_ACTIONS=$((CYCLE_ACTIONS + 1))
    fi

    if [ "$PERP_ONLY" != true ] && [ "$SPOT_ONLY" != true ] && [ $((NOW - LAST_LENDING_TIME)) -ge $LENDING_INTERVAL ]; then
        run_lending_cycle || true
        LAST_LENDING_TIME=$NOW
        CYCLE_ACTIONS=$((CYCLE_ACTIONS + 1))
    fi

    if [ $CYCLE_ACTIONS -eq 0 ]; then
        log_info "(idle cycle — waiting for interval timers)"
    fi

    # Periodic state monitor every 5 cycles
    if [ $((CYCLE_COUNT % 5)) -eq 0 ]; then
        monitor_state
    fi

    if [ "$ONCE_MODE" != true ] && [ $local_elapsed -ge $DURATION_24H ]; then
        log_ok "24h completed! Cycles: $CYCLE_COUNT"
        break
    fi

    if [ "$ONCE_MODE" = true ]; then
        log_info "--- Final State ---"
        monitor_state
        log_ok "Single cycle done"
        break
    fi

    sleep $(rand_between 15 30)
done

rm -f "$PID_DIR/trading-bot.pid"
log_ok "Bot stopped. Total cycles: $CYCLE_COUNT"
