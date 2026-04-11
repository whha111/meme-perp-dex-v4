/// AgentX App Configuration
class AppConfig {
  // DEXI Matching Engine (VPS: dexi.fun / 23.27.201.207)
  static const String dexiApiUrl = 'https://dexi.fun';
  static const String dexiWsUrl = 'wss://dexi.fun/ws';

  // BNB Chain
  static const int chainId = 97; // BSC Testnet
  static const String rpcUrl = 'https://bsc-testnet-rpc.publicnode.com';

  // Contracts
  static const String settlementV2 = '0xF83D5d2E437D0e27144900cb768d2B5933EF3d6b';
  static const String tokenFactory = '0xB40541Ff9f24883149fc6F9CD1021dB9C7BCcB83';
  static const String perpVault = '0xF0db95eD967318BC7757A671399f0D4FFC853e05';
  static const String wbnb = '0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd';

  // DeepSeek AI
  static const String deepseekApiUrl = 'https://api.deepseek.com/v1';
  static const String deepseekModel = 'deepseek-chat';

  // Precision
  static const int pricePrecision = 18; // 1e18
  static const int leveragePrecision = 4; // 1e4

  // Chat Fee Model (A+D)
  // Users must hold the agent's token to chat; each message costs a micro fee
  static const double chatFeePerMessage = 0.001;  // USDT equivalent per message
  static const double creatorFeeShare = 0.70;      // 70% to creator
  static const double platformFeeShare = 0.30;      // 30% to platform (covers API cost)
  static const double minHoldingToChat = 1.0;       // Must hold >= 1 token to chat
  static const double tradingFeeTaker = 0.0005;     // 0.05% taker fee (from DEXI)
  static const double tradingFeeMaker = 0.0003;     // 0.03% maker fee (from DEXI)
}
