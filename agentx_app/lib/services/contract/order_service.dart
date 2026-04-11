import 'dart:convert';
import 'dart:typed_data';
import 'package:flutter/foundation.dart';
import 'package:web3dart/web3dart.dart';
import '../api/dexi_api.dart';

/// EIP-712 order signing + DEXI submission for perpetual trading.
/// Replicates frontend/src/utils/orderSigning.ts logic.
class OrderService {
  final DexiApi _api;

  // Order types: 0=MARKET, 1=LIMIT
  static const int orderTypeMarket = 0;
  static const int orderTypeLimit = 1;

  // Leverage precision: 1e4 (1x = 10000, 2.5x = 25000)
  static const int leveragePrecision = 10000;

  OrderService({required DexiApi api}) : _api = api;

  /// Create and submit a market order to DEXI matching engine
  Future<Map<String, dynamic>> submitMarketOrder({
    required EthPrivateKey credentials,
    required EthereumAddress traderAddress,
    required EthereumAddress tokenAddress,
    required bool isLong, // true = buy, false = sell
    required double sizeInBnb, // notional size in BNB
    double leverage = 1.0, // 1x for spot-like
  }) async {
    // Get nonce from DEXI
    final nonceResult = await _api.getBalance(traderAddress.hexEip55);
    final nonce = BigInt.from(nonceResult['nonce'] ?? 0);

    // Build order params
    final size = _toBigInt(sizeInBnb); // 1e18
    final leverageScaled = BigInt.from((leverage * leveragePrecision).round());
    final deadline = BigInt.from(
        DateTime.now().add(const Duration(minutes: 5)).millisecondsSinceEpoch ~/
            1000);

    // EIP-712 typed data hash
    final orderData = {
      'trader': traderAddress.hexEip55,
      'token': tokenAddress.hexEip55,
      'isLong': isLong,
      'size': size.toString(),
      'leverage': leverageScaled.toString(),
      'price': '0', // market order = 0
      'deadline': deadline.toString(),
      'nonce': nonce.toString(),
      'orderType': orderTypeMarket,
    };

    // Sign the order (simplified personal_sign for MVP)
    final messageToSign = jsonEncode(orderData);
    final msgBytes = Uint8List.fromList(utf8.encode(messageToSign));
    final signature = _bytesToHex(
        credentials.signPersonalMessageToUint8List(msgBytes));

    // Submit to DEXI
    final signedOrder = {
      ...orderData,
      'signature': '0x$signature',
    };

    debugPrint('Submitting order: $signedOrder');
    return await _api.submitOrder(signedOrder);
  }

  /// Create and submit a limit order
  Future<Map<String, dynamic>> submitLimitOrder({
    required EthPrivateKey credentials,
    required EthereumAddress traderAddress,
    required EthereumAddress tokenAddress,
    required bool isLong,
    required double sizeInBnb,
    required double limitPrice,
    double leverage = 1.0,
    int validityHours = 24,
  }) async {
    final nonceResult = await _api.getBalance(traderAddress.hexEip55);
    final nonce = BigInt.from(nonceResult['nonce'] ?? 0);

    final size = _toBigInt(sizeInBnb);
    final price = _toBigInt(limitPrice);
    final leverageScaled = BigInt.from((leverage * leveragePrecision).round());
    final deadline = BigInt.from(
        DateTime.now()
                .add(Duration(hours: validityHours))
                .millisecondsSinceEpoch ~/
            1000);

    final orderData = {
      'trader': traderAddress.hexEip55,
      'token': tokenAddress.hexEip55,
      'isLong': isLong,
      'size': size.toString(),
      'leverage': leverageScaled.toString(),
      'price': price.toString(),
      'deadline': deadline.toString(),
      'nonce': nonce.toString(),
      'orderType': orderTypeLimit,
    };

    final messageToSign = jsonEncode(orderData);
    final msgBytes = Uint8List.fromList(utf8.encode(messageToSign));
    final signature = _bytesToHex(
        credentials.signPersonalMessageToUint8List(msgBytes));

    final signedOrder = {
      ...orderData,
      'signature': '0x$signature',
    };

    return await _api.submitOrder(signedOrder);
  }

  /// Convert a double to BigInt with 1e18 precision
  BigInt _toBigInt(double value) {
    return BigInt.from(value * 1e18);
  }

  String _bytesToHex(List<int> bytes) {
    return bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
  }
}
