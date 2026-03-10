/**
 * 应用状态管理测试
 */

import { renderHook, act } from '@testing-library/react';
import { useAppStore, appStoreUtils, DEFAULT_PREFERENCES } from '../appStore';

// 清理 localStorage
beforeEach(() => {
  localStorage.clear();
  appStoreUtils.resetToDefaults();
});

describe('应用状态管理', () => {
  describe('偏好设置', () => {
    test('默认偏好设置', () => {
      const { result } = renderHook(() => useAppStore());
      expect(result.current.preferences).toEqual(DEFAULT_PREFERENCES);
    });

    test('更新主题', () => {
      const { result } = renderHook(() => useAppStore());

      act(() => {
        result.current.setTheme('light');
      });

      expect(result.current.preferences.theme).toBe('light');
    });

    test('更新滑点容忍度', () => {
      const { result } = renderHook(() => useAppStore());

      act(() => {
        result.current.setSlippageTolerance(1.0);
      });

      expect(result.current.preferences.slippageTolerance).toBe(1.0);
    });

    test('更新交易截止时间', () => {
      const { result } = renderHook(() => useAppStore());

      act(() => {
        result.current.setTransactionDeadline(30);
      });

      expect(result.current.preferences.transactionDeadline).toBe(30);
    });

    test('切换高级设置', () => {
      const { result } = renderHook(() => useAppStore());
      const initialValue = result.current.preferences.showAdvancedSettings;

      act(() => {
        result.current.toggleAdvancedSettings();
      });

      expect(result.current.preferences.showAdvancedSettings).toBe(!initialValue);

      act(() => {
        result.current.toggleAdvancedSettings();
      });

      expect(result.current.preferences.showAdvancedSettings).toBe(initialValue);
    });

    test('切换自动连接钱包', () => {
      const { result } = renderHook(() => useAppStore());
      const initialValue = result.current.preferences.autoConnectWallet;

      act(() => {
        result.current.toggleAutoConnectWallet();
      });

      expect(result.current.preferences.autoConnectWallet).toBe(!initialValue);
    });
  });

  describe('交易管理', () => {
    test('添加交易', () => {
      const { result } = renderHook(() => useAppStore());

      act(() => {
        result.current.addTransaction({
          hash: '0x123',
          status: 'pending',
          type: 'buy',
          instId: 'MEME-BNB',
          amount: '0.1',
        });
      });

      expect(result.current.transactions).toHaveLength(1);
      expect(result.current.transactions[0]).toMatchObject({
        hash: '0x123',
        status: 'pending',
        type: 'buy',
        instId: 'MEME-BNB',
        amount: '0.1',
      });
      expect(result.current.transactions[0].timestamp).toBeGreaterThan(0);
    });

    test('更新交易状态', () => {
      const { result } = renderHook(() => useAppStore());

      // 先添加交易
      act(() => {
        result.current.addTransaction({
          hash: '0x123',
          status: 'pending',
          type: 'buy',
          instId: 'MEME-BNB',
        });
      });

      // 更新状态
      act(() => {
        result.current.updateTransactionStatus('0x123', 'confirmed');
      });

      expect(result.current.transactions[0].status).toBe('confirmed');
    });

    test('清理交易', () => {
      const { result } = renderHook(() => useAppStore());

      // 添加一些交易
      act(() => {
        result.current.addTransaction({
          hash: '0x123',
          status: 'pending',
          type: 'buy',
          instId: 'MEME-BNB',
        });
        result.current.addTransaction({
          hash: '0x456',
          status: 'confirmed',
          type: 'sell',
          instId: 'DOGE-BNB',
        });
      });

      expect(result.current.transactions).toHaveLength(2);

      // 清理交易
      act(() => {
        result.current.clearTransactions();
      });

      expect(result.current.transactions).toHaveLength(0);
    });

    test('交易数量限制', () => {
      const { result } = renderHook(() => useAppStore());

      // 添加超过限制的交易
      for (let i = 0; i < 60; i++) {
        act(() => {
          result.current.addTransaction({
            hash: `0x${i}`,
            status: 'pending',
            type: 'buy',
            instId: 'MEME-BNB',
          });
        });
      }

      // 应该只保留最多50条
      expect(result.current.transactions).toHaveLength(50);
      // 最新的交易应该在前面
      expect(result.current.transactions[0].hash).toBe('0x59');
    });
  });

  describe('交易对管理', () => {
    test('添加最近访问的交易对', () => {
      const { result } = renderHook(() => useAppStore());

      act(() => {
        result.current.addRecentInstrument('MEME-BNB');
        result.current.addRecentInstrument('DOGE-BNB');
      });

      expect(result.current.recentInstruments).toEqual(['DOGE-BNB', 'MEME-BNB']);
    });

    test('最近交易对去重', () => {
      const { result } = renderHook(() => useAppStore());

      act(() => {
        result.current.addRecentInstrument('MEME-BNB');
        result.current.addRecentInstrument('DOGE-BNB');
        result.current.addRecentInstrument('MEME-BNB'); // 重复
      });

      expect(result.current.recentInstruments).toEqual(['MEME-BNB', 'DOGE-BNB']);
    });

    test('最近交易对数量限制', () => {
      const { result } = renderHook(() => useAppStore());

      // 添加超过限制的交易对
      for (let i = 0; i < 15; i++) {
        act(() => {
          result.current.addRecentInstrument(`TOKEN${i}-BNB`);
        });
      }

      expect(result.current.recentInstruments).toHaveLength(10);
    });

    test('切换收藏交易对', () => {
      const { result } = renderHook(() => useAppStore());

      // 添加收藏
      act(() => {
        result.current.toggleFavoriteInstrument('MEME-BNB');
      });

      expect(result.current.favoriteInstruments.has('MEME-BNB')).toBe(true);

      // 移除收藏
      act(() => {
        result.current.toggleFavoriteInstrument('MEME-BNB');
      });

      expect(result.current.favoriteInstruments.has('MEME-BNB')).toBe(false);
    });

    test('交易对大小写统一', () => {
      const { result } = renderHook(() => useAppStore());

      act(() => {
        result.current.toggleFavoriteInstrument('meme-bnb');
        result.current.addRecentInstrument('doge-bnb');
      });

      // 统一转为大写
      expect(result.current.favoriteInstruments.has('MEME-BNB')).toBe(true);
      expect(result.current.recentInstruments[0]).toBe('DOGE-BNB');
    });
  });

  describe('UI 状态', () => {
    test('切换侧边栏', () => {
      const { result } = renderHook(() => useAppStore());
      const initialValue = result.current.sidebarCollapsed;

      act(() => {
        result.current.toggleSidebar();
      });

      expect(result.current.sidebarCollapsed).toBe(!initialValue);
    });

    test('切换移动菜单', () => {
      const { result } = renderHook(() => useAppStore());
      const initialValue = result.current.mobileMenuOpen;

      act(() => {
        result.current.toggleMobileMenu();
      });

      expect(result.current.mobileMenuOpen).toBe(!initialValue);
    });

    test('关闭移动菜单', () => {
      const { result } = renderHook(() => useAppStore());

      // 先打开菜单
      act(() => {
        result.current.toggleMobileMenu();
      });

      expect(result.current.mobileMenuOpen).toBe(true);

      // 关闭菜单
      act(() => {
        result.current.closeMobileMenu();
      });

      expect(result.current.mobileMenuOpen).toBe(false);
    });
  });

  describe('持久化', () => {
    test('状态持久化到 localStorage', () => {
      const { result } = renderHook(() => useAppStore());

      // 修改一些状态
      act(() => {
        result.current.setTheme('light');
        result.current.addRecentInstrument('MEME-BNB');
        result.current.toggleFavoriteInstrument('DOGE-BNB');
      });

      // 创建新的 store 实例应该恢复状态
      const { result: newResult } = renderHook(() => useAppStore());

      expect(newResult.current.preferences.theme).toBe('light');
      expect(newResult.current.recentInstruments).toContain('MEME-BNB');
      expect(newResult.current.favoriteInstruments.has('DOGE-BNB')).toBe(true);
    });

    test('重置为默认设置', () => {
      const { result } = renderHook(() => useAppStore());

      // 修改状态
      act(() => {
        result.current.setTheme('light');
        result.current.addRecentInstrument('MEME-BNB');
        result.current.toggleFavoriteInstrument('DOGE-BNB');
      });

      // 重置
      act(() => {
        appStoreUtils.resetToDefaults();
      });

      expect(result.current.preferences).toEqual(DEFAULT_PREFERENCES);
      expect(result.current.recentInstruments).toHaveLength(0);
      expect(result.current.favoriteInstruments.size).toBe(0);
    });
  });

  describe('工具函数', () => {
    test('导出用户数据', () => {
      const { result } = renderHook(() => useAppStore());

      // 修改一些状态
      act(() => {
        result.current.setTheme('light');
        result.current.addRecentInstrument('MEME-BNB');
        result.current.toggleFavoriteInstrument('DOGE-BNB');
      });

      const exportedData = appStoreUtils.exportUserData();

      expect(exportedData.preferences.theme).toBe('light');
      expect(exportedData.recentInstruments).toContain('MEME-BNB');
      expect(exportedData.favoriteInstruments).toContain('DOGE-BNB');
      expect(exportedData.exportDate).toBeDefined();
    });

    test('导入用户数据', () => {
      const importData = {
        preferences: {
          theme: 'light' as const,
          slippageTolerance: 1.0,
          transactionDeadline: 30,
          showAdvancedSettings: true,
          autoConnectWallet: false,
        },
        recentInstruments: ['MEME-BNB', 'DOGE-BNB'],
        favoriteInstruments: ['SHIB-BNB', 'PEPE-BNB'],
        transactions: [],
      };

      act(() => {
        appStoreUtils.importUserData(importData);
      });

      const { result } = renderHook(() => useAppStore());

      expect(result.current.preferences.theme).toBe('light');
      expect(result.current.preferences.slippageTolerance).toBe(1.0);
      expect(result.current.recentInstruments).toEqual(['MEME-BNB', 'DOGE-BNB']);
      expect(result.current.favoriteInstruments.has('SHIB-BNB')).toBe(true);
    });

    test('导入无效数据时抛出错误', () => {
      expect(() => {
        appStoreUtils.importUserData(null as any);
      }).toThrow('无效的用户数据格式');

      expect(() => {
        appStoreUtils.importUserData('invalid' as any);
      }).toThrow('无效的用户数据格式');
    });
  });
});
