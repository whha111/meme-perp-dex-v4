import 'dart:convert';
import '../../models/chat_message.dart';
import '../api/dexi_api.dart';

/// Executes AI tool calls — bridges DeepSeek function calling to real actions
class ToolExecutor {
  final DexiApi _dexiApi;
  final String? traderAddress;

  ToolExecutor({required DexiApi dexiApi, this.traderAddress})
      : _dexiApi = dexiApi;

  /// Execute a tool call and return result as string
  Future<String> execute(ToolCall toolCall) async {
    try {
      switch (toolCall.name) {
        case 'get_balance':
          return await _getBalance();
        case 'get_positions':
          return await _getPositions();
        case 'get_token_price':
          return await _getTokenPrice(toolCall.arguments);
        case 'get_market_overview':
          return await _getMarketOverview();
        case 'place_order':
          return await _placeOrder(toolCall.arguments);
        case 'close_position':
          return await _closePosition(toolCall.arguments);
        case 'check_contract_safety':
          return await _checkContractSafety(toolCall.arguments);
        case 'check_holder_concentration':
          return await _checkHolderConcentration(toolCall.arguments);
        case 'analyze_trade_history':
          return await _analyzeTradeHistory();
        case 'get_pnl_summary':
          return await _getPnlSummary();
        default:
          return jsonEncode({'error': '未知工具: ${toolCall.name}'});
      }
    } catch (e) {
      return jsonEncode({'error': e.toString()});
    }
  }

  Future<String> _getBalance() async {
    if (traderAddress == null) return jsonEncode({'error': '钱包未连接'});
    final balance = await _dexiApi.getBalance(traderAddress!);
    return jsonEncode(balance);
  }

  Future<String> _getPositions() async {
    if (traderAddress == null) return jsonEncode({'error': '钱包未连接'});
    final positions = await _dexiApi.getPositions(traderAddress!);
    return jsonEncode({'positions': positions, 'count': positions.length});
  }

  Future<String> _getTokenPrice(Map<String, dynamic> args) async {
    final tickers = await _dexiApi.getTickers();
    final name = (args['token_name'] as String).toLowerCase();
    final match = tickers.where(
        (t) => (t['symbol'] ?? '').toString().toLowerCase().contains(name));
    if (match.isEmpty) {
      return jsonEncode({'error': '未找到 $name 的价格数据'});
    }
    return jsonEncode(match.first);
  }

  Future<String> _getMarketOverview() async {
    final tickers = await _dexiApi.getTickers();
    return jsonEncode({
      'total_tokens': tickers.length,
      'tickers': tickers.take(10).toList(),
    });
  }

  Future<String> _placeOrder(Map<String, dynamic> args) async {
    if (traderAddress == null) return jsonEncode({'error': '钱包未连接'});
    return jsonEncode({
      'status': 'needs_confirmation',
      'token': args['token_name'],
      'side': args['side'],
      'amount': args['amount'],
      'message': '请确认: ${args["side"] == "buy" ? "买入" : "卖出"} ${args["amount"]} BNB 的 ${args["token_name"]}',
    });
  }

  Future<String> _closePosition(Map<String, dynamic> args) async {
    if (traderAddress == null) return jsonEncode({'error': '钱包未连接'});
    return jsonEncode({
      'status': 'needs_confirmation',
      'token': args['token_name'],
      'message': '请确认平仓 ${args["token_name"]}',
    });
  }

  Future<String> _checkContractSafety(Map<String, dynamic> args) async {
    final address = args['address'] as String;
    // Query DEXI for holder data as a proxy for contract safety
    try {
      final tickers = await _dexiApi.getTickers();
      final match = tickers.where((t) =>
          (t['tokenAddress'] ?? '').toString().toLowerCase() ==
          address.toLowerCase());
      if (match.isNotEmpty) {
        final ticker = match.first;
        return jsonEncode({
          'address': address,
          'symbol': ticker['symbol'],
          'price': ticker['lastPrice'] ?? ticker['price'],
          'volume_24h': ticker['volume24h'] ?? ticker['volume'],
          'listed_on_dexi': true,
          'note': '该 Token 已在 DEXI 上市交易',
        });
      }
    } catch (_) {}
    return jsonEncode({
      'address': address,
      'listed_on_dexi': false,
      'note': '该地址未在 DEXI 交易所找到，请谨慎操作',
    });
  }

  Future<String> _checkHolderConcentration(Map<String, dynamic> args) async {
    final address = args['address'] as String;
    // Query DEXI for holder data if available
    try {
      final tickers = await _dexiApi.getTickers();
      final match = tickers.where((t) =>
          (t['tokenAddress'] ?? t['symbol'] ?? '')
              .toString()
              .toLowerCase()
              .contains(address.toLowerCase()));
      if (match.isNotEmpty) {
        return jsonEncode({
          'address': address,
          'symbol': match.first['symbol'],
          'price': match.first['lastPrice'] ?? match.first['price'],
          'data_source': 'DEXI API',
        });
      }
    } catch (_) {}
    return jsonEncode({
      'address': address,
      'note': '暂无该 Token 的持有者数据',
    });
  }

  Future<String> _analyzeTradeHistory() async {
    if (traderAddress == null) return jsonEncode({'error': '钱包未连接'});
    // Fetch real trade history from DEXI
    final trades = await _dexiApi.getTrades(traderAddress!);
    if (trades.isEmpty) {
      return jsonEncode({
        'total_trades': 0,
        'message': '暂无交易记录',
      });
    }

    // Calculate basic stats from real trades
    int buyCount = 0;
    int sellCount = 0;
    for (final t in trades) {
      final side = (t['side'] ?? '').toString().toLowerCase();
      if (side == 'buy' || side == 'long') {
        buyCount++;
      } else {
        sellCount++;
      }
    }

    return jsonEncode({
      'total_trades': trades.length,
      'buy_count': buyCount,
      'sell_count': sellCount,
      'recent_trades': trades.take(5).toList(),
      'data_source': 'DEXI 撮合引擎',
    });
  }

  Future<String> _getPnlSummary() async {
    if (traderAddress == null) return jsonEncode({'error': '钱包未连接'});
    // Fetch real positions and balance from DEXI
    final balance = await _dexiApi.getBalance(traderAddress!);
    final positions = await _dexiApi.getPositions(traderAddress!);

    return jsonEncode({
      'balance': balance,
      'open_positions': positions.length,
      'positions': positions.take(5).toList(),
      'data_source': 'DEXI 撮合引擎',
    });
  }
}
