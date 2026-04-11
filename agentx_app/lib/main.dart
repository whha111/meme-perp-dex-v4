import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';

import 'core/theme/app_theme.dart';
import 'providers/wallet_provider.dart';
import 'providers/chat_provider.dart';
import 'providers/agent_store.dart';
import 'providers/chat_history.dart';
import 'services/api/dexi_api.dart';
import 'services/chat_fee_service.dart';
import 'screens/app_shell.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();

  SystemChrome.setSystemUIOverlayStyle(const SystemUiOverlayStyle(
    statusBarColor: Colors.transparent,
    statusBarBrightness: Brightness.dark,
    statusBarIconBrightness: Brightness.light,
  ));

  runApp(const AgentXApp());
}

class AgentXApp extends StatelessWidget {
  const AgentXApp({super.key});

  @override
  Widget build(BuildContext context) {
    final dexiApi = DexiApi();
    final feeService = ChatFeeService();

    return MultiProvider(
      providers: [
        ChangeNotifierProvider(
          create: (_) => WalletProvider()..tryAutoConnect(),
        ),
        ChangeNotifierProvider(create: (_) => AgentStore()),
        ChangeNotifierProvider(create: (_) => ChatHistory()),
        ChangeNotifierProvider.value(value: feeService),
        ChangeNotifierProvider(
          create: (_) => ChatProvider(
            apiKey: const String.fromEnvironment('DEEPSEEK_API_KEY',
                defaultValue: 'sk-e5053a02a13d42d481673b4e02cb9eba'),
            dexiApi: dexiApi,
            feeService: feeService,
          ),
        ),
      ],
      child: MaterialApp(
        title: 'AgentX',
        debugShowCheckedModeBanner: false,
        theme: AppTheme.darkTheme,
        home: const AppShell(),
      ),
    );
  }
}
