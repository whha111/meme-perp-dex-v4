/// Chat message model
class ChatMessage {
  final String id;
  final String content;
  final MessageRole role;
  final DateTime timestamp;
  final List<ToolCall>? toolCalls;
  final String? toolResult;
  final bool isLoading;

  const ChatMessage({
    required this.id,
    required this.content,
    required this.role,
    required this.timestamp,
    this.toolCalls,
    this.toolResult,
    this.isLoading = false,
  });

  bool get isUser => role == MessageRole.user;
  bool get isAssistant => role == MessageRole.assistant;
  bool get isTool => role == MessageRole.tool;
}

enum MessageRole { user, assistant, tool, system }

/// Function calling tool call
class ToolCall {
  final String id;
  final String name;
  final Map<String, dynamic> arguments;
  final String? result;

  const ToolCall({
    required this.id,
    required this.name,
    required this.arguments,
    this.result,
  });
}
