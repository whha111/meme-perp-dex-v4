import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';
import 'package:google_sign_in_platform_interface/google_sign_in_platform_interface.dart';
import 'package:google_sign_in_web/google_sign_in_web.dart';
import '../../core/theme/app_theme.dart';
import '../../providers/wallet_provider.dart';

/// Profile screen — Google account, wallet info, settings
class ProfileScreen extends StatelessWidget {
  const ProfileScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        bottom: false,
        child: Consumer<WalletProvider>(
          builder: (context, wallet, _) {
            return CustomScrollView(
              slivers: [
                SliverToBoxAdapter(child: _buildHeader(context)),
                SliverToBoxAdapter(child: _buildAvatar(context, wallet)),
                SliverToBoxAdapter(child: _buildMenuSection(context)),
                SliverToBoxAdapter(child: _buildAbout()),
              ],
            );
          },
        ),
      ),
    );
  }

  Widget _buildHeader(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 16, 20, 0),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          const Text(
            '我的',
            style: TextStyle(
              fontSize: 22,
              fontWeight: FontWeight.w700,
              color: AppTheme.textPrimary,
            ),
          ),
          Container(
            width: 36,
            height: 36,
            decoration: BoxDecoration(
              color: const Color(0x08FFFFFF),
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: const Color(0x10FFFFFF)),
            ),
            child: const Icon(Icons.settings,
                size: 18, color: Color(0x99FFFFFF)),
          ),
        ],
      ),
    );
  }

  Widget _buildAvatar(BuildContext context, WalletProvider wallet) {
    final address = wallet.addressHex;
    final shortAddr = wallet.isConnected ? wallet.addressShort : '未登录';

    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 24, 20, 0),
      child: Column(
        children: [
          // Avatar — Google photo or gradient placeholder
          Container(
            width: 80,
            height: 80,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              gradient: wallet.photoUrl == null
                  ? const LinearGradient(
                      colors: [Color(0xFF7C3AED), Color(0xFFEC4899)],
                      begin: Alignment.topLeft,
                      end: Alignment.bottomRight,
                    )
                  : null,
              boxShadow: [
                BoxShadow(
                  color: AppTheme.purpleStart.withValues(alpha: 0.5),
                  blurRadius: 24,
                  offset: const Offset(0, 8),
                ),
              ],
            ),
            child: wallet.photoUrl != null
                ? ClipOval(
                    child: Image.network(
                      wallet.photoUrl!,
                      width: 80,
                      height: 80,
                      fit: BoxFit.cover,
                      errorBuilder: (_, __, ___) => _buildDefaultAvatar(),
                    ),
                  )
                : _buildDefaultAvatar(),
          ),
          const SizedBox(height: 12),

          // Name / email
          if (wallet.isConnected) ...[
            Text(
              wallet.displayName,
              style: const TextStyle(
                fontSize: 18,
                fontWeight: FontWeight.w700,
                color: AppTheme.textPrimary,
              ),
            ),
            const SizedBox(height: 2),
            Text(
              wallet.email,
              style: const TextStyle(fontSize: 12, color: Color(0x60FFFFFF)),
            ),
            const SizedBox(height: 8),
          ],

          // Wallet address
          GestureDetector(
            onTap: () {
              if (address != null) {
                Clipboard.setData(ClipboardData(text: address));
                ScaffoldMessenger.of(context).showSnackBar(
                  const SnackBar(
                    content: Text('地址已复制'),
                    duration: Duration(seconds: 1),
                  ),
                );
              }
            },
            child: Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                Text(
                  shortAddr,
                  style: const TextStyle(
                    fontSize: 14,
                    fontWeight: FontWeight.w600,
                    color: Color(0x80FFFFFF),
                  ),
                ),
                if (address != null) ...[
                  const SizedBox(width: 6),
                  const Icon(Icons.content_copy,
                      size: 14, color: Color(0x50FFFFFF)),
                ],
              ],
            ),
          ),

          const SizedBox(height: 4),
          Text(
            wallet.isConnected ? 'BSC Testnet' : '使用 Google 账号登录',
            style: const TextStyle(fontSize: 12, color: Color(0x40FFFFFF)),
          ),

          // Login / Logout button
          if (!wallet.isConnected) ...[
            const SizedBox(height: 16),
            _buildGoogleLoginButton(context, wallet),
          ] else ...[
            const SizedBox(height: 12),
            GestureDetector(
              onTap: () => wallet.disconnect(),
              child: Container(
                padding:
                    const EdgeInsets.symmetric(horizontal: 20, vertical: 8),
                decoration: BoxDecoration(
                  color: const Color(0x08FFFFFF),
                  borderRadius: BorderRadius.circular(16),
                  border: Border.all(color: const Color(0x0AFFFFFF)),
                ),
                child: const Text(
                  '退出登录',
                  style: TextStyle(fontSize: 12, color: Color(0x60FFFFFF)),
                ),
              ),
            ),
          ],
        ],
      ),
    );
  }

  Widget _buildDefaultAvatar() {
    return Center(
      child: Container(
        width: 80,
        height: 80,
        decoration: const BoxDecoration(
          shape: BoxShape.circle,
          gradient: LinearGradient(
            colors: [Color(0xFF7C3AED), Color(0xFFEC4899)],
            begin: Alignment.topLeft,
            end: Alignment.bottomRight,
          ),
        ),
        child: const Center(
          child: Icon(Icons.person, size: 36, color: Colors.white),
        ),
      ),
    );
  }

  Widget _buildGoogleLoginButton(BuildContext context, WalletProvider wallet) {
    // Use Google's native rendered sign-in button on web
    final plugin = GoogleSignInPlatform.instance;
    if (plugin is GoogleSignInPlugin) {
      return SizedBox(
        width: 240,
        height: 44,
        child: plugin.renderButton(
          configuration: GSIButtonConfiguration(
            theme: GSIButtonTheme.filledBlue,
            size: GSIButtonSize.large,
            text: GSIButtonText.signinWith,
            shape: GSIButtonShape.pill,
          ),
        ),
      );
    }
    // Fallback for non-web platforms
    return GestureDetector(
      onTap: () {},
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 12),
        decoration: BoxDecoration(
          color: Colors.white,
          borderRadius: BorderRadius.circular(24),
        ),
        child: const Text('Google 登录',
            style: TextStyle(fontSize: 14, color: Color(0xFF333333))),
      ),
    );
  }

  Widget _buildMenuSection(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 28, 16, 0),
      child: Container(
        decoration: BoxDecoration(
          color: const Color(0x08FFFFFF),
          borderRadius: BorderRadius.circular(16),
          border: Border.all(color: const Color(0x0AFFFFFF)),
        ),
        child: Column(
          children: [
            _buildMenuItem(
              icon: Icons.notifications_outlined,
              label: '消息通知',
              onTap: () => _showSnack(context, '消息通知开发中...'),
            ),
            _divider(),
            _buildMenuItem(
              icon: Icons.shield_outlined,
              label: '安全设置',
              onTap: () => _showSnack(context, '安全设置开发中...'),
            ),
            _divider(),
            _buildMenuItem(
              icon: Icons.language,
              label: '语言',
              trailing: '简体中文',
              onTap: () => _showSnack(context, '语言切换开发中...'),
            ),
            _divider(),
            _buildMenuItem(
              icon: Icons.dark_mode_outlined,
              label: '主题',
              trailing: '深色模式',
              onTap: () => _showSnack(context, '当前仅支持深色模式'),
            ),
            _divider(),
            _buildMenuItem(
              icon: Icons.help_outline,
              label: '帮助与反馈',
              onTap: () => _showSnack(context, '帮助与反馈开发中...'),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildMenuItem({
    required IconData icon,
    required String label,
    String? trailing,
    required VoidCallback onTap,
  }) {
    return GestureDetector(
      onTap: onTap,
      behavior: HitTestBehavior.opaque,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
        child: Row(
          children: [
            Icon(icon, size: 20, color: const Color(0x80FFFFFF)),
            const SizedBox(width: 12),
            Expanded(
              child: Text(
                label,
                style: const TextStyle(
                  fontSize: 14,
                  color: AppTheme.textPrimary,
                ),
              ),
            ),
            if (trailing != null)
              Text(
                trailing,
                style: const TextStyle(fontSize: 13, color: Color(0x50FFFFFF)),
              ),
            const SizedBox(width: 4),
            const Icon(Icons.chevron_right,
                size: 18, color: Color(0x30FFFFFF)),
          ],
        ),
      ),
    );
  }

  Widget _divider() {
    return Container(
      margin: const EdgeInsets.symmetric(horizontal: 16),
      height: 0.5,
      color: const Color(0x10FFFFFF),
    );
  }

  Widget _buildAbout() {
    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 32, 20, 100),
      child: Column(
        children: [
          const Text(
            'AgentX v0.1.0',
            style: TextStyle(fontSize: 13, color: Color(0x30FFFFFF)),
          ),
          const SizedBox(height: 4),
          const Text(
            '每一个 AI 智能体都是一个 Token',
            textAlign: TextAlign.center,
            style: TextStyle(
              fontSize: 11,
              color: Color(0x20FFFFFF),
              height: 1.5,
            ),
          ),
        ],
      ),
    );
  }

  void _showSnack(BuildContext context, String message) {
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(message), duration: const Duration(seconds: 1)),
    );
  }
}
