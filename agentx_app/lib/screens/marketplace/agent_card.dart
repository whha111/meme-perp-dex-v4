import 'package:flutter/material.dart';
import '../../core/theme/app_theme.dart';
import '../../models/agent.dart';

/// Glass-style agent card for the marketplace grid
class AgentCard extends StatelessWidget {
  final Agent agent;
  final VoidCallback onTap;

  const AgentCard({super.key, required this.agent, required this.onTap});

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        decoration: BoxDecoration(
          color: const Color(0x08FFFFFF),
          borderRadius: BorderRadius.circular(20),
          border: Border.all(color: const Color(0x0AFFFFFF)),
        ),
        child: Padding(
          padding: const EdgeInsets.all(14),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              // Avatar + Price badge
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  // Emoji avatar
                  Container(
                    width: 48,
                    height: 48,
                    decoration: BoxDecoration(
                      color: AppTheme.purpleStart.withValues(alpha: 0.15),
                      borderRadius: BorderRadius.circular(16),
                    ),
                    child: Center(
                      child: Text(
                        agent.emoji,
                        style: const TextStyle(fontSize: 24),
                      ),
                    ),
                  ),
                  // Price change badge
                  Container(
                    padding:
                        const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                    decoration: BoxDecoration(
                      color: (agent.isPositive ? AppTheme.green : AppTheme.red)
                          .withValues(alpha: 0.15),
                      borderRadius: BorderRadius.circular(8),
                    ),
                    child: Text(
                      agent.changeFormatted,
                      style: TextStyle(
                        fontSize: 11,
                        fontWeight: FontWeight.w600,
                        color: agent.isPositive ? AppTheme.green : AppTheme.red,
                      ),
                    ),
                  ),
                ],
              ),

              const SizedBox(height: 12),

              // Name
              Text(
                agent.name,
                style: const TextStyle(
                  fontSize: 15,
                  fontWeight: FontWeight.w700,
                  color: AppTheme.textPrimary,
                ),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),

              const SizedBox(height: 2),

              // Description
              Text(
                agent.description,
                style: const TextStyle(
                  fontSize: 11,
                  color: AppTheme.textMuted,
                ),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),

              const Spacer(),

              // Price
              Text(
                agent.priceFormatted,
                style: const TextStyle(
                  fontSize: 18,
                  fontWeight: FontWeight.w800,
                  color: AppTheme.textPrimary,
                  letterSpacing: -0.5,
                ),
              ),

              const SizedBox(height: 6),

              // Stats row
              Row(
                children: [
                  Icon(Icons.people_outline,
                      size: 12, color: AppTheme.textDim),
                  const SizedBox(width: 3),
                  Text(
                    agent.holdersFormatted,
                    style: const TextStyle(
                        fontSize: 11, color: AppTheme.textDim),
                  ),
                  const SizedBox(width: 10),
                  Icon(Icons.chat_bubble_outline,
                      size: 12, color: AppTheme.textDim),
                  const SizedBox(width: 3),
                  Text(
                    agent.chatsFormatted,
                    style: const TextStyle(
                        fontSize: 11, color: AppTheme.textDim),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}
