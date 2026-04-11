import 'package:flutter/foundation.dart';
import '../models/agent.dart';
import '../services/api/dexi_api.dart';

/// Manages the agent list — fetches from DEXI tickers API + user-created agents.
class AgentStore extends ChangeNotifier {
  final DexiApi _api = DexiApi();
  List<Agent> _marketAgents = [];
  final List<Agent> _userCreated = [];
  bool _isLoading = false;
  String? _error;

  bool get isLoading => _isLoading;
  String? get error => _error;

  /// All agents: market (from DEXI) + user-created
  List<Agent> get allAgents {
    if (_marketAgents.isEmpty && _userCreated.isEmpty) {
      return Agent.fallbackAgents; // Show fallback until first fetch
    }
    return [..._marketAgents, ..._userCreated];
  }

  /// Filter by category
  List<Agent> byCategory(String category) {
    if (category == '全部') return allAgents;
    return allAgents.where((a) => a.category == category).toList();
  }

  /// Add a newly created agent
  void addAgent(Agent agent) {
    _userCreated.add(agent);
    notifyListeners();
  }

  /// Fetch real tickers from DEXI matching engine
  Future<void> fetchFromDexi() async {
    _isLoading = true;
    _error = null;
    notifyListeners();

    try {
      final tickers = await _api.getTickers();
      if (tickers.isNotEmpty) {
        final agents = tickers.map((t) => _tickerToAgent(t)).toList();
        // Filter out zero-price tokens with no activity
        final active = agents.where((a) => a.price > 0).toList();
        if (active.isNotEmpty) {
          _marketAgents = active;
        } else {
          // All tokens have 0 price — show all but note they're inactive
          _marketAgents = agents;
        }
        _error = null;
      } else {
        _error = '暂无市场数据';
      }
    } catch (e) {
      _error = '获取行情失败: $e';
      debugPrint('AgentStore.fetchFromDexi error: $e');
    }

    _isLoading = false;
    notifyListeners();
  }

  /// Convert a DEXI ticker to an Agent.
  /// DEXI format: {instId: "0xabc...-ETH", last: "0.05", vol24h: "100", ...}
  Agent _tickerToAgent(Map<String, dynamic> t) {
    final instId = t['instId']?.toString() ?? '';
    // instId format: "0xTokenAddress-ETH"
    // Extract token address (everything before the last "-ETH")
    String tokenAddr = instId;
    String displayName = instId;
    if (instId.contains('-')) {
      tokenAddr = instId.substring(0, instId.lastIndexOf('-'));
      displayName = tokenAddr;
    }

    // Short address as display name if it's a contract address
    if (displayName.startsWith('0x') && displayName.length > 10) {
      displayName =
          '${displayName.substring(0, 6)}...${displayName.substring(displayName.length - 4)}';
    }

    final lastPrice = double.tryParse(t['last']?.toString() ?? '') ?? 0.0;
    final open24h = double.tryParse(t['open24h']?.toString() ?? '') ?? 0.0;
    // Calculate 24h change percent
    double change = 0.0;
    if (open24h > 0 && lastPrice > 0) {
      change = ((lastPrice - open24h) / open24h) * 100;
    }
    final volume = double.tryParse(t['vol24h']?.toString() ?? '') ??
        double.tryParse(t['volCcy24h']?.toString() ?? '') ??
        0.0;

    return Agent(
      id: tokenAddr,
      name: displayName,
      description: 'Vol ${volume.toStringAsFixed(2)} ETH',
      emoji: _emojiForName(displayName),
      category: '金融', // Default; can be enriched with metadata API later
      price: lastPrice,
      change24h: change,
      holders: 0,
      chats: 0,
      tokenAddress: tokenAddr,
    );
  }

  String _emojiForName(String name) {
    final lower = name.toLowerCase();
    if (lower.contains('doge') || lower.contains('dog')) return '🐕';
    if (lower.contains('cat') || lower.contains('kit')) return '🐱';
    if (lower.contains('pepe') || lower.contains('frog')) return '🐸';
    if (lower.contains('moon')) return '🌙';
    if (lower.contains('bull')) return '🐂';
    if (lower.contains('bear')) return '🐻';
    if (lower.contains('trade') || lower.contains('bot')) return '🤖';
    if (lower.contains('teach') || lower.contains('edu')) return '🦉';
    return '💎';
  }
}
