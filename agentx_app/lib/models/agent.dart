/// AI Agent model — each agent is a tradable token
class Agent {
  final String id;
  final String name;
  final String description;
  final String emoji;
  final String? avatarUrl; // user-uploaded avatar URL or base64
  final String category;
  final double price;
  final double change24h;
  final int holders;
  final int chats;
  final String? tokenAddress;

  const Agent({
    required this.id,
    required this.name,
    required this.description,
    required this.emoji,
    this.avatarUrl,
    required this.category,
    required this.price,
    required this.change24h,
    required this.holders,
    required this.chats,
    this.tokenAddress,
  });

  bool get isPositive => change24h >= 0;

  String get priceFormatted => '\$${price.toStringAsFixed(3)}';

  String get changeFormatted =>
      '${isPositive ? "+" : ""}${change24h.toStringAsFixed(1)}%';

  String get holdersFormatted {
    if (holders >= 1000) return '${(holders / 1000).toStringAsFixed(1)}K';
    return holders.toString();
  }

  String get chatsFormatted {
    if (chats >= 1000) return '${(chats / 1000).toStringAsFixed(0)}K';
    return chats.toString();
  }

  /// Fallback data shown while DEXI API loads
  static List<Agent> get fallbackAgents => const [
        Agent(
          id: '1',
          name: 'CryptoTeacher',
          description: '区块链入门教育智能体',
          emoji: '🦉',
          category: '教育',
          price: 0.052,
          change24h: 12.5,
          holders: 1200,
          chats: 32000,
        ),
        Agent(
          id: '2',
          name: 'TradeBot',
          description: 'AI 量化交易助手',
          emoji: '🤖',
          category: '金融',
          price: 0.128,
          change24h: 0.3,
          holders: 678,
          chats: 56000,
        ),
        Agent(
          id: '3',
          name: 'MemeKing',
          description: 'Meme 文化玩梗大师',
          emoji: '🐕',
          category: '娱乐',
          price: 0.003,
          change24h: 4.2,
          holders: 1800,
          chats: 128000,
        ),
        Agent(
          id: '4',
          name: 'HealthBot',
          description: 'AI 健康咨询医生',
          emoji: '🏥',
          category: '工具',
          price: 0.045,
          change24h: 6.7,
          holders: 2100,
          chats: 89000,
        ),
        Agent(
          id: '5',
          name: 'FinanceGuru',
          description: '金融分析投资顾问',
          emoji: '🐂',
          category: '金融',
          price: 0.018,
          change24h: 8.1,
          holders: 890,
          chats: 45000,
        ),
        Agent(
          id: '6',
          name: 'CodeMentor',
          description: '编程导师代码审查',
          emoji: '💻',
          category: '工具',
          price: 0.091,
          change24h: -1.2,
          holders: 560,
          chats: 23000,
        ),
      ];
}
