import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../../core/theme/app_theme.dart';
import '../../models/agent.dart';
import '../../providers/agent_store.dart';
import '../chat/chat_screen.dart';
import '../create/create_agent_screen.dart';

/// Marketplace — browse AI agents (each is a tradable token)
class MarketplaceScreen extends StatefulWidget {
  const MarketplaceScreen({super.key});

  @override
  State<MarketplaceScreen> createState() => _MarketplaceScreenState();
}

class _MarketplaceScreenState extends State<MarketplaceScreen> {
  // Icon + color mapping for each agent (replaces emoji in Pencil design)
  static const _agentStyles = {
    'CryptoTeacher': (Icons.school, Color(0xFF34D399), Color(0x3034D399)),
    'TradeBot': (Icons.smart_toy, Color(0xFFA78BFA), Color(0x30A78BFA)),
    'MemeKing': (Icons.pets, Color(0xFFFBBF24), Color(0x30FBBF24)),
    'HealthBot': (Icons.local_hospital, Color(0xFFF87171), Color(0x30F87171)),
    'FinanceGuru': (Icons.trending_up, Color(0xFF60A5FA), Color(0x3060A5FA)),
    'CodeMentor': (Icons.code, Color(0xFF818CF8), Color(0x30818CF8)),
  };

  IconData _iconFor(Agent agent) =>
      _agentStyles[agent.name]?.$1 ?? Icons.smart_toy;
  Color _colorFor(Agent agent) =>
      _agentStyles[agent.name]?.$2 ?? const Color(0xFFA78BFA);
  Color _bgFor(Agent agent) =>
      _agentStyles[agent.name]?.$3 ?? const Color(0x30A78BFA);

  String _selectedCategory = '全部';
  final _categories = ['全部', '金融', '教育', '工具', '娱乐', '生活'];

  @override
  void initState() {
    super.initState();
    // Fetch real tickers from DEXI on first load
    WidgetsBinding.instance.addPostFrameCallback((_) {
      context.read<AgentStore>().fetchFromDexi();
    });
  }

  @override
  Widget build(BuildContext context) {
    final store = context.watch<AgentStore>();
    final agents = store.byCategory(_selectedCategory);
    final heroAgent = store.allAgents.length > 1
        ? store.allAgents[1]
        : store.allAgents.first;

    return Scaffold(
      body: SafeArea(
        bottom: false,
        child: RefreshIndicator(
          onRefresh: () => context.read<AgentStore>().fetchFromDexi(),
          color: AppTheme.purpleStart,
          child: CustomScrollView(
            slivers: [
            // Header
            SliverToBoxAdapter(child: _buildHeader()),
            // Hero card
            SliverToBoxAdapter(child: _buildHeroCard(heroAgent)),
            // Category filter
            SliverToBoxAdapter(child: _buildCategories()),
            // Hot agents horizontal scroll
            SliverToBoxAdapter(child: _buildHotSection(agents)),
            // All agents list
            SliverToBoxAdapter(child: _buildAllAgentsHeader()),
            SliverPadding(
              padding: const EdgeInsets.fromLTRB(16, 0, 16, 100),
              sliver: SliverList(
                delegate: SliverChildBuilderDelegate(
                  (context, index) =>
                      _buildAgentListTile(agents[index]),
                  childCount: agents.length,
                ),
              ),
            ),
          ],
          ),
        ),
      ),
    );
  }

  Widget _buildHeader() {
    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 12, 20, 0),
      child: Row(
        children: [
          // Small gradient icon
          Container(
            width: 36,
            height: 36,
            decoration: BoxDecoration(
              gradient: const LinearGradient(
                colors: [Color(0xFF7C3AED), Color(0xFFEC4899)],
                begin: Alignment.topLeft,
                end: Alignment.bottomRight,
              ),
              borderRadius: BorderRadius.circular(10),
            ),
            child: const Icon(Icons.smart_toy, size: 20, color: Colors.white),
          ),
          const SizedBox(width: 10),
          const Text(
            'AgentX',
            style: TextStyle(
              fontSize: 20,
              fontWeight: FontWeight.w800,
              color: AppTheme.textPrimary,
              letterSpacing: -0.5,
            ),
          ),
          const Spacer(),
          // 创建智能体按钮
          GestureDetector(
            onTap: () {
              Navigator.of(context).push(
                MaterialPageRoute(builder: (_) => const CreateAgentScreen()),
              );
            },
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
              decoration: BoxDecoration(
                gradient: const LinearGradient(
                  colors: [Color(0xFF7C3AED), Color(0xFFEC4899)],
                  begin: Alignment.centerLeft,
                  end: Alignment.centerRight,
                ),
                borderRadius: BorderRadius.circular(20),
                boxShadow: [
                  BoxShadow(
                    color: AppTheme.purpleStart.withValues(alpha: 0.3),
                    blurRadius: 12,
                    offset: const Offset(0, 4),
                  ),
                ],
              ),
              child: const Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(Icons.add, size: 16, color: Colors.white),
                  SizedBox(width: 4),
                  Text(
                    '创建',
                    style: TextStyle(
                      fontSize: 13,
                      fontWeight: FontWeight.w600,
                      color: Colors.white,
                    ),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildCategories() {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 14, 16, 0),
      child: SizedBox(
        height: 36,
        child: ListView.builder(
          scrollDirection: Axis.horizontal,
          itemCount: _categories.length,
          itemBuilder: (context, index) {
            final cat = _categories[index];
            final isSelected = cat == _selectedCategory;
            return Padding(
              padding: const EdgeInsets.only(right: 8),
              child: GestureDetector(
                onTap: () => setState(() => _selectedCategory = cat),
                child: AnimatedContainer(
                  duration: const Duration(milliseconds: 200),
                  padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 7),
                  decoration: BoxDecoration(
                    gradient: isSelected
                        ? const LinearGradient(
                            colors: [Color(0xFF7C3AED), Color(0xFFEC4899)],
                            begin: Alignment.centerLeft,
                            end: Alignment.centerRight,
                          )
                        : null,
                    color: isSelected ? null : const Color(0x08FFFFFF),
                    borderRadius: BorderRadius.circular(20),
                    border: isSelected
                        ? null
                        : Border.all(color: const Color(0x0AFFFFFF)),
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
              ),
            );
          },
        ),
      ),
    );
  }

  Widget _buildHeroCard(Agent agent) {
    return GestureDetector(
      onTap: () => _openChat(agent),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 16, 16, 0),
        child: Container(
          height: 200,
          padding: const EdgeInsets.all(20),
          decoration: BoxDecoration(
            gradient: const LinearGradient(
              colors: [Color(0xFF1E1B4B), Color(0xFF312E81)],
              begin: Alignment.topLeft,
              end: Alignment.bottomRight,
            ),
            borderRadius: BorderRadius.circular(24),
            border: Border.all(color: const Color(0x20FFFFFF)),
            boxShadow: [
              BoxShadow(
                color: AppTheme.purpleStart.withValues(alpha: 0.2),
                blurRadius: 24,
                offset: const Offset(0, 8),
              ),
            ],
          ),
          child: Row(
            children: [
              // Left info
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    // TOP AGENT badge
                    Row(
                      children: [
                        const Text('🏆', style: TextStyle(fontSize: 12)),
                        const SizedBox(width: 4),
                        Text(
                          'TOP AGENT',
                          style: TextStyle(
                            fontSize: 11,
                            fontWeight: FontWeight.w700,
                            color: AppTheme.purpleStart,
                            letterSpacing: 1,
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 8),
                    Text(
                      agent.name,
                      style: const TextStyle(
                        fontSize: 24,
                        fontWeight: FontWeight.w800,
                        color: Colors.white,
                      ),
                    ),
                    const SizedBox(height: 4),
                    Text(
                      '${agent.description} · ${agent.chatsFormatted} 聊天',
                      style: const TextStyle(
                          fontSize: 12, color: Color(0x99FFFFFF)),
                    ),
                    const SizedBox(height: 8),
                    // Price row
                    Row(
                      children: [
                        Text(
                          agent.priceFormatted,
                          style: const TextStyle(
                            fontSize: 22,
                            fontWeight: FontWeight.w800,
                            color: Colors.white,
                          ),
                        ),
                        const SizedBox(width: 8),
                        Container(
                          padding: const EdgeInsets.symmetric(
                              horizontal: 6, vertical: 2),
                          decoration: BoxDecoration(
                            color: AppTheme.green.withValues(alpha: 0.15),
                            borderRadius: BorderRadius.circular(6),
                          ),
                          child: Text(
                            agent.changeFormatted,
                            style: const TextStyle(
                              fontSize: 11,
                              fontWeight: FontWeight.w600,
                              color: AppTheme.green,
                            ),
                          ),
                        ),
                      ],
                    ),
                    const Spacer(),
                    // Chat button
                    Container(
                      padding: const EdgeInsets.symmetric(
                          horizontal: 16, vertical: 8),
                      decoration: BoxDecoration(
                        gradient: AppTheme.purpleGradient,
                        borderRadius: BorderRadius.circular(20),
                      ),
                      child: const Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Icon(Icons.chat_bubble_outline,
                              size: 14, color: Colors.white),
                          SizedBox(width: 6),
                          Text(
                            '开始聊天',
                            style: TextStyle(
                              fontSize: 13,
                              fontWeight: FontWeight.w600,
                              color: Colors.white,
                            ),
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
              // Right: agent icon
              Container(
                width: 72,
                height: 72,
                decoration: BoxDecoration(
                  color: _bgFor(agent),
                  borderRadius: BorderRadius.circular(20),
                ),
                child: Icon(_iconFor(agent), size: 40, color: _colorFor(agent)),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildHotSection(List<Agent> agents) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(20, 20, 20, 12),
          child: Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              const Text(
                '热门 Agents',
                style: TextStyle(
                  fontSize: 16,
                  fontWeight: FontWeight.w700,
                  color: AppTheme.textPrimary,
                ),
              ),
              Text(
                '全部',
                style: TextStyle(
                    fontSize: 13, color: AppTheme.purpleStart),
              ),
            ],
          ),
        ),
        SizedBox(
          height: 160,
          child: ListView.builder(
            scrollDirection: Axis.horizontal,
            padding: const EdgeInsets.symmetric(horizontal: 16),
            itemCount: agents.length,
            itemBuilder: (context, index) =>
                _buildHotAgentCard(agents[index]),
          ),
        ),
      ],
    );
  }

  Widget _buildHotAgentCard(Agent agent) {
    return GestureDetector(
      onTap: () => _openChat(agent),
      child: Container(
        width: 130,
        margin: const EdgeInsets.only(right: 10),
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(
          color: const Color(0x08FFFFFF),
          borderRadius: BorderRadius.circular(18),
          border: Border.all(color: const Color(0x0AFFFFFF)),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // Icon
            Container(
              width: 44,
              height: 44,
              decoration: BoxDecoration(
                color: _bgFor(agent),
                borderRadius: BorderRadius.circular(14),
              ),
              child: Icon(_iconFor(agent), size: 24, color: _colorFor(agent)),
            ),
            const SizedBox(height: 10),
            Text(
              agent.name,
              style: const TextStyle(
                fontSize: 13,
                fontWeight: FontWeight.w600,
                color: AppTheme.textPrimary,
              ),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
            const SizedBox(height: 2),
            Text(
              agent.description,
              style: const TextStyle(fontSize: 10, color: Color(0x60FFFFFF)),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
            const Spacer(),
            // Price + change
            Row(
              children: [
                Text(
                  agent.priceFormatted,
                  style: const TextStyle(
                    fontSize: 13,
                    fontWeight: FontWeight.w700,
                    color: AppTheme.textPrimary,
                  ),
                ),
                const SizedBox(width: 4),
                Text(
                  agent.changeFormatted,
                  style: TextStyle(
                    fontSize: 10,
                    fontWeight: FontWeight.w600,
                    color: agent.isPositive ? AppTheme.green : AppTheme.red,
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildAllAgentsHeader() {
    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 20, 20, 12),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          const Text(
            '所有 Agents',
            style: TextStyle(
              fontSize: 16,
              fontWeight: FontWeight.w700,
              color: AppTheme.textPrimary,
            ),
          ),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
            decoration: BoxDecoration(
              color: const Color(0x08FFFFFF),
              borderRadius: BorderRadius.circular(8),
              border: Border.all(color: const Color(0x0AFFFFFF)),
            ),
            child: const Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(Icons.sort, size: 14, color: Color(0x80FFFFFF)),
                SizedBox(width: 4),
                Text(
                  '排序',
                  style: TextStyle(fontSize: 12, color: Color(0x80FFFFFF)),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildAgentListTile(Agent agent) {
    return GestureDetector(
      onTap: () => _openChat(agent),
      child: Container(
        margin: const EdgeInsets.only(bottom: 8),
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
        decoration: BoxDecoration(
          color: const Color(0x08FFFFFF),
          borderRadius: BorderRadius.circular(16),
          border: Border.all(color: const Color(0x0AFFFFFF)),
        ),
        child: Row(
          children: [
            // Agent icon
            Container(
              width: 44,
              height: 44,
              decoration: BoxDecoration(
                color: _bgFor(agent),
                borderRadius: BorderRadius.circular(14),
              ),
              child:
                  Icon(_iconFor(agent), size: 24, color: _colorFor(agent)),
            ),
            const SizedBox(width: 12),
            // Info
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    agent.name,
                    style: const TextStyle(
                      fontSize: 14,
                      fontWeight: FontWeight.w600,
                      color: AppTheme.textPrimary,
                    ),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    '${agent.description} · ${agent.holdersFormatted} 持有',
                    style:
                        const TextStyle(fontSize: 11, color: Color(0x60FFFFFF)),
                  ),
                ],
              ),
            ),
            // Price + change
            Column(
              crossAxisAlignment: CrossAxisAlignment.end,
              children: [
                Text(
                  agent.priceFormatted,
                  style: const TextStyle(
                    fontSize: 15,
                    fontWeight: FontWeight.w700,
                    color: AppTheme.textPrimary,
                  ),
                ),
                const SizedBox(height: 2),
                Text(
                  agent.changeFormatted,
                  style: TextStyle(
                    fontSize: 11,
                    fontWeight: FontWeight.w600,
                    color: agent.isPositive ? AppTheme.green : AppTheme.red,
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  void _openChat(Agent agent) {
    Navigator.of(context).push(
      MaterialPageRoute(
        builder: (_) => ChatScreen(agent: agent),
      ),
    );
  }
}
