import 'package:flutter/foundation.dart';
import '../models/agent.dart';

/// Tracks which agents the user has chatted with recently.
/// In production this would persist to local storage.
class ChatHistory extends ChangeNotifier {
  final List<_ChatEntry> _entries = [];

  /// Recent chat entries, newest first
  List<({Agent agent, String lastMessage, DateTime time})> get recentChats {
    final sorted = List.of(_entries)..sort((a, b) => b.time.compareTo(a.time));
    return sorted
        .map((e) => (agent: e.agent, lastMessage: e.lastMessage, time: e.time))
        .toList();
  }

  bool get isEmpty => _entries.isEmpty;

  /// Record that user sent/received a message with this agent
  void recordChat(Agent agent, String lastMessage) {
    // Update existing or add new
    final existing = _entries.indexWhere((e) => e.agent.id == agent.id);
    if (existing >= 0) {
      _entries[existing] = _ChatEntry(agent, lastMessage, DateTime.now());
    } else {
      _entries.add(_ChatEntry(agent, lastMessage, DateTime.now()));
    }
    notifyListeners();
  }
}

class _ChatEntry {
  final Agent agent;
  final String lastMessage;
  final DateTime time;
  _ChatEntry(this.agent, this.lastMessage, this.time);
}
