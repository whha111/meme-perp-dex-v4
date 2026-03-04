import {
  ENV_CONFIG,
  TIMEOUT_CONFIG,
  THRESHOLD_CONFIG,
  CALCULATION_CONFIG,
  getDeadlineTimestamp,
  calculateMinAmountWithSlippage,
  calculateMinAmountWithPercentSlippage,
  validateBusinessConfig,
} from '../business';

describe('业务配置测试', () => {
  test('环境配置读取', () => {
    expect(ENV_CONFIG.TARGET_CHAIN_ID).toBe(97);
    expect(ENV_CONFIG.DEFAULT_BUY_AMOUNT).toBe('0.01');
    expect(ENV_CONFIG.DEFAULT_SERVICE_FEE).toBe('0.001');
    expect(ENV_CONFIG.ERROR_THRESHOLD).toBe(0.1);
  });

  test('超时配置验证', () => {
    expect(TIMEOUT_CONFIG.DNS_MAX_ATTEMPTS).toBe(60);
    expect(TIMEOUT_CONFIG.DNS_WARNING_THRESHOLD).toBe(30);
    expect(TIMEOUT_CONFIG.TRANSACTION_DEADLINE_MINUTES).toBe(20);
    expect(TIMEOUT_CONFIG.TRANSACTION_MAX_ATTEMPTS).toBe(60);
    expect(TIMEOUT_CONFIG.STREAM_RECONNECT_ATTEMPTS).toBe(30);
  });

  test('阈值配置验证', () => {
    expect(THRESHOLD_CONFIG.GRADUATION_THRESHOLD_ETH).toBe('2');
    expect(THRESHOLD_CONFIG.BUY_PER_TRANSACTION_ETH).toBe('0.1');
    expect(THRESHOLD_CONFIG.DEFAULT_SLIPPAGE_PERCENT).toBe(5);
    expect(THRESHOLD_CONFIG.DEFAULT_SLIPPAGE_BPS).toBe(500);
    expect(THRESHOLD_CONFIG.SLIPPAGE_FOR_FRONTEND_CALC).toBe(100);
  });

  test('计算配置验证', () => {
    expect(CALCULATION_CONFIG.ETH_DECIMALS).toBe(18);
    expect(CALCULATION_CONFIG.PERCENTAGE_DECIMALS).toBe(2);
    expect(CALCULATION_CONFIG.ONE_HUNDRED_PERCENT).toBe(10000n);
    expect(CALCULATION_CONFIG.NINETY_NINE_PERCENT).toBe(9900n);
    expect(CALCULATION_CONFIG.NINETY_FIVE_PERCENT).toBe(9500n);
  });

  test('截止时间戳计算', () => {
    const deadline = getDeadlineTimestamp(20);
    const now = BigInt(Math.floor(Date.now() / 1000));
    const twentyMinutes = 20 * 60;
    
    // 截止时间应该在当前时间 + 20分钟 ± 5秒范围内
    expect(Number(deadline)).toBeGreaterThan(Number(now) + twentyMinutes - 5);
    expect(Number(deadline)).toBeLessThan(Number(now) + twentyMinutes + 5);
  });

  test('滑点计算 - 基点', () => {
    const amount = 10000n;
    
    // 1% 滑点
    const result1 = calculateMinAmountWithSlippage(amount, 100);
    expect(result1).toBe(9900n); // 10000 * 0.99 = 9900
    
    // 5% 滑点
    const result2 = calculateMinAmountWithSlippage(amount, 500);
    expect(result2).toBe(9500n); // 10000 * 0.95 = 9500
    
    // 0% 滑点
    const result3 = calculateMinAmountWithSlippage(amount, 0);
    expect(result3).toBe(10000n); // 10000 * 1.00 = 10000
  });

  test('滑点计算 - 百分比', () => {
    const amount = 10000n;
    
    // 1% 滑点
    const result1 = calculateMinAmountWithPercentSlippage(amount, 1);
    expect(result1).toBe(9900n);
    
    // 5% 滑点（默认）
    const result2 = calculateMinAmountWithPercentSlippage(amount);
    expect(result2).toBe(9500n);
    
    // 10% 滑点
    const result3 = calculateMinAmountWithPercentSlippage(amount, 10);
    expect(result3).toBe(9000n);
  });

  test('滑点计算错误处理', () => {
    const amount = 10000n;
    
    // 无效滑点（负数）
    expect(() => calculateMinAmountWithSlippage(amount, -100)).toThrow('滑点必须在 0-10000 基点之间');
    
    // 无效滑点（超过100%）
    expect(() => calculateMinAmountWithSlippage(amount, 10100)).toThrow('滑点必须在 0-10000 基点之间');
    
    // 无效百分比滑点
    expect(() => calculateMinAmountWithPercentSlippage(amount, -5)).toThrow('滑点必须在 0-100% 之间');
    expect(() => calculateMinAmountWithPercentSlippage(amount, 105)).toThrow('滑点必须在 0-100% 之间');
  });

  test('配置验证', () => {
    const errors = validateBusinessConfig();
    expect(errors).toEqual([]); // 默认配置应该没有错误
  });

  test('配置值类型检查', () => {
    // 检查所有配置值都是预期的类型
    expect(typeof TIMEOUT_CONFIG.DNS_MAX_ATTEMPTS).toBe('number');
    expect(typeof THRESHOLD_CONFIG.GRADUATION_THRESHOLD).toBe('bigint');
    expect(typeof THRESHOLD_CONFIG.DEFAULT_SLIPPAGE_PERCENT).toBe('number');
    expect(typeof CALCULATION_CONFIG.ONE_HUNDRED_PERCENT).toBe('bigint');
  });
});