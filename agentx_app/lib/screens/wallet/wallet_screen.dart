import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';
import 'package:google_sign_in_platform_interface/google_sign_in_platform_interface.dart';
import 'package:google_sign_in_web/google_sign_in_web.dart';
import '../../core/theme/app_theme.dart';
import '../../models/agent.dart';
import '../../providers/agent_store.dart';
import '../../providers/wallet_provider.dart';
import '../../services/api/dexi_api.dart';
import '../../services/chat_fee_service.dart';

/// Wallet screen — shows real balance, held agent tokens, and transaction history
class WalletScreen extends StatefulWidget {
  const WalletScreen({super.key});

  @override
  State<WalletScreen> createState() => _WalletScreenState();
}

class _WalletScreenState extends State<WalletScreen> {
  List<Map<String, dynamic>> _trades = [];
  bool _loadingTrades = false;

  @override
  void initState() {
    super.initState();
    _loadData();
  }

  Future<void> _loadData() async {
    final wallet = context.read<WalletProvider>();
    if (!wallet.isConnected) return;

    // Refresh balance
    wallet.refreshBalance();

    // Fetch trade history from DEXI
    setState(() => _loadingTrades = true);
    try {
      final api = DexiApi();
      final trades = await api.getTrades(wallet.addressHex!);
      if (mounted) setState(() => _trades = trades);
    } catch (_) {}
    if (mounted) setState(() => _loadingTrades = false);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        bottom: false,
        child: Consumer<WalletProvider>(
          builder: (context, wallet, _) {
            if (!wallet.isConnected) return _buildNotConnected(context);
            return _buildWalletContent(context, wallet);
          },
        ),
      ),
    );
  }

  Widget _buildNotConnected(BuildContext context) {
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(Icons.account_balance_wallet_outlined,
              size: 56, color: AppTheme.textDim),
          const SizedBox(height: 16),
          const Text(
            '请先登录',
            style: TextStyle(
              fontSize: 18,
              fontWeight: FontWeight.w600,
              color: AppTheme.textPrimary,
            ),
          ),
          const SizedBox(height: 8),
          Text(
            '使用 Google 账号登录，自动创建钱包',
            style: TextStyle(fontSize: 14, color: AppTheme.textMuted),
          ),
          const SizedBox(height: 24),
          Builder(
            builder: (context) {
              final plugin = GoogleSignInPlatform.instance;
              if (plugin is GoogleSignInPlugin) {
                return SizedBox(
                  width: 240,
                  height: 44,
                  child: plugin.renderButton(
                    configuration: GSIButtonConfiguration(
                      theme: GSIButtonTheme.filledBlue,
                      size: GSIButtonSize.large,
                      text: GSIButtonText.signinWith,
                      shape: GSIButtonShape.pill,
                    ),
                  ),
                );
              }
              return const SizedBox.shrink();
            },
          ),
        ],
      ),
    );
  }

  Widget _buildWalletContent(BuildContext context, WalletProvider wallet) {
    final address = wallet.addressHex!;
    final feeService = context.watch<ChatFeeService>();
    final agentStore = context.watch<AgentStore>();

    // Get agents user actually holds tokens for
    final heldAgents = agentStore.allAgents.where((a) {
      return feeService.getHolding(a.id) > 0;
    }).toList();

    return RefreshIndicator(
      onRefresh: _loadData,
      color: AppTheme.purpleStart,
      child: CustomScrollView(
        slivers: [
          // Header
          SliverToBoxAdapter(
            child: Padding(
              padding: const EdgeInsets.fromLTRB(20, 16, 20, 0),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  const Text(
                    '钱包',
                    style: TextStyle(
                      fontSize: 22,
                      fontWeight: FontWeight.w700,
                      color: AppTheme.textPrimary,
                    ),
                  ),
                  GestureDetector(
                    onTap: () {
                      Clipboard.setData(ClipboardData(text: address));
                      ScaffoldMessenger.of(context).showSnackBar(
                        const SnackBar(
                          content: Text('地址已复制'),
                          duration: Duration(seconds: 1),
                        ),
                      );
                    },
                    child: Container(
                      width: 36,
                      height: 36,
                      decoration: BoxDecoration(
                        color: const Color(0x08FFFFFF),
                        borderRadius: BorderRadius.circular(12),
                        border: Border.all(color: const Color(0x10FFFFFF)),
                      ),
                      child: const Icon(Icons.qr_code_scanner,
                          size: 18, color: Color(0x99FFFFFF)),
                    ),
                  ),
                ],
              ),
            ),
          ),

          // Balance card — real data from WalletProvider
          SliverToBoxAdapter(child: _buildBalanceCard(context, wallet)),

          // Held agents section
          SliverToBoxAdapter(
            child: Padding(
              padding: const EdgeInsets.fromLTRB(20, 24, 20, 12),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  Text(
                    '持有的智能体 (${heldAgents.length})',
                    style: const TextStyle(
                      fontSize: 16,
                      fontWeight: FontWeight.w700,
                      color: AppTheme.textPrimary,
                    ),
                  ),
                  if (heldAgents.length > 3)
                    Text(
                      '查看全部 →',
                      style: TextStyle(fontSize: 12, color: const Color(0x60FFFFFF)),
                    ),
                ],
              ),
            ),
          ),

          // Held agent list — from fee service real holdings
          if (heldAgents.isEmpty)
            SliverToBoxAdapter(
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 16),
                child: Text(
                  '暂无持有的智能体 Token\n去市场买入后即可在此查看',
                  textAlign: TextAlign.center,
                  style: TextStyle(fontSize: 13, color: AppTheme.textDim),
                ),
              ),
            )
          else
            SliverPadding(
              padding: const EdgeInsets.fromLTRB(16, 0, 16, 0),
              sliver: SliverList(
                delegate: SliverChildBuilderDelegate(
                  (context, index) =>
                      _buildHeldAgentTile(heldAgents[index], feeService),
                  childCount: heldAgents.length,
                ),
              ),
            ),

          // Transaction history header
          SliverToBoxAdapter(
            child: Padding(
              padding: const EdgeInsets.fromLTRB(20, 24, 20, 12),
              child: const Text(
                '最近交易',
                style: TextStyle(
                  fontSize: 16,
                  fontWeight: FontWeight.w700,
                  color: AppTheme.textPrimary,
                ),
              ),
            ),
          ),

          // Transaction list — from DEXI API
          if (_loadingTrades)
            const SliverToBoxAdapter(
              child: Padding(
                padding: EdgeInsets.all(20),
                child: Center(
                  child: SizedBox(
                    width: 20,
                    height: 20,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  ),
                ),
              ),
            )
          else if (_trades.isEmpty)
            SliverToBoxAdapter(
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 16),
                child: Text(
                  '暂无交易记录',
                  textAlign: TextAlign.center,
                  style: TextStyle(fontSize: 13, color: AppTheme.textDim),
                ),
              ),
            )
          else
            SliverPadding(
              padding: const EdgeInsets.fromLTRB(16, 0, 16, 100),
              sliver: SliverList(
                delegate: SliverChildBuilderDelegate(
                  (context, index) => _buildTransactionTile(_trades[index]),
                  childCount: _trades.length,
                ),
              ),
            ),

          // Bottom padding if no trades
          if (_trades.isEmpty)
            const SliverToBoxAdapter(child: SizedBox(height: 100)),
        ],
      ),
    );
  }

  Widget _buildBalanceCard(BuildContext context, WalletProvider wallet) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 20, 16, 0),
      child: Container(
        padding: const EdgeInsets.all(24),
        decoration: BoxDecoration(
          gradient: const LinearGradient(
            colors: [Color(0xFF7C3AED), Color(0xFF9333EA), Color(0xFFEC4899)],
            begin: Alignment.topLeft,
            end: Alignment.bottomRight,
          ),
          borderRadius: BorderRadius.circular(24),
          boxShadow: [
            BoxShadow(
              color: AppTheme.purpleStart.withValues(alpha: 0.4),
              blurRadius: 30,
              offset: const Offset(0, 12),
            ),
          ],
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Text(
                  '总资产 (BNB)',
                  style: TextStyle(
                      fontSize: 13,
                      fontWeight: FontWeight.w500,
                      color: Colors.white.withValues(alpha: 0.73)),
                ),
                const Spacer(),
                // Address chip
                GestureDetector(
                  onTap: () {
                    Clipboard.setData(ClipboardData(text: wallet.addressHex!));
                    ScaffoldMessenger.of(context).showSnackBar(
                      const SnackBar(
                        content: Text('地址已复制'),
                        duration: Duration(seconds: 1),
                      ),
                    );
                  },
                  child: Container(
                    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                    decoration: BoxDecoration(
                      color: Colors.white.withValues(alpha: 0.15),
                      borderRadius: BorderRadius.circular(8),
                    ),
                    child: Text(
                      wallet.addressShort,
                      style: TextStyle(
                        fontSize: 11,
                        color: Colors.white.withValues(alpha: 0.8),
                      ),
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 8),
            // Real balance from WalletProvider
            Text(
              wallet.balanceFormatted,
              style: const TextStyle(
                fontSize: 36,
                fontWeight: FontWeight.w800,
                color: Colors.white,
                letterSpacing: -1,
              ),
            ),
            const SizedBox(height: 4),
            Text(
              wallet.balance == BigInt.zero
                  ? '钱包暂无余额'
                  : '≈ \$${(wallet.balanceBnb * 600).toStringAsFixed(2)}',
              style: TextStyle(
                  fontSize: 14,
                  fontWeight: FontWeight.w500,
                  color: Colors.white.withValues(alpha: 0.67)),
            ),
            const SizedBox(height: 20),
            // Action buttons
            Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                _buildCardAction(context, Icons.arrow_downward, '充值', () {
                  // Show address for deposit
                  Clipboard.setData(ClipboardData(text: wallet.addressHex!));
                  ScaffoldMessenger.of(context).showSnackBar(
                    SnackBar(
                      content: Text('充值地址已复制:\n${wallet.addressHex}'),
                      duration: const Duration(seconds: 3),
                    ),
                  );
                }),
                const SizedBox(width: 12),
                _buildCardAction(context, Icons.refresh, '刷新', () {
                  wallet.refreshBalance();
                  _loadData();
                }),
                const SizedBox(width: 12),
                _buildCardAction(context, Icons.receipt_long, '记录', () {
                  ScaffoldMessenger.of(context).showSnackBar(
                    const SnackBar(
                      content: Text('交易记录见下方'),
                      duration: Duration(seconds: 1),
                    ),
                  );
                }),
              ],
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildCardAction(
      BuildContext context, IconData icon, String label, VoidCallback onTap) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        width: 85,
        height: 38,
        decoration: BoxDecoration(
          color: Colors.white.withValues(alpha: 0.15),
          borderRadius: BorderRadius.circular(14),
        ),
        child: Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(icon, size: 16, color: Colors.white),
            const SizedBox(width: 6),
            Text(
              label,
              style: const TextStyle(
                fontSize: 13,
                fontWeight: FontWeight.w600,
                color: Colors.white,
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildHeldAgentTile(Agent agent, ChatFeeService feeService) {
    final holding = feeService.getHolding(agent.id);
    final colors = {
      '金融': (const Color(0x30A78BFA), const Color(0xFFA78BFA)),
      '教育': (const Color(0x3060A5FA), const Color(0xFF60A5FA)),
      '娱乐': (const Color(0x30FBBF24), const Color(0xFFFBBF24)),
      '工具': (const Color(0x3034D399), const Color(0xFF34D399)),
      '生活': (const Color(0x30F87171), const Color(0xFFF87171)),
    };
    final pair =
        colors[agent.category] ?? (const Color(0x30A78BFA), const Color(0xFFA78BFA));

    return Container(
      margin: const EdgeInsets.only(bottom: 10),
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
      decoration: BoxDecoration(
        color: const Color(0x08FFFFFF),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: const Color(0x0AFFFFFF)),
      ),
      child: Row(
        children: [
          Container(
            width: 44,
            height: 44,
            decoration: BoxDecoration(
              color: pair.$1,
              borderRadius: BorderRadius.circular(14),
            ),
            child: Center(
              child: Text(agent.emoji, style: const TextStyle(fontSize: 22)),
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  agent.name,
                  style: const TextStyle(
                    fontSize: 14,
                    fontWeight: FontWeight.w600,
                    color: AppTheme.textPrimary,
                  ),
                ),
                const SizedBox(height: 3),
                Text(
                  '持有 ${holding.toStringAsFixed(1)} 个 Token',
                  style: const TextStyle(fontSize: 11, color: Color(0x60FFFFFF)),
                ),
              ],
            ),
          ),
          Column(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Text(
                agent.priceFormatted,
                style: const TextStyle(
                  fontSize: 15,
                  fontWeight: FontWeight.w700,
                  color: AppTheme.textPrimary,
                ),
              ),
              const SizedBox(height: 3),
              Text(
                agent.changeFormatted,
                style: TextStyle(
                  fontSize: 11,
                  fontWeight: FontWeight.w500,
                  color: agent.isPositive ? AppTheme.green : AppTheme.red,
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _buildTransactionTile(Map<String, dynamic> trade) {
    final side = trade['side']?.toString() ?? '';
    final isBuy = side.toLowerCase() == 'buy' || side.toLowerCase() == 'long';
    final symbol = trade['symbol']?.toString() ?? trade['token']?.toString() ?? '?';
    final size = trade['size']?.toString() ?? trade['amount']?.toString() ?? '0';
    final price = trade['price']?.toString() ?? '0';
    final time = trade['timestamp']?.toString() ?? trade['time']?.toString() ?? '';

    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
      decoration: BoxDecoration(
        color: const Color(0x06FFFFFF),
        borderRadius: BorderRadius.circular(12),
      ),
      child: Row(
        children: [
          Container(
            width: 32,
            height: 32,
            decoration: BoxDecoration(
              color: (isBuy ? AppTheme.green : AppTheme.red).withValues(alpha: 0.1),
              borderRadius: BorderRadius.circular(10),
            ),
            child: Icon(
              isBuy ? Icons.arrow_downward : Icons.arrow_upward,
              size: 16,
              color: isBuy ? AppTheme.green : AppTheme.red,
            ),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  '${isBuy ? "买入" : "卖出"} $symbol',
                  style: const TextStyle(
                    fontSize: 13,
                    fontWeight: FontWeight.w500,
                    color: AppTheme.textPrimary,
                  ),
                ),
                const SizedBox(height: 2),
                Text(
                  time.isNotEmpty ? time : 'Price: $price',
                  style: const TextStyle(fontSize: 11, color: Color(0x50FFFFFF)),
                ),
              ],
            ),
          ),
          Text(
            '${isBuy ? "-" : "+"}$size BNB',
            style: TextStyle(
              fontSize: 13,
              fontWeight: FontWeight.w600,
              color: isBuy ? AppTheme.red : AppTheme.green,
            ),
          ),
        ],
      ),
    );
  }
}
