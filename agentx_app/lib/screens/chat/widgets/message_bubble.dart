import 'package:flutter/material.dart';
import '../../../core/theme/app_theme.dart';
import '../../../models/chat_message.dart';

/// Chat message bubble — user messages right-aligned, AI messages left-aligned
class MessageBubble extends StatelessWidget {
  final ChatMessage message;
  final String agentEmoji;

  const MessageBubble({
    super.key,
    required this.message,
    required this.agentEmoji,
  });

  @override
  Widget build(BuildContext context) {
    final isUser = message.isUser;

    return Row(
      mainAxisAlignment: isUser ? MainAxisAlignment.end : MainAxisAlignment.start,
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (!isUser) ...[
          // Agent avatar
          Container(
            width: 32,
            height: 32,
            decoration: BoxDecoration(
              color: AppTheme.purpleStart.withValues(alpha: 0.15),
              borderRadius: BorderRadius.circular(10),
            ),
            child: Center(
              child: Text(agentEmoji, style: const TextStyle(fontSize: 16)),
            ),
          ),
          const SizedBox(width: 8),
        ],

        // Bubble
        Flexible(
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
            decoration: BoxDecoration(
              color: isUser
                  ? AppTheme.purpleStart.withValues(alpha: 0.2)
                  : AppTheme.glass,
              borderRadius: BorderRadius.only(
                topLeft: const Radius.circular(18),
                topRight: const Radius.circular(18),
                bottomLeft: Radius.circular(isUser ? 18 : 4),
                bottomRight: Radius.circular(isUser ? 4 : 18),
              ),
              border: Border.all(
                color: isUser
                    ? AppTheme.purpleStart.withValues(alpha: 0.3)
                    : AppTheme.glassBorder,
              ),
            ),
            child: Text(
              message.content,
              style: TextStyle(
                fontSize: 14,
                color: isUser ? AppTheme.textPrimary : AppTheme.textSecondary,
                height: 1.5,
              ),
            ),
          ),
        ),

        if (isUser) const SizedBox(width: 40),
        if (!isUser) const SizedBox(width: 40),
      ],
    );
  }
}
