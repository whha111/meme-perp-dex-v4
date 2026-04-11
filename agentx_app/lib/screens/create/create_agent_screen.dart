import 'dart:typed_data';
import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';
import 'package:provider/provider.dart';
import '../../core/theme/app_theme.dart';
import '../../models/agent.dart';
import '../../providers/agent_store.dart';
import '../../providers/wallet_provider.dart';
import '../../services/contract/token_factory_service.dart';

/// Create Agent screen — fill in agent info to mint a new token
class CreateAgentScreen extends StatefulWidget {
  const CreateAgentScreen({super.key});

  @override
  State<CreateAgentScreen> createState() => _CreateAgentScreenState();
}

class _CreateAgentScreenState extends State<CreateAgentScreen> {
  final _nameController = TextEditingController();
  final _descController = TextEditingController();
  final _promptController = TextEditingController();
  String _selectedCategory = '金融';
  String _selectedModel = 'DeepSeek';
  bool _isCreating = false;

  // Image upload state
  final _picker = ImagePicker();
  Uint8List? _avatarBytes;
  String? _avatarName;

  final _categories = ['金融', '教育', '工具', '娱乐', '生活'];
  final _models = ['DeepSeek', 'Qwen'];

  @override
  void initState() {
    super.initState();
    // Rebuild when name changes so the button enables/disables
    _nameController.addListener(() => setState(() {}));
  }

  @override
  void dispose() {
    _nameController.dispose();
    _descController.dispose();
    _promptController.dispose();
    super.dispose();
  }

  Future<void> _pickAvatar() async {
    final picked = await _picker.pickImage(
      source: ImageSource.gallery,
      maxWidth: 512,
      maxHeight: 512,
      imageQuality: 85,
    );
    if (picked != null) {
      final bytes = await picked.readAsBytes();
      setState(() {
        _avatarBytes = bytes;
        _avatarName = picked.name;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppTheme.background,
      body: SafeArea(
        child: Column(
          children: [
            _buildAppBar(),
            Expanded(
              child: SingleChildScrollView(
                padding: const EdgeInsets.fromLTRB(16, 0, 16, 32),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const SizedBox(height: 16),
                    _buildAvatarUpload(),
                    const SizedBox(height: 24),
                    _buildTextField('智能体名称', '例如: CryptoTeacher', _nameController, maxLength: 20),
                    const SizedBox(height: 16),
                    _buildTextField('简介', '一句话描述你的智能体', _descController, maxLength: 50),
                    const SizedBox(height: 16),
                    _buildCategoryPicker(),
                    const SizedBox(height: 16),
                    _buildModelPicker(),
                    const SizedBox(height: 16),
                    _buildTextField(
                      'System Prompt (人设)',
                      '你是一个专业的区块链教育智能体，擅长用简单易懂的方式讲解复杂概念...',
                      _promptController,
                      maxLines: 5,
                    ),
                    const SizedBox(height: 28),
                    _buildCreateButton(),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildAppBar() {
    return Padding(
      padding: const EdgeInsets.fromLTRB(8, 8, 16, 0),
      child: Row(
        children: [
          IconButton(
            onPressed: () => Navigator.pop(context),
            icon: const Icon(Icons.arrow_back_ios_new, size: 20, color: Color(0x99FFFFFF)),
          ),
          const Text(
            '创建智能体',
            style: TextStyle(
              fontSize: 18,
              fontWeight: FontWeight.w700,
              color: AppTheme.textPrimary,
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildAvatarUpload() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Text(
          '智能体头像',
          style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: Color(0x99FFFFFF)),
        ),
        const SizedBox(height: 12),
        Center(
          child: GestureDetector(
            onTap: _pickAvatar,
            child: Stack(
              children: [
                // Avatar circle
                Container(
                  width: 96,
                  height: 96,
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    color: const Color(0x08FFFFFF),
                    border: Border.all(
                      color: _avatarBytes != null
                          ? AppTheme.purpleStart
                          : const Color(0x15FFFFFF),
                      width: _avatarBytes != null ? 2 : 1,
                    ),
                    image: _avatarBytes != null
                        ? DecorationImage(
                            image: MemoryImage(_avatarBytes!),
                            fit: BoxFit.cover,
                          )
                        : null,
                  ),
                  child: _avatarBytes == null
                      ? const Column(
                          mainAxisAlignment: MainAxisAlignment.center,
                          children: [
                            Icon(Icons.add_photo_alternate_outlined,
                                size: 32, color: Color(0x50FFFFFF)),
                            SizedBox(height: 4),
                            Text(
                              '上传头像',
                              style: TextStyle(fontSize: 10, color: Color(0x40FFFFFF)),
                            ),
                          ],
                        )
                      : null,
                ),
                // Edit badge (shown when avatar is set)
                if (_avatarBytes != null)
                  Positioned(
                    right: 0,
                    bottom: 0,
                    child: Container(
                      width: 28,
                      height: 28,
                      decoration: BoxDecoration(
                        gradient: const LinearGradient(
                          colors: [Color(0xFF7C3AED), Color(0xFFEC4899)],
                        ),
                        shape: BoxShape.circle,
                        border: Border.all(color: AppTheme.background, width: 2),
                      ),
                      child: const Icon(Icons.edit, size: 14, color: Colors.white),
                    ),
                  ),
              ],
            ),
          ),
        ),
        if (_avatarName != null)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Center(
              child: Text(
                _avatarName!,
                style: const TextStyle(fontSize: 11, color: Color(0x40FFFFFF)),
              ),
            ),
          ),
      ],
    );
  }

  Widget _buildTextField(String label, String hint, TextEditingController controller, {int maxLines = 1, int? maxLength}) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(label, style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: Color(0x99FFFFFF))),
        const SizedBox(height: 8),
        Container(
          decoration: BoxDecoration(
            color: const Color(0x08FFFFFF),
            borderRadius: BorderRadius.circular(14),
            border: Border.all(color: const Color(0x0AFFFFFF)),
          ),
          child: TextField(
            controller: controller,
            maxLines: maxLines,
            maxLength: maxLength,
            style: const TextStyle(color: AppTheme.textPrimary, fontSize: 14),
            decoration: InputDecoration(
              hintText: hint,
              hintStyle: const TextStyle(color: Color(0x40FFFFFF), fontSize: 13),
              border: InputBorder.none,
              contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
              counterStyle: const TextStyle(color: Color(0x40FFFFFF), fontSize: 11),
            ),
          ),
        ),
      ],
    );
  }

  Widget _buildCategoryPicker() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Text('分类', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: Color(0x99FFFFFF))),
        const SizedBox(height: 8),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: _categories.map((cat) {
            final isSelected = cat == _selectedCategory;
            return GestureDetector(
              onTap: () => setState(() => _selectedCategory = cat),
              child: AnimatedContainer(
                duration: const Duration(milliseconds: 200),
                padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
                decoration: BoxDecoration(
                  gradient: isSelected
                      ? const LinearGradient(colors: [Color(0xFF7C3AED), Color(0xFFEC4899)])
                      : null,
                  color: isSelected ? null : const Color(0x08FFFFFF),
                  borderRadius: BorderRadius.circular(20),
                  border: isSelected ? null : Border.all(color: const Color(0x0AFFFFFF)),
                ),
                child: Text(
                  cat,
                  style: TextStyle(
                    fontSize: 13,
                    fontWeight: isSelected ? FontWeight.w600 : FontWeight.w400,
                    color: isSelected ? Colors.white : const Color(0x80FFFFFF),
                  ),
                ),
              ),
            );
          }).toList(),
        ),
      ],
    );
  }

  Widget _buildModelPicker() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Text('LLM 模型', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: Color(0x99FFFFFF))),
        const SizedBox(height: 8),
        Row(
          children: _models.map((model) {
            final isSelected = model == _selectedModel;
            return Padding(
              padding: const EdgeInsets.only(right: 10),
              child: GestureDetector(
                onTap: () => setState(() => _selectedModel = model),
                child: AnimatedContainer(
                  duration: const Duration(milliseconds: 200),
                  padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 10),
                  decoration: BoxDecoration(
                    color: isSelected ? const Color(0x30A78BFA) : const Color(0x08FFFFFF),
                    borderRadius: BorderRadius.circular(12),
                    border: Border.all(
                      color: isSelected ? AppTheme.purpleStart : const Color(0x0AFFFFFF),
                      width: isSelected ? 2 : 1,
                    ),
                  ),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Icon(
                        Icons.auto_awesome,
                        size: 16,
                        color: isSelected ? const Color(0xFFA78BFA) : const Color(0x60FFFFFF),
                      ),
                      const SizedBox(width: 6),
                      Text(
                        model,
                        style: TextStyle(
                          fontSize: 13,
                          fontWeight: isSelected ? FontWeight.w600 : FontWeight.w400,
                          color: isSelected ? const Color(0xFFA78BFA) : const Color(0x80FFFFFF),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            );
          }).toList(),
        ),
      ],
    );
  }

  Widget _buildCreateButton() {
    final isValid = _nameController.text.trim().isNotEmpty;

    return GestureDetector(
      onTap: isValid && !_isCreating ? _handleCreate : null,
      child: Container(
        width: double.infinity,
        height: 52,
        decoration: BoxDecoration(
          gradient: isValid
              ? const LinearGradient(
                  colors: [Color(0xFF7C3AED), Color(0xFF9333EA), Color(0xFFEC4899)],
                  begin: Alignment.centerLeft,
                  end: Alignment.centerRight,
                )
              : null,
          color: isValid ? null : const Color(0x15FFFFFF),
          borderRadius: BorderRadius.circular(16),
          boxShadow: isValid
              ? [
                  BoxShadow(
                    color: AppTheme.purpleStart.withValues(alpha: 0.4),
                    blurRadius: 20,
                    offset: const Offset(0, 8),
                  ),
                ]
              : null,
        ),
        child: Center(
          child: _isCreating
              ? const SizedBox(
                  width: 22,
                  height: 22,
                  child: CircularProgressIndicator(
                    strokeWidth: 2,
                    color: Colors.white,
                  ),
                )
              : Text(
                  '创建智能体 & 发行 Token',
                  style: TextStyle(
                    fontSize: 15,
                    fontWeight: FontWeight.w700,
                    color: isValid ? Colors.white : const Color(0x40FFFFFF),
                  ),
                ),
        ),
      ),
    );
  }

  Future<void> _handleCreate() async {
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

    // Check BNB balance — need gas + service fee
    await wallet.refreshBalance();
    if (wallet.balance == BigInt.zero) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            '余额不足！请先往钱包充入 BNB (测试网)\n'
            '地址: ${wallet.addressHex}',
          ),
          backgroundColor: AppTheme.red,
          duration: const Duration(seconds: 5),
        ),
      );
      return;
    }

    setState(() => _isCreating = true);

    try {
      final factory = TokenFactoryService();
      final name = _nameController.text.trim();
      final symbol = name.length > 5
          ? name.substring(0, 5).toUpperCase()
          : name.toUpperCase();
      final metadataURI =
          'agentx://$name|$_selectedCategory|$_selectedModel|${_promptController.text.trim()}';

      // Check service fee vs balance
      final serviceFee = await factory.getServiceFee();
      if (wallet.balance < serviceFee + BigInt.from(100000 * 5e9.toInt())) {
        // Need at least serviceFee + ~0.0005 BNB gas
        if (!mounted) return;
        setState(() => _isCreating = false);
        final feeInBnb = serviceFee / BigInt.from(10).pow(18);
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(
              'BNB 余额不足！需要至少 $feeInBnb BNB (服务费) + Gas\n'
              '当前余额: ${wallet.balanceFormatted} BNB',
            ),
            backgroundColor: AppTheme.red,
            duration: const Duration(seconds: 5),
          ),
        );
        return;
      }

      final txHash = await factory.createToken(
        credentials: wallet.credentials!,
        name: name,
        symbol: symbol,
        metadataURI: metadataURI,
      );

      if (!mounted) return;

      // Save to local agent store so it shows in marketplace
      final newAgent = Agent(
        id: txHash, // Use txHash as temporary ID
        name: name,
        description: _descController.text.trim().isNotEmpty
            ? _descController.text.trim()
            : '$_selectedCategory 智能体',
        emoji: '🤖',
        category: _selectedCategory,
        price: 0.001,
        change24h: 0.0,
        holders: 1,
        chats: 0,
        tokenAddress: null, // Will be resolved after tx confirms
      );
      context.read<AgentStore>().addAgent(newAgent);

      setState(() => _isCreating = false);

      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text('智能体 "$name" 创建成功！\nTx: ${txHash.substring(0, 10)}...'),
          backgroundColor: AppTheme.green,
          duration: const Duration(seconds: 3),
        ),
      );
      Navigator.pop(context);
    } catch (e) {
      if (!mounted) return;
      setState(() => _isCreating = false);
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text('创建失败: $e'),
          backgroundColor: AppTheme.red,
          duration: const Duration(seconds: 3),
        ),
      );
    }
  }
}
