import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';
import 'package:crypto/crypto.dart';
import 'package:google_sign_in/google_sign_in.dart';
import 'package:web3dart/web3dart.dart';

/// Google user profile
class GoogleUserProfile {
  final String uid;
  final String email;
  final String? displayName;
  final String? photoUrl;

  const GoogleUserProfile({
    required this.uid,
    required this.email,
    this.displayName,
    this.photoUrl,
  });

  String get shortName => displayName ?? email.split('@').first;
}

/// Google OAuth + deterministic wallet derivation.
class GoogleAuthService {
  static const _keySalt = 'agentx-wallet-derivation-v1';

  bool _initialized = false;
  StreamSubscription<GoogleSignInAuthenticationEvent>? _authSub;

  /// Callback when user signs in via Google button
  void Function(GoogleUserProfile profile)? onSignIn;

  /// Initialize and start listening for auth events
  Future<void> init({String? clientId}) async {
    if (_initialized) return;
    await GoogleSignIn.instance.initialize(clientId: clientId);

    // Listen to auth events (from renderButton / One Tap)
    _authSub = GoogleSignIn.instance.authenticationEvents.listen((event) {
      if (event case GoogleSignInAuthenticationEventSignIn(:final user)) {
        final profile = GoogleUserProfile(
          uid: user.id,
          email: user.email,
          displayName: user.displayName,
          photoUrl: user.photoUrl,
        );
        onSignIn?.call(profile);
      }
    });

    // Try One Tap (lightweight, may return null on web)
    GoogleSignIn.instance.attemptLightweightAuthentication();

    _initialized = true;
  }

  /// Sign out
  Future<void> signOut() async {
    await GoogleSignIn.instance.signOut();
  }

  void dispose() {
    _authSub?.cancel();
  }

  /// Derive deterministic EVM private key from Google UID
  static EthPrivateKey deriveWalletFromUid(String uid) {
    final hmacKey = utf8.encode(_keySalt);
    final hmac = Hmac(sha256, hmacKey);
    final digest = hmac.convert(utf8.encode(uid));
    final keyBytes = Uint8List.fromList(digest.bytes);
    return EthPrivateKey(keyBytes);
  }

  static EthereumAddress addressFromUid(String uid) {
    return deriveWalletFromUid(uid).address;
  }
}
