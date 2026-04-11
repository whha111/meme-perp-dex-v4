import 'dart:ui';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:web3dart/web3dart.dart';
import '../../core/theme/app_theme.dart';
import '../../models/agent.dart';
import '../../providers/chat_history.dart';
import '../../providers/chat_provider.dart';
import '../../providers/wallet_provider.dart';
import '../../services/api/dexi_api.dart';
import '../../services/chat_fee_service.dart';
import '../../services/contract/order_service.dart';
import 'widgets/message_bubble.dart';
import 'widgets/trade_confirm_card.dart';
import 'widgets/typing_indicator.dart';

/// Core AI chat screen — DeepSeek Function Calling powers the conversation
/// User talks naturally → AI decides when to call tools (get_balance, place_order, etc.)
class ChatScreen extends StatefulWidget {
  final Agent agent;

  const ChatScreen({super.key, required this.agent});

  @override
  State<ChatScreen> createState() => _ChatScreenState();
}

class _ChatScreenState extends State<ChatScreen> {
  final _controller = TextEditingController();
  final _scrollController = ScrollController();
  final _focusNode = FocusNode();

  @override
  void initState() {
    super.initState();
    // Set agent context in provider with ID for fee tracking
    WidgetsBinding.instance.addPostFrameCallback((_) {
      context.read<ChatProvider>().setAgent(
            widget.agent.name,
            agentId: widget.agent.id,
          );
    });
  }

  @override
  void dispose() {
    _controller.dispose();
    _scrollController.dispose();
    _focusNode.dispose();
    super.dispose();
  }

  void _scrollToBottom() {
    if (_scrollController.hasClients) {
      Future.delayed(const Duration(milliseconds: 100), () {
        _scrollController.animateTo(
          _scrollController.position.maxScrollExtent,
          duration: const Duration(milliseconds: 300),
          curve: Curves.easeOut,
        );
      });
    }
  }

  void _sendMessage() {
    final text = _controller.text.trim();
    if (text.isEmpty) return;
    _controller.clear();
    context.read<ChatProvider>().sendMessage(text);
    // Record in chat history for the chat list screen
    context.read<ChatHistory>().recordChat(widget.agent, text);
    _scrollToBottom();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Column(
        children: [
          _buildAppBar(),
          Expanded(child: _buildMessageList()),
          _buildInputBar(),
        ],
      ),
    );
  }

  Widget _buildAppBar() {
    return Container(
      padding: EdgeInsets.only(top: MediaQuery.of(context).padding.top),
      decoration: BoxDecoration(
        color: AppTheme.surface,
        border: Border(bottom: BorderSide(color: AppTheme.glassBorder)),
      ),
      child: SizedBox(
        height: 56,
        child: Row(
          children: [
            // Back button
            IconButton(
              icon: const Icon(Icons.arrow_back_ios_new, size: 18),
              color: AppTheme.textSecondary,
              onPressed: () {
                context.read<ChatProvider>().clearMessages();
                Navigator.of(context).pop();
              },
            ),
            // Agent info
            Container(
              width: 36,
              height: 36,
              decoration: BoxDecoration(
                color: AppTheme.purpleStart.withValues(alpha: 0.15),
                borderRadius: BorderRadius.circular(12),
              ),
              child: Center(
                child: Text(widget.agent.emoji,
                    style: const TextStyle(fontSize: 18)),
              ),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    widget.agent.name,
                    style: const TextStyle(
                      fontSize: 15,
                      fontWeight: FontWeight.w600,
                      color: AppTheme.textPrimary,
                    ),
                  ),
                  Row(
                    children: [
                      Text(
                        widget.agent.priceFormatted,
                        style: const TextStyle(
                            fontSize: 12, color: AppTheme.textMuted),
                      ),
                      const SizedBox(width: 6),
                      Text(
                        widget.agent.changeFormatted,
                        style: TextStyle(
                          fontSize: 12,
                          fontWeight: FontWeight.w600,
                          color: widget.agent.isPositive
                              ? AppTheme.green
                              : AppTheme.red,
                        ),
                      ),
                    ],
                  ),
                ],
              ),
            ),
            // Trade button
            _buildTradeButton(),
            const SizedBox(width: 8),
          ],
        ),
      ),
    );
  }

  Widget _buildTradeButton() {
    return GestureDetector(
      onTap: () => _showTradeSheet(),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 7),
        decoration: BoxDecoration(
          gradient: AppTheme.purpleGradient,
          borderRadius: BorderRadius.circular(16),
        ),
        child: const Text(
          '交易',
          style: TextStyle(
            fontSize: 13,
            fontWeight: FontWeight.w600,
            color: Colors.white,
          ),
        ),
      ),
    );
  }

  Widget _buildMessageList() {
    return Consumer<ChatProvider>(
      builder: (context, chat, _) {
        WidgetsBinding.instance.addPostFrameCallback((_) => _scrollToBottom());
        return ListView.builder(
          controller: _scrollController,
          padding: const EdgeInsets.fromLTRB(16, 16, 16, 8),
          itemCount: chat.messages.length + (chat.isLoading ? 1 : 0),
          itemBuilder: (context, index) {
            // Typing indicator
            if (index == chat.messages.length) {
              return const Padding(
                padding: EdgeInsets.only(bottom: 8),
                child: TypingIndicator(),
              );
            }

            final msg = chat.messages[index];

            // Tool call results → show as confirm card
            if (msg.toolCalls != null && msg.toolCalls!.isNotEmpty) {
              return Padding(
                padding: const EdgeInsets.only(bottom: 8),
                child: Column(
                  children: [
                    ...msg.toolCalls!.map((tc) => Padding(
                          padding: const EdgeInsets.only(bottom: 6),
                          child: TradeConfirmCard(toolCall: tc),
                        )),
                    MessageBubble(message: msg, agentEmoji: widget.agent.emoji),
                  ],
                ),
              );
            }

            return Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: MessageBubble(
                  message: msg, agentEmoji: widget.agent.emoji),
            );
          },
        );
      },
    );
  }

  Widget _buildInputBar() {
    return Consumer<ChatProvider>(
      builder: (context, chat, _) {
        final canChat = chat.canChat;
        final remaining = chat.remainingMessages;

        return Container(
          padding: EdgeInsets.fromLTRB(
              12, 0, 12, MediaQuery.of(context).padding.bottom + 8),
          decoration: BoxDecoration(
            color: AppTheme.surface,
            border: Border(top: BorderSide(color: AppTheme.glassBorder)),
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              // Fee info bar
              Padding(
                padding: const EdgeInsets.fromLTRB(4, 6, 4, 4),
                child: Row(
                  children: [
                    Icon(
                      canChat ? Icons.token : Icons.lock_outline,
                      size: 12,
                      color: canChat ? const Color(0xFFA78BFA) : AppTheme.red,
                    ),
                    const SizedBox(width: 4),
                    Text(
                      canChat
                          ? '持有 ${chat.currentHolding.toStringAsFixed(1)} Token · 剩余 $remaining 条消息'
                          : '需持有 Token 才能聊天',
                      style: TextStyle(
                        fontSize: 11,
                        color: canChat
                            ? const Color(0x60FFFFFF)
                            : AppTheme.red.withValues(alpha: 0.8),
                      ),
                    ),
                    const Spacer(),
                    if (canChat)
                      Text(
                        '${0.001}/条',
                        style: const TextStyle(
                          fontSize: 10,
                          color: Color(0x40FFFFFF),
                        ),
                      ),
                  ],
                ),
              ),
              // Input row
              Row(
                children: [
                  // Input field
                  Expanded(
                    child: Container(
                      constraints: const BoxConstraints(maxHeight: 120),
                      decoration: BoxDecoration(
                        color: AppTheme.glass,
                        borderRadius: BorderRadius.circular(24),
                        border: Border.all(color: AppTheme.glassBorder),
                      ),
                      child: TextField(
                        controller: _controller,
                        focusNode: _focusNode,
                        maxLines: null,
                        enabled: canChat,
                        style: const TextStyle(
                            color: AppTheme.textPrimary, fontSize: 14),
                        decoration: InputDecoration(
                          hintText: canChat
                              ? '输入消息... 试试"帮我查余额"'
                              : '买入 Token 后即可聊天',
                          hintStyle:
                              TextStyle(color: AppTheme.textDim, fontSize: 14),
                          border: InputBorder.none,
                          contentPadding: const EdgeInsets.symmetric(
                              horizontal: 16, vertical: 10),
                        ),
                        onSubmitted: canChat ? (_) => _sendMessage() : null,
                      ),
                    ),
                  ),

                  const SizedBox(width: 8),

                  // Send button
                  GestureDetector(
                    onTap: canChat ? _sendMessage : null,
                    child: Container(
                      width: 40,
                      height: 40,
                      decoration: BoxDecoration(
                        gradient: canChat ? AppTheme.purpleGradient : null,
                        color: canChat ? null : const Color(0x15FFFFFF),
                        shape: BoxShape.circle,
                      ),
                      child: Icon(
                        Icons.arrow_upward,
                        color: canChat ? Colors.white : const Color(0x40FFFFFF),
                        size: 20,
                      ),
                    ),
                  ),
                ],
              ),
            ],
          ),
        );
      },
    );
  }

  void _showTradeSheet() {
    showModalBottomSheet(
      context: context,
      backgroundColor: Colors.transparent,
      isScrollControlled: true,
      builder: (_) => _TradeSheet(agent: widget.agent),
    );
  }
}

/// Bottom sheet for quick buy/sell
class _TradeSheet extends StatefulWidget {
  final Agent agent;
  const _TradeSheet({required this.agent});

  @override
  State<_TradeSheet> createState() => _TradeSheetState();
}

class _TradeSheetState extends State<_TradeSheet> {
  bool _isBuy = true;
  bool _isSubmitting = false;
  final _amountController = TextEditingController();
  final _amounts = ['0.01', '0.05', '0.1', '0.5'];

  @override
  void dispose() {
    _amountController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return ClipRRect(
      borderRadius: const BorderRadius.vertical(top: Radius.circular(24)),
      child: BackdropFilter(
        filter: ImageFilter.blur(sigmaX: 20, sigmaY: 20),
        child: Container(
          padding: EdgeInsets.fromLTRB(
              20, 16, 20, MediaQuery.of(context).padding.bottom + 20),
          decoration: BoxDecoration(
            color: AppTheme.surface.withValues(alpha: 0.95),
            borderRadius:
                const BorderRadius.vertical(top: Radius.circular(24)),
            border: Border.all(color: AppTheme.glassBorder),
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              // Handle bar
              Container(
                width: 36,
                height: 4,
                decoration: BoxDecoration(
                  color: AppTheme.textDim,
                  borderRadius: BorderRadius.circular(2),
                ),
              ),
              const SizedBox(height: 16),

              // Agent info
              Row(
                children: [
                  Text(widget.agent.emoji, style: const TextStyle(fontSize: 28)),
                  const SizedBox(width: 10),
                  Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(widget.agent.name,
                          style: const TextStyle(
                              fontSize: 16,
                              fontWeight: FontWeight.w700,
                              color: AppTheme.textPrimary)),
                      Text(widget.agent.priceFormatted,
                          style: const TextStyle(
                              fontSize: 13, color: AppTheme.textMuted)),
                    ],
                  ),
                ],
              ),
              const SizedBox(height: 16),

              // Buy/Sell toggle
              Container(
                height: 40,
                decoration: BoxDecoration(
                  color: AppTheme.glass,
                  borderRadius: BorderRadius.circular(12),
                ),
                child: Row(
                  children: [
                    _buildToggle('买入', true),
                    _buildToggle('卖出', false),
                  ],
                ),
              ),
              const SizedBox(height: 16),

              // Amount input
              Container(
                height: 52,
                decoration: BoxDecoration(
                  color: AppTheme.glass,
                  borderRadius: BorderRadius.circular(16),
                  border: Border.all(color: AppTheme.glassBorder),
                ),
                child: TextField(
                  controller: _amountController,
                  keyboardType: TextInputType.number,
                  style: const TextStyle(
                      color: AppTheme.textPrimary,
                      fontSize: 18,
                      fontWeight: FontWeight.w600),
                  decoration: InputDecoration(
                    hintText: '0.00',
                    hintStyle: TextStyle(
                        color: AppTheme.textDim,
                        fontSize: 18,
                        fontWeight: FontWeight.w600),
                    suffixText: 'BNB',
                    suffixStyle: const TextStyle(
                        color: AppTheme.textMuted, fontSize: 14),
                    border: InputBorder.none,
                    contentPadding:
                        const EdgeInsets.symmetric(horizontal: 16),
                  ),
                ),
              ),
              const SizedBox(height: 10),

              // Quick amount buttons
              Row(
                children: _amounts
                    .map((a) => Expanded(
                          child: Padding(
                            padding:
                                const EdgeInsets.symmetric(horizontal: 3),
                            child: GestureDetector(
                              onTap: () =>
                                  _amountController.text = a,
                              child: Container(
                                height: 32,
                                decoration: BoxDecoration(
                                  color: AppTheme.glass,
                                  borderRadius: BorderRadius.circular(8),
                                  border: Border.all(
                                      color: AppTheme.glassBorder),
                                ),
                                child: Center(
                                  child: Text(
                                    '$a BNB',
                                    style: const TextStyle(
                                      fontSize: 12,
                                      color: AppTheme.textSecondary,
                                    ),
                                  ),
                                ),
                              ),
                            ),
                          ),
                        ))
                    .toList(),
              ),
              const SizedBox(height: 20),

              // Submit button
              SizedBox(
                width: double.infinity,
                height: 48,
                child: GestureDetector(
                  onTap: _isSubmitting ? null : _submit,
                  child: Container(
                    decoration: BoxDecoration(
                      gradient: _isBuy
                          ? const LinearGradient(
                              colors: [AppTheme.green, Color(0xFF16A34A)])
                          : const LinearGradient(
                              colors: [AppTheme.red, Color(0xFFDC2626)]),
                      borderRadius: BorderRadius.circular(16),
                    ),
                    child: Center(
                      child: _isSubmitting
                          ? const SizedBox(
                              width: 22,
                              height: 22,
                              child: CircularProgressIndicator(
                                strokeWidth: 2,
                                color: Colors.white,
                              ),
                            )
                          : Text(
                              _isBuy ? '确认买入' : '确认卖出',
                              style: const TextStyle(
                                fontSize: 16,
                                fontWeight: FontWeight.w700,
                                color: Colors.white,
                              ),
                            ),
                    ),
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildToggle(String label, bool isBuy) {
    final selected = _isBuy == isBuy;
    return Expanded(
      child: GestureDetector(
        onTap: () => setState(() => _isBuy = isBuy),
        child: Container(
          decoration: BoxDecoration(
            color: selected
                ? (isBuy ? AppTheme.green : AppTheme.red).withValues(alpha: 0.2)
                : Colors.transparent,
            borderRadius: BorderRadius.circular(10),
          ),
          child: Center(
            child: Text(
              label,
              style: TextStyle(
                fontSize: 14,
                fontWeight: selected ? FontWeight.w600 : FontWeight.w400,
                color: selected
                    ? (isBuy ? AppTheme.green : AppTheme.red)
                    : AppTheme.textDim,
              ),
            ),
          ),
        ),
      ),
    );
  }

  Future<void> _submit() async {
    final amount = _amountController.text.trim();
    if (amount.isEmpty) return;

    final wallet = context.read<WalletProvider>();
    if (!wallet.isConnected || wallet.credentials == null) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('请先登录 Google 账号'),
          backgroundColor: Colors.orange,
        ),
      );
      return;
    }

    final parsedAmount = double.tryParse(amount);
    if (parsedAmount == null || parsedAmount <= 0) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('请输入有效金额'),
          backgroundColor: Colors.orange,
        ),
      );
      return;
    }

    setState(() => _isSubmitting = true);

    try {
      // Use a placeholder token address from agent ID (MVP)
      // In production, agent.id would map to a real token address
      final tokenAddress = EthereumAddress.fromHex(
        widget.agent.tokenAddress ?? '0x0000000000000000000000000000000000000001',
      );

      final orderService = OrderService(api: DexiApi());
      final result = await orderService.submitMarketOrder(
        credentials: wallet.credentials!,
        traderAddress: wallet.address!,
        tokenAddress: tokenAddress,
        isLong: _isBuy,
        sizeInBnb: parsedAmount,
      );

      if (!mounted) return;

      final action = _isBuy ? '买入' : '卖出';
      if (result.containsKey('error')) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text('$action 失败: ${result['error']}'),
            backgroundColor: AppTheme.red,
          ),
        );
      } else {
        // Update fee service holdings so user can chat after buying
        final feeService = context.read<ChatFeeService>();
        if (_isBuy) {
          // Estimate tokens received (simplified: 1 BNB ≈ 1000 tokens for MVP)
          feeService.addHolding(widget.agent.id, parsedAmount * 1000);
        } else {
          feeService.removeHolding(widget.agent.id, parsedAmount * 1000);
        }

        // Send as chat message so it shows in conversation
        context.read<ChatProvider>().sendMessage(
          '已提交 $action $amount BNB 的 ${widget.agent.name} 订单',
        );
        Navigator.of(context).pop();
      }
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text('交易失败: $e'),
          backgroundColor: AppTheme.red,
        ),
      );
    } finally {
      if (mounted) setState(() => _isSubmitting = false);
    }
  }
}
