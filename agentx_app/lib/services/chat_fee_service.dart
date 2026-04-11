import 'package:flutter/foundation.dart';
import '../core/config/app_config.dart';

/// Chat fee result
enum ChatFeeResult {
  success,
  insufficientHolding,  // doesn't hold enough tokens
  insufficientBalance,  // holding < fee amount
}

/// Fee deduction receipt
class FeeReceipt {
  final double amount;
  final double toCreator;
  final double toPlatform;
  final double remainingHolding;
  final DateTime timestamp;

  const FeeReceipt({
    required this.amount,
    required this.toCreator,
    required this.toPlatform,
    required this.remainingHolding,
    required this.timestamp,
  });
}

/// Manages chat fee deduction: users must hold agent tokens to chat,
/// each message deducts a micro fee split between creator and platform.
///
/// MVP: uses local simulated holdings.
/// Production: replace with DEXI API calls for real token balance queries.
class ChatFeeService extends ChangeNotifier {
  // Agent token holdings: agentId → amount held
  final Map<String, double> _holdings = {};

  // Fee history per agent
  final Map<String, List<FeeReceipt>> _feeHistory = {};

  // Total fees collected (for analytics)
  double _totalCreatorFees = 0;
  double _totalPlatformFees = 0;

  double get totalCreatorFees => _totalCreatorFees;
  double get totalPlatformFees => _totalPlatformFees;

  /// Get user's holding for a specific agent
  double getHolding(String agentId) => _holdings[agentId] ?? 0;

  /// Check if user can chat with this agent (holds minimum tokens)
  bool canChat(String agentId) {
    return getHolding(agentId) >= AppConfig.minHoldingToChat;
  }

  /// Check if user has enough balance for one message
  bool canAffordMessage(String agentId) {
    return getHolding(agentId) >= AppConfig.chatFeePerMessage;
  }

  /// How many messages can user send with current holding
  int remainingMessages(String agentId) {
    final holding = getHolding(agentId);
    if (holding < AppConfig.chatFeePerMessage) return 0;
    return (holding / AppConfig.chatFeePerMessage).floor();
  }

  /// Deduct fee for one chat message
  /// Returns the result and receipt if successful
  (ChatFeeResult, FeeReceipt?) deductMessageFee(String agentId) {
    final holding = getHolding(agentId);

    if (holding < AppConfig.minHoldingToChat) {
      return (ChatFeeResult.insufficientHolding, null);
    }

    if (holding < AppConfig.chatFeePerMessage) {
      return (ChatFeeResult.insufficientBalance, null);
    }

    final fee = AppConfig.chatFeePerMessage;
    final toCreator = fee * AppConfig.creatorFeeShare;
    final toPlatform = fee * AppConfig.platformFeeShare;

    // Deduct from holding
    _holdings[agentId] = holding - fee;

    // Track fees
    _totalCreatorFees += toCreator;
    _totalPlatformFees += toPlatform;

    final receipt = FeeReceipt(
      amount: fee,
      toCreator: toCreator,
      toPlatform: toPlatform,
      remainingHolding: _holdings[agentId]!,
      timestamp: DateTime.now(),
    );

    _feeHistory.putIfAbsent(agentId, () => []).add(receipt);
    notifyListeners();

    return (ChatFeeResult.success, receipt);
  }

  /// Simulate buying tokens (MVP — will be replaced with real DEXI order)
  void addHolding(String agentId, double amount) {
    _holdings[agentId] = (_holdings[agentId] ?? 0) + amount;
    notifyListeners();
  }

  /// Simulate selling tokens
  void removeHolding(String agentId, double amount) {
    final current = _holdings[agentId] ?? 0;
    _holdings[agentId] = (current - amount).clamp(0, double.infinity);
    notifyListeners();
  }

  /// Get fee history for an agent
  List<FeeReceipt> getFeeHistory(String agentId) {
    return _feeHistory[agentId] ?? [];
  }
}
