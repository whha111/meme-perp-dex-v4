/**
 * 验证工具测试
 */

import {
  validateEthereumAddress,
  validateDomainName,
  validateAmount,
  validateWalletConnectProjectId,
  validateAndExtractWalletFromTXT,
  validateChainId,
  validateTradeParams,
  getValidationError,
} from '../validators';

describe('验证工具测试', () => {
  describe('validateEthereumAddress', () => {
    test('验证有效的以太坊地址', () => {
      expect(validateEthereumAddress('0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1')).toBe(true);
      expect(validateEthereumAddress('0x0000000000000000000000000000000000000000')).toBe(true);
    });

    test('验证无效的以太坊地址', () => {
      expect(validateEthereumAddress('')).toBe(false);
      expect(validateEthereumAddress('0x123')).toBe(false);
      expect(validateEthereumAddress('0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb')).toBe(false); // 41位
      expect(validateEthereumAddress('0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb12')).toBe(false); // 43位
      expect(validateEthereumAddress('742d35Cc6634C0532925a3b844Bc9e7595f0bEb1')).toBe(false); // 没有0x
      expect(validateEthereumAddress('0x742d35Cc6634C0532925a3b844Bc9e7595f0bEbG')).toBe(false); // 包含非十六进制字符
    });
  });

  describe('validateDomainName', () => {
    test('验证有效的域名', () => {
      expect(validateDomainName('example.com')).toBe(true);
      expect(validateDomainName('sub.example.com')).toBe(true);
      expect(validateDomainName('example.co.uk')).toBe(true);
      expect(validateDomainName('xn--example-6q4f.com')).toBe(true); // Punycode
    });

    test('验证无效的域名', () => {
      expect(validateDomainName('')).toBe(false);
      expect(validateDomainName('ex')).toBe(false); // 太短
      expect(validateDomainName('.com')).toBe(false); // 没有主域名
      expect(validateDomainName('example..com')).toBe(false); // 双点
      expect(validateDomainName('-example.com')).toBe(false); // 以横线开头
      expect(validateDomainName('example-.com')).toBe(false); // 以横线结尾
      expect(validateDomainName('example.com/')).toBe(false); // 包含斜杠
    });
  });

  describe('validateAmount', () => {
    test('验证有效的金额', () => {
      expect(validateAmount('0.1')).toBe(true);
      expect(validateAmount('1')).toBe(true);
      expect(validateAmount('1000.50')).toBe(true);
      expect(validateAmount('0', { allowZero: true })).toBe(true);
    });

    test('验证无效的金额', () => {
      expect(validateAmount('')).toBe(false);
      expect(validateAmount('abc')).toBe(false);
      expect(validateAmount('-1')).toBe(false);
      expect(validateAmount('0')).toBe(false); // 默认不允许0
      expect(validateAmount('0.001', { min: 0.01 })).toBe(false); // 小于最小值
      expect(validateAmount('1000', { max: 100 })).toBe(false); // 大于最大值
    });

    test('验证带选项的金额', () => {
      expect(validateAmount('0.5', { min: 0.1, max: 1 })).toBe(true);
      expect(validateAmount('0.05', { min: 0.1, max: 1 })).toBe(false);
      expect(validateAmount('2', { min: 0.1, max: 1 })).toBe(false);
    });
  });

  describe('validateWalletConnectProjectId', () => {
    test('验证有效的 Project ID', () => {
      expect(validateWalletConnectProjectId('12345678901234567890123456789012')).toBe(true);
      expect(validateWalletConnectProjectId('abcdef12345678901234567890123456')).toBe(true);
    });

    test('验证无效的 Project ID', () => {
      expect(validateWalletConnectProjectId('')).toBe(false);
      expect(validateWalletConnectProjectId('123')).toBe(false); // 太短
      expect(validateWalletConnectProjectId('123456789012345678901234567890123')).toBe(false); // 太长
      expect(validateWalletConnectProjectId('1234567890123456789012345678901g')).toBe(false); // 包含非十六进制字符
    });
  });

  describe('validateAndExtractWalletFromTXT', () => {
    test('提取有效的钱包地址', () => {
      const txt = 'domainfi-verify=0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1';
      const result = validateAndExtractWalletFromTXT(txt);
      expect(result).toBe('0x742d35cc6634c0532925a3b844bc9e7595f0beb1'); // 小写
    });

    test('处理无效的 TXT 记录', () => {
      expect(validateAndExtractWalletFromTXT('')).toBeNull();
      expect(validateAndExtractWalletFromTXT('invalid-prefix=0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1')).toBeNull();
      expect(validateAndExtractWalletFromTXT('domainfi-verify=0x123')).toBeNull();
    });

    test('使用自定义前缀', () => {
      const txt = 'custom-prefix=0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1';
      const result = validateAndExtractWalletFromTXT(txt, 'custom-prefix=');
      expect(result).toBe('0x742d35cc6634c0532925a3b844bc9e7595f0beb1');
    });
  });

  describe('validateChainId', () => {
    test('验证有效的链 ID', () => {
      expect(validateChainId(97)).toBe(true); // BSC Testnet
      expect(validateChainId(8453)).toBe(true); // Base Mainnet
      expect(validateChainId(1, [1, 137, 8453])).toBe(true); // 自定义允许的链
    });

    test('验证无效的链 ID', () => {
      expect(validateChainId(1)).toBe(false); // 不在默认列表中
      expect(validateChainId(97, [1, 137])).toBe(false); // 不在自定义列表中
    });
  });

  describe('validateTradeParams', () => {
    test('验证有效的交易参数', () => {
      const result = validateTradeParams({
        domainName: 'example.com',
        amount: '0.1',
        isBuy: true,
      });
      expect(result.isValid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    test('验证无效的交易参数', () => {
      const result1 = validateTradeParams({
        domainName: 'ex',
        amount: '0.1',
        isBuy: true,
      });
      expect(result1.isValid).toBe(false);
      expect(result1.errors).toContain('无效的域名格式');

      const result2 = validateTradeParams({
        domainName: 'example.com',
        amount: '0',
        isBuy: true,
      });
      expect(result2.isValid).toBe(false);
      expect(result2.errors).toContain('无效的交易金额');

      const result3 = validateTradeParams({
        domainName: 'ex',
        amount: '0',
        isBuy: true,
      });
      expect(result3.isValid).toBe(false);
      expect(result3.errors).toHaveLength(2);
    });
  });

  describe('getValidationError', () => {
    test('获取验证错误信息', () => {
      expect(getValidationError('address', '0x123', validateEthereumAddress)).toBe(
        '请输入有效的以太坊地址（0x开头，42位字符）'
      );
      expect(getValidationError('domain', 'ex', validateDomainName)).toBe(
        '请输入有效的域名格式（如：example.com）'
      );
      expect(getValidationError('amount', 'abc', (v) => validateAmount(v, { allowZero: false }))).toBe(
        '请输入有效的交易金额（大于0的数字）'
      );
      expect(getValidationError('projectId', '123', validateWalletConnectProjectId)).toBe(
        '请输入有效的 WalletConnect Project ID（32位字符）'
      );
      expect(getValidationError('custom', 'value', () => false)).toBe('无效的 custom 格式');
    });

    test('验证通过时返回 null', () => {
      expect(getValidationError('address', '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1', validateEthereumAddress)).toBeNull();
      expect(getValidationError('domain', 'example.com', validateDomainName)).toBeNull();
    });
  });
});