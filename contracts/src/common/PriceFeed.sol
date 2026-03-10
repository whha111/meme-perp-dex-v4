// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "../interfaces/IPriceFeed.sol";

/// @notice Uniswap V2 Pair 接口（用于毕业后价格读取）
interface IUniswapV2Pair {
    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);
    function token0() external view returns (address);
    function token1() external view returns (address);
}

/**
 * @title PriceFeed
 * @notice 价格合约 - 支持 Bonding Curve + Uniswap V2 双价格源
 * @dev 毕业前：TokenFactory 调用 updateTokenPriceFromFactory 更新价格
 *      毕业后：任何人可调用 updateTokenPriceFromUniswap 从 Uniswap V2 Pair 读取价格
 */
contract PriceFeed is Ownable, IPriceFeed {
    // ============================================================
    // Constants
    // ============================================================

    uint256 public constant PRICE_PRECISION = 1e18;

    // ============================================================
    // State Variables
    // ============================================================

    // TokenFactory 合约地址
    address public tokenFactory;

    // WETH 地址（用于 Uniswap V2 价格计算中确定 reserve 顺序）
    address public weth;

    // 多代币支持
    mapping(address => bool) public supportedTokens;
    mapping(address => uint256) public tokenLastPrice;
    mapping(address => uint256) public tokenLastUpdateTime;
    address[] public tokenList;

    // P0-2: Uniswap V2 Pair 地址（毕业后价格源）
    // token address => Uniswap V2 Pair address
    mapping(address => address) public tokenUniswapPair;

    // 价格过期时间（安全兜底：系统宕机超过此时间则拒绝返回过期价格）
    uint256 public maxPriceAge = 5 minutes;

    // ============================================================
    // Events
    // ============================================================

    event TokenPriceUpdated(address indexed token, uint256 price, uint256 timestamp);
    event TokenAdded(address indexed token);
    event TokenRemoved(address indexed token);
    event TokenFactorySet(address indexed tokenFactory);
    event WETHSet(address indexed weth);
    event UniswapPairSet(address indexed token, address indexed pair);

    // ============================================================
    // Errors
    // ============================================================

    error Unauthorized();
    error InvalidPrice();
    error ZeroAddress();
    error TokenNotSupported();
    error TokenAlreadySupported();
    error NoUniswapPair();
    error WETHNotSet();
    error PriceStale();

    // ============================================================
    // Modifiers
    // ============================================================

    modifier onlyTokenFactory() {
        if (msg.sender != tokenFactory) revert Unauthorized();
        _;
    }

    // ============================================================
    // Constructor
    // ============================================================

    constructor() Ownable(msg.sender) {}

    // ============================================================
    // Admin Functions
    // ============================================================

    /**
     * @notice 设置 TokenFactory 合约地址
     * @param _tokenFactory TokenFactory 地址
     */
    function setTokenFactory(address _tokenFactory) external onlyOwner {
        if (_tokenFactory == address(0)) revert ZeroAddress();
        tokenFactory = _tokenFactory;
        emit TokenFactorySet(_tokenFactory);
    }

    /**
     * @notice 设置价格最大过期时间
     * @param _maxPriceAge 最大过期时间（秒），0 表示禁用过期检查
     */
    function setMaxPriceAge(uint256 _maxPriceAge) external onlyOwner {
        maxPriceAge = _maxPriceAge;
    }

    /**
     * @notice 设置 WETH 地址（用于 Uniswap V2 价格计算）
     * @param _weth WETH 地址
     */
    function setWETH(address _weth) external onlyOwner {
        if (_weth == address(0)) revert ZeroAddress();
        weth = _weth;
        emit WETHSet(_weth);
    }

    /**
     * @notice 设置代币的 Uniswap V2 Pair 地址（毕业后价格源）
     * @dev 只有 owner 或 TokenFactory 可以调用
     * @param token 代币地址
     * @param pair Uniswap V2 Pair 地址
     */
    function setTokenUniswapPair(address token, address pair) external {
        if (msg.sender != owner() && msg.sender != tokenFactory) revert Unauthorized();
        if (token == address(0) || pair == address(0)) revert ZeroAddress();
        tokenUniswapPair[token] = pair;
        emit UniswapPairSet(token, pair);
    }

    /**
     * @notice 添加支持的代币
     * @param token 代币地址
     * @param initialPrice 初始价格
     */
    function addSupportedToken(address token, uint256 initialPrice) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        if (supportedTokens[token]) revert TokenAlreadySupported();
        if (initialPrice == 0) revert InvalidPrice();

        supportedTokens[token] = true;
        tokenList.push(token);
        tokenLastPrice[token] = initialPrice;
        tokenLastUpdateTime[token] = block.timestamp;

        emit TokenAdded(token);
        emit TokenPriceUpdated(token, initialPrice, block.timestamp);
    }

    /**
     * @notice TokenFactory 自动添加代币支持
     * @param token 代币地址
     * @param initialPrice 初始价格
     */
    function addSupportedTokenFromFactory(address token, uint256 initialPrice) external onlyTokenFactory {
        if (token == address(0)) revert ZeroAddress();
        if (supportedTokens[token]) return; // 已支持则跳过
        if (initialPrice == 0) revert InvalidPrice();

        supportedTokens[token] = true;
        tokenList.push(token);
        tokenLastPrice[token] = initialPrice;
        tokenLastUpdateTime[token] = block.timestamp;

        emit TokenAdded(token);
        emit TokenPriceUpdated(token, initialPrice, block.timestamp);
    }

    /**
     * @notice 移除支持的代币
     * @param token 代币地址
     */
    function removeSupportedToken(address token) external onlyOwner {
        if (!supportedTokens[token]) revert TokenNotSupported();

        supportedTokens[token] = false;

        // 从列表中移除
        for (uint256 i = 0; i < tokenList.length; i++) {
            if (tokenList[i] == token) {
                tokenList[i] = tokenList[tokenList.length - 1];
                tokenList.pop();
                break;
            }
        }

        emit TokenRemoved(token);
    }

    // ============================================================
    // Price Update Functions
    // ============================================================

    /**
     * @notice 由 TokenFactory 在每次交易后调用更新价格
     * @param token 代币地址
     * @param newPrice 新价格
     */
    function updateTokenPriceFromFactory(address token, uint256 newPrice) external onlyTokenFactory {
        // 如果代币未支持，静默跳过
        if (!supportedTokens[token]) return;
        if (newPrice == 0) return;

        tokenLastPrice[token] = newPrice;
        tokenLastUpdateTime[token] = block.timestamp;

        emit TokenPriceUpdated(token, newPrice, block.timestamp);
    }

    /**
     * @notice P0-2: 从 Uniswap V2 Pair 读取价格（毕业后价格源）
     * @dev 无权限限制 — 任何人/Keeper 可调用刷新价格
     *      价格计算: ETH_reserve / Token_reserve * 1e18 (ETH per Token, 18位精度)
     * @param token 代币地址
     */
    function updateTokenPriceFromUniswap(address token) external {
        if (!supportedTokens[token]) revert TokenNotSupported();
        if (weth == address(0)) revert WETHNotSet();

        address pair = tokenUniswapPair[token];
        if (pair == address(0)) revert NoUniswapPair();

        (uint112 reserve0, uint112 reserve1, ) = IUniswapV2Pair(pair).getReserves();
        if (reserve0 == 0 || reserve1 == 0) revert InvalidPrice();

        // Uniswap V2 中 token0 < token1（按地址字典序排列）
        // 需要根据 WETH 和 token 的地址顺序确定 reserve 含义
        uint256 price;
        if (weth < token) {
            // WETH 是 token0: reserve0 = WETH, reserve1 = MemeToken
            // price(ETH/Token) = reserve0 / reserve1, 扩展到 1e18
            price = (uint256(reserve0) * PRICE_PRECISION) / uint256(reserve1);
        } else {
            // WETH 是 token1: reserve0 = MemeToken, reserve1 = WETH
            // price(ETH/Token) = reserve1 / reserve0, 扩展到 1e18
            price = (uint256(reserve1) * PRICE_PRECISION) / uint256(reserve0);
        }

        if (price == 0) revert InvalidPrice();

        tokenLastPrice[token] = price;
        tokenLastUpdateTime[token] = block.timestamp;

        emit TokenPriceUpdated(token, price, block.timestamp);
    }

    // ============================================================
    // View Functions
    // ============================================================

    /**
     * @notice 检查代币是否支持
     */
    function isTokenSupported(address token) external view returns (bool) {
        return supportedTokens[token];
    }

    /**
     * @notice 获取代币现货价格
     */
    function getTokenSpotPrice(address token) external view returns (uint256) {
        if (!supportedTokens[token]) revert TokenNotSupported();
        return tokenLastPrice[token];
    }

    /**
     * @notice 获取代币标记价格（直接返回现货价格，100%硬锚）
     * @dev 内盘合约不做任何价格偏离，直接使用Bonding Curve价格
     *      新增过期检查：如果价格超过 maxPriceAge 未更新则 revert
     */
    function getTokenMarkPrice(address token) external view returns (uint256) {
        if (!supportedTokens[token]) revert TokenNotSupported();
        if (tokenLastUpdateTime[token] > 0 && block.timestamp - tokenLastUpdateTime[token] > maxPriceAge) {
            revert PriceStale();
        }
        return tokenLastPrice[token];
    }

    /**
     * @notice 获取代币最后更新时间
     */
    function getTokenLastUpdateTime(address token) external view returns (uint256) {
        if (!supportedTokens[token]) revert TokenNotSupported();
        return tokenLastUpdateTime[token];
    }

    /**
     * @notice 获取所有支持的代币列表
     */
    function getSupportedTokens() external view returns (address[] memory) {
        return tokenList;
    }

    /**
     * @notice 获取支持的代币数量
     */
    function getSupportedTokenCount() external view returns (uint256) {
        return tokenList.length;
    }

    // ============================================================
    // Legacy Interface Compatibility (为了兼容旧代码)
    // ============================================================

    /**
     * @notice 获取标记价格（Legacy接口，返回第一个代币的价格）
     * @dev AUDIT-FIX SC-H05: 添加过期检查，与 getTokenMarkPrice 一致
     */
    function getMarkPrice() external view returns (uint256) {
        if (tokenList.length == 0) return 0;
        address token = tokenList[0];
        if (maxPriceAge > 0 && tokenLastUpdateTime[token] > 0 && block.timestamp - tokenLastUpdateTime[token] > maxPriceAge) {
            revert PriceStale();
        }
        return tokenLastPrice[token];
    }

    /**
     * @notice 获取现货价格（Legacy接口，返回第一个代币的价格）
     * @dev AUDIT-FIX SC-H05: 添加过期检查
     */
    function getSpotPrice() external view returns (uint256) {
        if (tokenList.length == 0) return 0;
        address token = tokenList[0];
        if (maxPriceAge > 0 && tokenLastUpdateTime[token] > 0 && block.timestamp - tokenLastUpdateTime[token] > maxPriceAge) {
            revert PriceStale();
        }
        return tokenLastPrice[token];
    }

    /**
     * @notice 获取最后更新时间（Legacy接口）
     * @dev 向后兼容：返回 tokenList[0] 的最后更新时间
     */
    function getLastUpdateTime() external view returns (uint256) {
        if (tokenList.length == 0) return 0;
        return tokenLastUpdateTime[tokenList[0]];
    }

    /**
     * @notice 更新价格（Legacy接口，no-op，保持AMM兼容性）
     * @dev 价格更新现在只通过 updateTokenPriceFromFactory 进行
     */
    function updatePrice(uint256) external {
        // No-op: 旧接口保持兼容，但不做任何操作
    }

    /**
     * @notice 更新代币价格（Legacy接口，no-op）
     */
    function updateTokenPrice(address, uint256) external {
        // No-op: 旧接口保持兼容，但不做任何操作
    }
}
