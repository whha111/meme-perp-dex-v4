import 'dart:convert';
import 'package:http/http.dart' as http;
import '../../core/config/app_config.dart';

/// DEXI Matching Engine REST API client
/// API base: https://dexi.fun (nginx → matching engine port 8081)
class DexiApi {
  final String baseUrl;

  DexiApi({String? baseUrl}) : baseUrl = baseUrl ?? AppConfig.dexiApiUrl;

  // ─── Market data ─────────────────────────────────────────────

  /// GET /api/v1/market/tickers → {code, data: [{instId, last, vol24h, ...}]}
  Future<List<Map<String, dynamic>>> getTickers() async {
    return _getDataList('/api/v1/market/tickers');
  }

  // ─── User data ───────────────────────────────────────────────

  /// GET /api/user/:trader/balance → {available, locked, ...} (may timeout)
  Future<Map<String, dynamic>> getBalance(String trader) async {
    return _get('/api/user/$trader/balance', timeout: 8);
  }

  /// GET /api/user/:trader/positions → [] or [{...}]
  Future<List<Map<String, dynamic>>> getPositions(String trader) async {
    return _getRawList('/api/user/$trader/positions');
  }

  /// GET /api/user/:trader/orders
  Future<List<Map<String, dynamic>>> getOrders(String trader) async {
    return _getRawList('/api/user/$trader/orders');
  }

  /// GET /api/user/:trader/trades → {success, trades: [...], total}
  Future<List<Map<String, dynamic>>> getTrades(String trader) async {
    try {
      final res = await http
          .get(Uri.parse('$baseUrl/api/user/$trader/trades'))
          .timeout(const Duration(seconds: 8));
      if (res.statusCode == 200) {
        final data = jsonDecode(res.body);
        if (data is Map && data.containsKey('trades')) {
          return (data['trades'] as List).cast<Map<String, dynamic>>();
        }
        if (data is List) return data.cast<Map<String, dynamic>>();
        return [];
      }
      return [];
    } catch (e) {
      return [];
    }
  }

  // ─── Trading ─────────────────────────────────────────────────

  /// POST /api/order/submit
  Future<Map<String, dynamic>> submitOrder(Map<String, dynamic> order) async {
    return _post('/api/order/submit', order);
  }

  /// POST /api/order/cancel
  Future<Map<String, dynamic>> cancelOrder(String orderId) async {
    return _post('/api/order/cancel', {'orderId': orderId});
  }

  // ─── OrderBook ───────────────────────────────────────────────

  Future<Map<String, dynamic>> getOrderBook(String symbol) async {
    return _get('/api/orderbook/$symbol');
  }

  // ─── Helpers ─────────────────────────────────────────────────

  /// GET returning a Map (single object)
  Future<Map<String, dynamic>> _get(String path, {int timeout = 5}) async {
    try {
      final res = await http
          .get(Uri.parse('$baseUrl$path'))
          .timeout(Duration(seconds: timeout));
      if (res.statusCode == 200) {
        final data = jsonDecode(res.body);
        if (data is Map) return data.cast<String, dynamic>();
        return {'data': data};
      }
      return {'error': 'HTTP ${res.statusCode}'};
    } catch (e) {
      return {'error': e.toString()};
    }
  }

  /// GET → {code, data: [...]} DEXI standard list response
  Future<List<Map<String, dynamic>>> _getDataList(String path) async {
    try {
      final res = await http
          .get(Uri.parse('$baseUrl$path'))
          .timeout(const Duration(seconds: 8));
      if (res.statusCode == 200) {
        final body = jsonDecode(res.body);
        if (body is Map && body.containsKey('data') && body['data'] is List) {
          return (body['data'] as List).cast<Map<String, dynamic>>();
        }
        if (body is List) return body.cast<Map<String, dynamic>>();
        return [];
      }
      return [];
    } catch (e) {
      return [];
    }
  }

  /// GET returning a raw JSON array
  Future<List<Map<String, dynamic>>> _getRawList(String path) async {
    try {
      final res = await http
          .get(Uri.parse('$baseUrl$path'))
          .timeout(const Duration(seconds: 8));
      if (res.statusCode == 200) {
        final data = jsonDecode(res.body);
        if (data is List) return data.cast<Map<String, dynamic>>();
        if (data is Map && data.containsKey('data') && data['data'] is List) {
          return (data['data'] as List).cast<Map<String, dynamic>>();
        }
        return [];
      }
      return [];
    } catch (e) {
      return [];
    }
  }

  /// POST
  Future<Map<String, dynamic>> _post(
      String path, Map<String, dynamic> body) async {
    try {
      final res = await http
          .post(
            Uri.parse('$baseUrl$path'),
            headers: {'Content-Type': 'application/json'},
            body: jsonEncode(body),
          )
          .timeout(const Duration(seconds: 10));
      if (res.statusCode == 200) return jsonDecode(res.body);
      return {'error': 'HTTP ${res.statusCode}'};
    } catch (e) {
      return {'error': e.toString()};
    }
  }
}
