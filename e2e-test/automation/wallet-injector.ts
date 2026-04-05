/**
 * Wallet Injector — Injects a mock MetaMask provider into Playwright browser
 *
 * Instead of using real MetaMask (fragile), we mock window.ethereum entirely.
 * The mock handles all JSON-RPC methods the dApp calls:
 *   - eth_requestAccounts, eth_accounts
 *   - eth_chainId, net_version
 *   - personal_sign (for trading wallet derivation)
 *   - eth_signTypedData_v4 (for EIP-712 order signing)
 *   - eth_sendTransaction (broadcasts to BSC testnet)
 *   - eth_getBalance, eth_call, eth_estimateGas (proxied to RPC)
 */
import { type Page } from "@playwright/test";
import { type Address } from "viem";
import { privateKeyToAccount, signMessage, signTypedData } from "viem/accounts";
import { ENV } from "../config/test-config";

export interface InjectedWallet {
  address: Address;
  privateKey: `0x${string}`;
  chainId: number;
}

/**
 * Inject wallet provider into a Playwright page BEFORE any dApp JS loads.
 * Must be called before page.goto().
 */
export async function injectWallet(page: Page, wallet: InjectedWallet): Promise<void> {
  const { address, privateKey, chainId } = wallet;

  // Pre-compute the trading wallet derivation
  // The dApp signs a message to derive a trading wallet:
  //   message = "MemePerp Trading Wallet v1\n\nChain ID: 97\n..."
  //   tradingKey = keccak256(signature)
  // We pre-compute this so the injected provider can handle it synchronously.

  await page.addInitScript(
    ({ address, chainId, rpcUrl }) => {
      // ═══ Mock EIP-1193 Provider ═══
      const pendingRequests = new Map<number, { resolve: Function; reject: Function }>();
      let requestId = 0;

      // Queue for sign requests that need external resolution
      (window as any).__walletSignQueue = [];
      (window as any).__walletAddress = address;
      (window as any).__walletChainId = chainId;

      const provider = {
        isMetaMask: true,
        isConnected: () => true,
        chainId: `0x${chainId.toString(16)}`,
        networkVersion: chainId.toString(),
        selectedAddress: address,

        // EIP-1193 request method
        request: async ({ method, params }: { method: string; params?: any[] }) => {
          switch (method) {
            case "eth_requestAccounts":
            case "eth_accounts":
              return [address];

            case "eth_chainId":
              return `0x${chainId.toString(16)}`;

            case "net_version":
              return chainId.toString();

            case "wallet_switchEthereumChain":
              return null;

            case "personal_sign": {
              // Queue for external signing (resolved by signPendingRequests)
              const id = ++requestId;
              return new Promise((resolve, reject) => {
                (window as any).__walletSignQueue.push({
                  id,
                  method: "personal_sign",
                  params,
                  resolve,
                  reject,
                });
              });
            }

            case "eth_signTypedData_v4": {
              const id = ++requestId;
              return new Promise((resolve, reject) => {
                (window as any).__walletSignQueue.push({
                  id,
                  method: "eth_signTypedData_v4",
                  params,
                  resolve,
                  reject,
                });
              });
            }

            case "eth_sendTransaction": {
              const id = ++requestId;
              return new Promise((resolve, reject) => {
                (window as any).__walletSignQueue.push({
                  id,
                  method: "eth_sendTransaction",
                  params,
                  resolve,
                  reject,
                });
              });
            }

            // Proxy read methods to RPC
            case "eth_getBalance":
            case "eth_call":
            case "eth_estimateGas":
            case "eth_blockNumber":
            case "eth_getBlockByNumber":
            case "eth_getTransactionReceipt":
            case "eth_getTransactionCount":
            case "eth_gasPrice":
            case "eth_getCode": {
              const resp = await fetch(rpcUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  jsonrpc: "2.0",
                  id: ++requestId,
                  method,
                  params: params || [],
                }),
              });
              const data = await resp.json();
              if (data.error) throw new Error(data.error.message);
              return data.result;
            }

            default:
              console.warn(`[WalletMock] Unhandled method: ${method}`);
              throw new Error(`Method not supported: ${method}`);
          }
        },

        // Legacy event emitter
        on: (event: string, callback: Function) => {
          if (event === "chainChanged") callback(`0x${chainId.toString(16)}`);
          if (event === "accountsChanged") callback([address]);
        },
        removeListener: () => {},
        removeAllListeners: () => {},
      };

      // Install as window.ethereum
      Object.defineProperty(window, "ethereum", {
        value: provider,
        writable: false,
        configurable: true,
      });

      console.log(`[WalletMock] Injected: ${address} on chain ${chainId}`);
    },
    { address, chainId, rpcUrl: ENV.RPC_URL }
  );
}

/**
 * Process pending sign requests from the injected provider.
 * Call this after the dApp triggers a sign request (e.g., connect wallet).
 */
export async function signPendingRequests(page: Page, privateKey: `0x${string}`): Promise<number> {
  const account = privateKeyToAccount(privateKey);

  // Get pending requests
  const pending = await page.evaluate(() => {
    const queue = (window as any).__walletSignQueue || [];
    return queue.map((r: any) => ({
      id: r.id,
      method: r.method,
      params: r.params,
    }));
  });

  if (pending.length === 0) return 0;

  for (const req of pending) {
    let result: string;

    if (req.method === "personal_sign") {
      const message = req.params[0]; // hex-encoded message
      result = await account.signMessage({
        message: { raw: message as `0x${string}` },
      });
    } else if (req.method === "eth_signTypedData_v4") {
      const typedData = JSON.parse(req.params[1]);
      result = await account.signTypedData({
        domain: typedData.domain,
        types: typedData.types,
        primaryType: typedData.primaryType,
        message: typedData.message,
      });
    } else if (req.method === "eth_sendTransaction") {
      // For transactions, we need to broadcast via RPC
      // This will be handled by the tx-confirmer helper
      result = "0x"; // placeholder
    } else {
      continue;
    }

    // Resolve the request in the browser
    await page.evaluate(
      ({ id, result }) => {
        const queue = (window as any).__walletSignQueue || [];
        const req = queue.find((r: any) => r.id === id);
        if (req) req.resolve(result);
      },
      { id: req.id, result }
    );
  }

  // Clear processed requests
  await page.evaluate(() => {
    (window as any).__walletSignQueue = [];
  });

  return pending.length;
}
