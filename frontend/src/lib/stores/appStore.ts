/**
 * 应用全局状态管理 Store
 * 使用 Zustand 管理全局状态
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

// 应用主题类型
export type AppTheme = 'light' | 'dark' | 'system';

// 用户偏好设置
export interface UserPreferences {
  theme: AppTheme;
  slippageTolerance: number; // 滑点容忍度 (百分比)
  transactionDeadline: number; // 交易截止时间 (分钟)
  showAdvancedSettings: boolean;
  autoConnectWallet: boolean;
}

// 交易状态
export interface TransactionState {
  hash: string;
  status: 'pending' | 'confirmed' | 'failed';
  type: 'buy' | 'sell' | 'create' | 'register';
  instId: string; // 交易对ID，如 "MEME-BNB"
  timestamp: number;
  amount?: string;
}

// 应用状态
export interface AppState {
  // 用户偏好
  preferences: UserPreferences;

  // 交易历史
  transactions: TransactionState[];

  // 最近访问的交易对
  recentInstruments: string[];

  // 收藏的交易对
  favoriteInstruments: Set<string>;

  // UI 状态
  sidebarCollapsed: boolean;
  mobileMenuOpen: boolean;

  // 更新方法
  setTheme: (theme: AppTheme) => void;
  setSlippageTolerance: (slippage: number) => void;
  setTransactionDeadline: (deadline: number) => void;
  toggleAdvancedSettings: () => void;
  toggleAutoConnectWallet: () => void;

  // 交易管理
  addTransaction: (transaction: Omit<TransactionState, 'timestamp'>) => void;
  updateTransactionStatus: (hash: string, status: TransactionState['status']) => void;
  clearTransactions: () => void;

  // 交易对管理
  addRecentInstrument: (instId: string) => void;
  toggleFavoriteInstrument: (instId: string) => void;

  // UI 控制
  toggleSidebar: () => void;
  toggleMobileMenu: () => void;
  closeMobileMenu: () => void;
}

// 默认偏好设置
export const DEFAULT_PREFERENCES: UserPreferences = {
  theme: 'dark',
  slippageTolerance: 0.5, // 0.5%
  transactionDeadline: 20, // 20分钟
  showAdvancedSettings: false,
  autoConnectWallet: true,
};

// 创建应用 Store
export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      // 初始状态
      preferences: DEFAULT_PREFERENCES,
      transactions: [],
      recentInstruments: [],
      favoriteInstruments: new Set(),
      sidebarCollapsed: false,
      mobileMenuOpen: false,

      // 偏好设置更新
      setTheme: (theme) =>
        set((state) => ({
          preferences: { ...state.preferences, theme },
        })),

      setSlippageTolerance: (slippage) =>
        set((state) => ({
          preferences: { ...state.preferences, slippageTolerance: slippage },
        })),

      setTransactionDeadline: (deadline) =>
        set((state) => ({
          preferences: { ...state.preferences, transactionDeadline: deadline },
        })),

      toggleAdvancedSettings: () =>
        set((state) => ({
          preferences: {
            ...state.preferences,
            showAdvancedSettings: !state.preferences.showAdvancedSettings,
          },
        })),

      toggleAutoConnectWallet: () =>
        set((state) => ({
          preferences: {
            ...state.preferences,
            autoConnectWallet: !state.preferences.autoConnectWallet,
          },
        })),

      // 交易管理
      addTransaction: (transaction) =>
        set((state) => ({
          transactions: [
            {
              ...transaction,
              timestamp: Date.now(),
            },
            ...state.transactions,
          ].slice(0, 50), // 最多保存50条记录
        })),

      updateTransactionStatus: (hash, status) =>
        set((state) => ({
          transactions: state.transactions.map((tx) =>
            tx.hash === hash ? { ...tx, status } : tx
          ),
        })),

      clearTransactions: () =>
        set({ transactions: [] }),

      // 交易对管理
      addRecentInstrument: (instId) =>
        set((state) => {
          const normalized = instId.toUpperCase();
          const filtered = state.recentInstruments.filter(i => i !== normalized);
          return {
            recentInstruments: [normalized, ...filtered].slice(0, 10), // 最多10个
          };
        }),

      toggleFavoriteInstrument: (instId) =>
        set((state) => {
          const normalized = instId.toUpperCase();
          const newFavorites = new Set(state.favoriteInstruments);

          if (newFavorites.has(normalized)) {
            newFavorites.delete(normalized);
          } else {
            newFavorites.add(normalized);
          }

          return { favoriteInstruments: newFavorites };
        }),

      // UI 控制
      toggleSidebar: () =>
        set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),

      toggleMobileMenu: () =>
        set((state) => ({ mobileMenuOpen: !state.mobileMenuOpen })),

      closeMobileMenu: () =>
        set({ mobileMenuOpen: false }),
    }),
    {
      name: 'dexi-storage', // localStorage 键名
      partialize: (state) => ({
        preferences: state.preferences,
        recentInstruments: state.recentInstruments,
        favoriteInstruments: Array.from(state.favoriteInstruments),
      }),
      // 正确恢复 Set 类型
      merge: (persistedState, currentState) => {
        const persisted = persistedState as Partial<{ favoriteInstruments: string[] } & Omit<typeof currentState, "favoriteInstruments">>;
        return {
          ...currentState,
          ...persisted,
          // 确保 favoriteInstruments 是 Set (localStorage 序列化为 Array)
          favoriteInstruments: new Set(persisted?.favoriteInstruments || []),
        };
      },
    }
  )
);

// 选择器 Hook（性能优化）
export const usePreferences = () => useAppStore((state) => state.preferences);
export const useTheme = () => useAppStore((state) => state.preferences.theme);
export const useSlippageTolerance = () => useAppStore((state) => state.preferences.slippageTolerance);
export const useTransactionDeadline = () => useAppStore((state) => state.preferences.transactionDeadline);

export const useTransactions = () => useAppStore((state) => state.transactions);
export const usePendingTransactions = () =>
  useAppStore((state) => state.transactions.filter((tx) => tx.status === 'pending'));

export const useRecentInstruments = () => useAppStore((state) => state.recentInstruments);
export const useFavoriteInstruments = () => useAppStore((state) => state.favoriteInstruments);
export const useIsFavoriteInstrument = (instId: string) =>
  useAppStore((state) => state.favoriteInstruments.has(instId.toUpperCase()));

export const useSidebarCollapsed = () => useAppStore((state) => state.sidebarCollapsed);
export const useMobileMenuOpen = () => useAppStore((state) => state.mobileMenuOpen);

// 工具函数
export const appStoreUtils = {
  // 重置为默认设置
  resetToDefaults: () => {
    useAppStore.setState({
      preferences: DEFAULT_PREFERENCES,
      transactions: [],
      recentInstruments: [],
      favoriteInstruments: new Set(),
      sidebarCollapsed: false,
      mobileMenuOpen: false,
    });
  },

  // 导出用户数据
  exportUserData: () => {
    const state = useAppStore.getState();
    return {
      preferences: state.preferences,
      recentInstruments: state.recentInstruments,
      favoriteInstruments: Array.from(state.favoriteInstruments),
      transactions: state.transactions,
      exportDate: new Date().toISOString(),
    };
  },

  // 导入用户数据
  importUserData: (data: unknown) => {
    if (!data || typeof data !== 'object') {
      throw new Error('无效的用户数据格式');
    }
    const d = data as Record<string, unknown>;
    useAppStore.setState({
      preferences: (d.preferences as typeof DEFAULT_PREFERENCES) || DEFAULT_PREFERENCES,
      recentInstruments: (d.recentInstruments as string[]) || [],
      favoriteInstruments: new Set((d.favoriteInstruments as string[]) || []),
      transactions: (d.transactions as TransactionState[]) || [],
    });
  },
};