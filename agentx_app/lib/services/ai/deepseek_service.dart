import 'dart:convert';
import 'package:http/http.dart' as http;
import '../../core/config/app_config.dart';
import '../../models/chat_message.dart';

/// DeepSeek AI service with Function Calling
class DeepSeekService {
  final String apiKey;
  final String _baseUrl = AppConfig.deepseekApiUrl;

  DeepSeekService({required this.apiKey});

  /// Available tools for Function Calling
  static final List<Map<String, dynamic>> tools = [
    // Trading tools
    _tool('place_order', '下单买入或卖出 Agent Token', {
      'token_name': {'type': 'string', 'description': 'Agent 名称'},
      'side': {'type': 'string', 'enum': ['buy', 'sell'], 'description': '买入或卖出'},
      'amount': {'type': 'number', 'description': '金额 (BNB)'},
    }),
    _tool('close_position', '平仓某个 Agent 的持仓', {
      'token_name': {'type': 'string', 'description': 'Agent 名称'},
    }),
    _tool('get_positions', '查询当前所有持仓', {}),
    _tool('get_balance', '查询钱包余额', {}),

    // Risk analysis tools
    _tool('check_contract_safety', '检查合约安全性（貔貅盘/跑路狗检测）', {
      'address': {'type': 'string', 'description': '合约地址'},
    }),
    _tool('check_holder_concentration', '分析持仓集中度', {
      'address': {'type': 'string', 'description': 'Token 合约地址'},
    }),

    // Analytics tools
    _tool('analyze_trade_history', '分析交易历史，计算胜率和盈亏', {}),
    _tool('get_pnl_summary', '获取盈亏汇总', {}),

    // Market tools
    _tool('get_token_price', '查询 Agent Token 实时价格', {
      'token_name': {'type': 'string', 'description': 'Agent 名称'},
    }),
    _tool('get_market_overview', '获取市场概览', {}),
  ];

  /// Send message with function calling support
  Future<ChatResponse> chat(List<ChatMessage> messages) async {
    final body = {
      'model': AppConfig.deepseekModel,
      'messages': [
        {
          'role': 'system',
          'content': '''你是 AgentX 的 AI 交易助手。你可以帮用户：
- 买入/卖出 Agent Token
- 查询余额和持仓
- 分析合约安全性（检测貔貅盘、跑路狗）
- 分析交易历史和盈亏
- 查看市场行情

用简洁的中文回复。涉及交易操作时调用对应的工具函数。'''
        },
        ...messages.map((m) => _messageToJson(m)),
      ],
      'tools': tools.map((t) => {'type': 'function', 'function': t}).toList(),
      'tool_choice': 'auto',
      'temperature': 0.7,
      'max_tokens': 1024,
    };

    final response = await http.post(
      Uri.parse('$_baseUrl/chat/completions'),
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer $apiKey',
      },
      body: jsonEncode(body),
    );

    if (response.statusCode != 200) {
      throw Exception('DeepSeek API error: ${response.statusCode} ${response.body}');
    }

    final data = jsonDecode(response.body);
    final choice = data['choices'][0];
    final message = choice['message'];

    // Check if AI wants to call tools
    if (message['tool_calls'] != null) {
      final toolCalls = (message['tool_calls'] as List).map((tc) {
        return ToolCall(
          id: tc['id'],
          name: tc['function']['name'],
          arguments: jsonDecode(tc['function']['arguments']),
        );
      }).toList();

      return ChatResponse(
        content: message['content'] ?? '',
        toolCalls: toolCalls,
        finishReason: choice['finish_reason'],
      );
    }

    return ChatResponse(
      content: message['content'] ?? '',
      finishReason: choice['finish_reason'],
    );
  }

  /// Continue chat after tool execution
  Future<ChatResponse> continueWithToolResults(
    List<ChatMessage> messages,
    List<ToolCall> toolCalls,
    List<String> results,
  ) async {
    final allMessages = [
      ...messages.map((m) => _messageToJson(m)),
      // Assistant's tool call message
      {
        'role': 'assistant',
        'tool_calls': toolCalls.map((tc) {
              return {
                'id': tc.id,
                'type': 'function',
                'function': {
                  'name': tc.name,
                  'arguments': jsonEncode(tc.arguments),
                },
              };
            }).toList(),
      },
      // Tool results
      for (int i = 0; i < toolCalls.length; i++)
        {
          'role': 'tool',
          'tool_call_id': toolCalls[i].id,
          'content': results[i],
        },
    ];

    final body = {
      'model': AppConfig.deepseekModel,
      'messages': [
        {
          'role': 'system',
          'content': '你是 AgentX 的 AI 交易助手。根据工具调用结果，用简洁的中文回复用户。'
        },
        ...allMessages,
      ],
      'temperature': 0.7,
      'max_tokens': 1024,
    };

    final response = await http.post(
      Uri.parse('$_baseUrl/chat/completions'),
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer $apiKey',
      },
      body: jsonEncode(body),
    );

    if (response.statusCode != 200) {
      throw Exception('DeepSeek API error: ${response.statusCode}');
    }

    final data = jsonDecode(response.body);
    final content = data['choices'][0]['message']['content'] ?? '';

    return ChatResponse(content: content, finishReason: 'stop');
  }

  // Helpers

  static Map<String, dynamic> _tool(
    String name,
    String description,
    Map<String, dynamic> properties,
  ) {
    return {
      'name': name,
      'description': description,
      'parameters': {
        'type': 'object',
        'properties': properties,
        'required': properties.keys.toList(),
      },
    };
  }

  Map<String, dynamic> _messageToJson(ChatMessage msg) {
    return {
      'role': msg.role.name,
      'content': msg.content,
    };
  }
}

/// Response from DeepSeek
class ChatResponse {
  final String content;
  final List<ToolCall>? toolCalls;
  final String? finishReason;

  const ChatResponse({
    required this.content,
    this.toolCalls,
    this.finishReason,
  });

  bool get hasToolCalls => toolCalls != null && toolCalls!.isNotEmpty;
}
