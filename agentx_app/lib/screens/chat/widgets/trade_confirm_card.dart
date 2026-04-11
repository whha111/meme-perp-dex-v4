import 'package:flutter/material.dart';
import '../../../core/theme/app_theme.dart';
import '../../../models/chat_message.dart';

/// Inline card shown when AI executes a tool call (e.g., check balance, place order)
/// This makes the AI's "thinking" transparent to the user
class TradeConfirmCard extends StatelessWidget {
  final ToolCall toolCall;

  const TradeConfirmCard({super.key, required this.toolCall});

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.only(left: 40),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: AppTheme.purpleStart.withValues(alpha: 0.08),
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: AppTheme.purpleStart.withValues(alpha: 0.2)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // Tool name header
          Row(
            children: [
              Icon(_iconForTool(toolCall.name),
                  size: 14, color: AppTheme.purpleStart),
              const SizedBox(width: 6),
              Text(
                _labelForTool(toolCall.name),
                style: const TextStyle(
                  fontSize: 12,
                  fontWeight: FontWeight.w600,
                  color: AppTheme.purpleStart,
                ),
              ),
              const Spacer(),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                decoration: BoxDecoration(
                  color: AppTheme.green.withValues(alpha: 0.15),
                  borderRadius: BorderRadius.circular(4),
                ),
                child: const Text(
                  '已执行',
                  style: TextStyle(
                    fontSize: 10,
                    color: AppTheme.green,
                    fontWeight: FontWeight.w500,
                  ),
                ),
              ),
            ],
          ),

          // Arguments preview
          if (toolCall.arguments.isNotEmpty) ...[
            const SizedBox(height: 8),
            ...toolCall.arguments.entries.take(3).map((e) => Padding(
                  padding: const EdgeInsets.only(bottom: 2),
                  child: Row(
                    children: [
                      Text(
                        '${e.key}: ',
                        style: const TextStyle(
                            fontSize: 11, color: AppTheme.textDim),
                      ),
                      Flexible(
                        child: Text(
                          '${e.value}',
                          style: const TextStyle(
                              fontSize: 11, color: AppTheme.textSecondary),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                    ],
                  ),
                )),
          ],
        ],
      ),
    );
  }

  IconData _iconForTool(String name) {
    switch (name) {
      case 'get_balance':
        return Icons.account_balance_wallet;
      case 'get_positions':
        return Icons.pie_chart;
      case 'get_token_price':
      case 'get_market_overview':
        return Icons.show_chart;
      case 'place_order':
        return Icons.swap_vert;
      case 'close_position':
        return Icons.close;
      case 'check_contract_safety':
      case 'check_holder_concentration':
        return Icons.shield;
      case 'analyze_trade_history':
      case 'get_pnl_summary':
        return Icons.analytics;
      default:
        return Icons.extension;
    }
  }

  String _labelForTool(String name) {
    switch (name) {
      case 'get_balance':
        return '查询余额';
      case 'get_positions':
        return '查询持仓';
      case 'get_token_price':
        return '获取价格';
      case 'get_market_overview':
        return '市场概览';
      case 'place_order':
        return '提交订单';
      case 'close_position':
        return '平仓操作';
      case 'check_contract_safety':
        return '合约安全检查';
      case 'check_holder_concentration':
        return '持仓集中度分析';
      case 'analyze_trade_history':
        return '交易历史分析';
      case 'get_pnl_summary':
        return '盈亏汇总';
      default:
        return name;
    }
  }
}
