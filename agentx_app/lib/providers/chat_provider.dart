import 'package:flutter/foundation.dart';
import 'package:uuid/uuid.dart';

import '../models/chat_message.dart';
import '../services/ai/deepseek_service.dart';
import '../services/ai/tool_executor.dart';
import '../services/api/dexi_api.dart';
import '../services/chat_fee_service.dart';

/// Chat provider — orchestrates the full AI conversation loop:
/// User message → Fee check → DeepSeek → Tool calls → Execute → DeepSeek → Response
class ChatProvider extends ChangeNotifier {
  final List<ChatMessage> _messages = [];
  final DeepSeekService _deepseek;
  final ToolExecutor _toolExecutor;
  final ChatFeeService _feeService;
  bool _isLoading = false;
  String? _currentAgentName;
  String? _currentAgentId;

  List<ChatMessage> get messages => List.unmodifiable(_messages);
  bool get isLoading => _isLoading;
  String? get currentAgentName => _currentAgentName;
  String? get currentAgentId => _currentAgentId;
  ChatFeeService get feeService => _feeService;

  /// Whether user can chat with current agent
  bool get canChat => _currentAgentId != null && _feeService.canChat(_currentAgentId!);

  /// Remaining messages user can send
  int get remainingMessages =>
      _currentAgentId != null ? _feeService.remainingMessages(_currentAgentId!) : 0;

  /// Current holding for this agent
  double get currentHolding =>
      _currentAgentId != null ? _feeService.getHolding(_currentAgentId!) : 0;

  ChatProvider({
    required String apiKey,
    required DexiApi dexiApi,
    required ChatFeeService feeService,
    String? traderAddress,
  })  : _deepseek = DeepSeekService(apiKey: apiKey),
        _toolExecutor = ToolExecutor(
          dexiApi: dexiApi,
          traderAddress: traderAddress,
        ),
        _feeService = feeService;

  /// Update trader address when wallet connects
  void updateTraderAddress(String? address) {
    // Recreate tool executor with new address
    // (ToolExecutor is lightweight, ok to recreate)
  }

  /// Set current agent context for chat
  void setAgent(String agentName, {String? agentId}) {
    _currentAgentName = agentName;
    _currentAgentId = agentId ?? agentName; // fallback to name as ID
    if (_messages.isEmpty) {
      final holding = _feeService.getHolding(_currentAgentId!);
      if (holding > 0) {
        _messages.add(ChatMessage(
          id: const Uuid().v4(),
          content: '你好！我是 $agentName，有什么可以帮你的？\n\n'
              '💎 你当前持有 ${holding.toStringAsFixed(1)} 个 Token，'
              '每条消息消耗 ${_feeService.remainingMessages(_currentAgentId!) > 100 ? "100+" : _feeService.remainingMessages(_currentAgentId!).toString()} 条可用。',
          role: MessageRole.assistant,
          timestamp: DateTime.now(),
        ));
      } else {
        _messages.add(ChatMessage(
          id: const Uuid().v4(),
          content: '你好！我是 $agentName。\n\n'
              '⚠️ 你还没有持有我的 Token，需要先买入才能开始聊天。\n'
              '点击右上角「交易」按钮买入吧！',
          role: MessageRole.assistant,
          timestamp: DateTime.now(),
        ));
      }
      notifyListeners();
    }
  }

  /// Clear chat history
  void clearMessages() {
    _messages.clear();
    notifyListeners();
  }

  /// Send a user message and get AI response
  Future<void> sendMessage(String text) async {
    if (text.trim().isEmpty || _isLoading) return;

    // Fee check: must hold tokens to chat
    if (_currentAgentId != null) {
      final (result, _) = _feeService.deductMessageFee(_currentAgentId!);

      if (result == ChatFeeResult.insufficientHolding) {
        _messages.add(ChatMessage(
          id: const Uuid().v4(),
          content: text,
          role: MessageRole.user,
          timestamp: DateTime.now(),
        ));
        _messages.add(ChatMessage(
          id: const Uuid().v4(),
          content: '⚠️ 你需要持有至少 ${1.0.toStringAsFixed(0)} 个 $_currentAgentName Token 才能聊天。\n'
              '点击右上角「交易」按钮买入吧！',
          role: MessageRole.assistant,
          timestamp: DateTime.now(),
        ));
        notifyListeners();
        return;
      }

      if (result == ChatFeeResult.insufficientBalance) {
        _messages.add(ChatMessage(
          id: const Uuid().v4(),
          content: text,
          role: MessageRole.user,
          timestamp: DateTime.now(),
        ));
        _messages.add(ChatMessage(
          id: const Uuid().v4(),
          content: '⚠️ Token 余额不足，无法发送消息。\n'
              '当前持有: ${_feeService.getHolding(_currentAgentId!).toStringAsFixed(3)}\n'
              '每条消息: ${0.001.toStringAsFixed(3)}\n\n'
              '请先买入更多 Token 再继续聊天。',
          role: MessageRole.assistant,
          timestamp: DateTime.now(),
        ));
        notifyListeners();
        return;
      }

      // Fee deducted successfully — notify to update UI
      notifyListeners();
    }

    // Add user message
    final userMsg = ChatMessage(
      id: const Uuid().v4(),
      content: text,
      role: MessageRole.user,
      timestamp: DateTime.now(),
    );
    _messages.add(userMsg);
    _isLoading = true;
    notifyListeners();

    try {
      // Call DeepSeek
      final response = await _deepseek.chat(_messages);

      if (response.hasToolCalls) {
        // Execute each tool call
        final results = <String>[];
        for (final tc in response.toolCalls!) {
          final result = await _toolExecutor.execute(tc);
          results.add(result);
        }

        // Send tool results back to DeepSeek for final response
        final finalResponse = await _deepseek.continueWithToolResults(
          _messages,
          response.toolCalls!,
          results,
        );

        // Add assistant message with tool context
        _messages.add(ChatMessage(
          id: const Uuid().v4(),
          content: finalResponse.content,
          role: MessageRole.assistant,
          timestamp: DateTime.now(),
          toolCalls: response.toolCalls,
        ));
      } else {
        // Direct response, no tools needed
        _messages.add(ChatMessage(
          id: const Uuid().v4(),
          content: response.content,
          role: MessageRole.assistant,
          timestamp: DateTime.now(),
        ));
      }
    } catch (e) {
      _messages.add(ChatMessage(
        id: const Uuid().v4(),
        content: '抱歉，出了点问题: ${e.toString().split('\n').first}',
        role: MessageRole.assistant,
        timestamp: DateTime.now(),
      ));
    }

    _isLoading = false;
    notifyListeners();
  }
}
