import 'package:flutter/foundation.dart';
import 'package:web3dart/web3dart.dart';
import 'package:http/http.dart' as http;
import '../../core/config/app_config.dart';

/// TokenFactory contract service — create meme tokens on BSC
class TokenFactoryService {
  static final _contractAddress =
      EthereumAddress.fromHex(AppConfig.tokenFactory);

  static final _abi = ContractAbi.fromJson('''[
    {
      "inputs": [
        {"internalType": "string", "name": "name", "type": "string"},
        {"internalType": "string", "name": "symbol", "type": "string"},
        {"internalType": "string", "name": "metadataURI", "type": "string"},
        {"internalType": "uint256", "name": "minTokensOut", "type": "uint256"}
      ],
      "name": "createToken",
      "outputs": [{"internalType": "address", "name": "", "type": "address"}],
      "stateMutability": "payable",
      "type": "function"
    },
    {
      "inputs": [{"internalType": "address", "name": "token", "type": "address"}],
      "name": "buy",
      "outputs": [],
      "stateMutability": "payable",
      "type": "function"
    },
    {
      "inputs": [
        {"internalType": "address", "name": "token", "type": "address"},
        {"internalType": "uint256", "name": "tokenAmount", "type": "uint256"},
        {"internalType": "uint256", "name": "minETHOut", "type": "uint256"}
      ],
      "name": "sell",
      "outputs": [],
      "stateMutability": "nonpayable",
      "type": "function"
    },
    {
      "inputs": [],
      "name": "serviceFee",
      "outputs": [{"internalType": "uint256", "name": "", "type": "uint256"}],
      "stateMutability": "view",
      "type": "function"
    },
    {
      "inputs": [{"internalType": "address", "name": "token", "type": "address"}],
      "name": "getCurrentPrice",
      "outputs": [{"internalType": "uint256", "name": "", "type": "uint256"}],
      "stateMutability": "view",
      "type": "function"
    },
    {
      "inputs": [
        {"internalType": "address", "name": "token", "type": "address"},
        {"internalType": "uint256", "name": "ethIn", "type": "uint256"}
      ],
      "name": "previewBuy",
      "outputs": [{"internalType": "uint256", "name": "", "type": "uint256"}],
      "stateMutability": "view",
      "type": "function"
    }
  ]''', 'TokenFactory');

  late final Web3Client _web3;
  late final DeployedContract _contract;

  TokenFactoryService() {
    _web3 = Web3Client(AppConfig.rpcUrl, http.Client());
    _contract = DeployedContract(_abi, _contractAddress);
  }

  /// Get service fee for creating a token
  Future<BigInt> getServiceFee() async {
    final result = await _web3.call(
      contract: _contract,
      function: _contract.function('serviceFee'),
      params: [],
    );
    return result.first as BigInt;
  }

  /// Create a new meme token on-chain
  /// Returns the transaction hash
  Future<String> createToken({
    required EthPrivateKey credentials,
    required String name,
    required String symbol,
    required String metadataURI,
    BigInt? initialBuyEth,
  }) async {
    final serviceFee = await getServiceFee();
    final value = serviceFee + (initialBuyEth ?? BigInt.zero);

    final txHash = await _web3.sendTransaction(
      credentials,
      Transaction.callContract(
        contract: _contract,
        function: _contract.function('createToken'),
        parameters: [name, symbol, metadataURI, BigInt.zero],
        value: EtherAmount.inWei(value),
        maxGas: 3000000,
      ),
      chainId: AppConfig.chainId,
    );

    debugPrint('TokenFactory.createToken tx: $txHash');
    return txHash;
  }

  /// Buy tokens with BNB
  Future<String> buy({
    required EthPrivateKey credentials,
    required EthereumAddress tokenAddress,
    required BigInt ethAmount,
  }) async {
    final txHash = await _web3.sendTransaction(
      credentials,
      Transaction.callContract(
        contract: _contract,
        function: _contract.function('buy'),
        parameters: [tokenAddress],
        value: EtherAmount.inWei(ethAmount),
        maxGas: 500000,
      ),
      chainId: AppConfig.chainId,
    );
    return txHash;
  }

  /// Sell tokens for BNB
  Future<String> sell({
    required EthPrivateKey credentials,
    required EthereumAddress tokenAddress,
    required BigInt tokenAmount,
  }) async {
    final txHash = await _web3.sendTransaction(
      credentials,
      Transaction.callContract(
        contract: _contract,
        function: _contract.function('sell'),
        parameters: [tokenAddress, tokenAmount, BigInt.zero],
        maxGas: 500000,
      ),
      chainId: AppConfig.chainId,
    );
    return txHash;
  }

  /// Get current price of a token
  Future<BigInt> getCurrentPrice(EthereumAddress tokenAddress) async {
    final result = await _web3.call(
      contract: _contract,
      function: _contract.function('getCurrentPrice'),
      params: [tokenAddress],
    );
    return result.first as BigInt;
  }

  /// Preview how many tokens you get for ethIn
  Future<BigInt> previewBuy(EthereumAddress tokenAddress, BigInt ethIn) async {
    final result = await _web3.call(
      contract: _contract,
      function: _contract.function('previewBuy'),
      params: [tokenAddress, ethIn],
    );
    return result.first as BigInt;
  }
}
