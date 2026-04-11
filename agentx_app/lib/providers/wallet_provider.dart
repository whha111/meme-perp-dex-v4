import 'dart:typed_data';
import 'package:flutter/foundation.dart';
import 'package:web3dart/web3dart.dart';
import 'package:http/http.dart' as http;

import '../core/config/app_config.dart';
import '../services/auth/google_auth_service.dart';

/// Wallet provider — Google login = wallet creation.
/// User signs in with Google → deterministic wallet derived from Google UID.
class WalletProvider extends ChangeNotifier {
  final GoogleAuthService _authService;

  GoogleUserProfile? _profile;
  EthPrivateKey? _credentials;
  EthereumAddress? _address;
  bool _isConnected = false;
  BigInt _balance = BigInt.zero;

  // Getters
  GoogleUserProfile? get profile => _profile;
  EthereumAddress? get address => _address;
  String? get addressHex => _address?.hexEip55;
  String get addressShort {
    if (_address == null) return '';
    final hex = _address!.hexEip55;
    return '${hex.substring(0, 6)}...${hex.substring(hex.length - 4)}';
  }

  bool get isConnected => _isConnected;
  BigInt get balance => _balance;
  double get balanceBnb => _balance / BigInt.from(10).pow(18);
  String get balanceFormatted => balanceBnb.toStringAsFixed(4);

  String get displayName => _profile?.shortName ?? '';
  String get email => _profile?.email ?? '';
  String? get photoUrl => _profile?.photoUrl;

  Web3Client get _web3 => Web3Client(AppConfig.rpcUrl, http.Client());

  WalletProvider() : _authService = GoogleAuthService() {
    // Set up callback for when Google sign-in completes
    _authService.onSignIn = _onGoogleSignIn;
  }

  void _onGoogleSignIn(GoogleUserProfile profile) {
    _profile = profile;
    _credentials = GoogleAuthService.deriveWalletFromUid(profile.uid);
    _address = _credentials!.address;
    _isConnected = true;
    notifyListeners();
    refreshBalance();
  }

  /// Initialize Google Sign-In SDK and try silent auth
  Future<void> tryAutoConnect() async {
    try {
      await _authService.init();
    } catch (e) {
      debugPrint('Auto connect error: $e');
    }
  }

  /// Disconnect (sign out)
  Future<void> disconnect() async {
    await _authService.signOut();
    _isConnected = false;
    _address = null;
    _credentials = null;
    _profile = null;
    _balance = BigInt.zero;
    notifyListeners();
  }

  /// Refresh BNB balance
  Future<void> refreshBalance() async {
    if (_address == null) return;
    try {
      final bal = await _web3.getBalance(_address!);
      _balance = bal.getInWei;
      notifyListeners();
    } catch (e) {
      debugPrint('Balance fetch error: $e');
    }
  }

  /// Sign a message (EIP-191)
  Future<String> signMessage(String message) async {
    if (_credentials == null) throw Exception('请先登录');
    final msgBytes = Uint8List.fromList(message.codeUnits);
    return bytesToHex(_credentials!.signPersonalMessageToUint8List(msgBytes));
  }

  EthPrivateKey? get credentials => _credentials;

  @override
  void dispose() {
    _authService.dispose();
    super.dispose();
  }
}

String bytesToHex(List<int> bytes) {
  return bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
}
