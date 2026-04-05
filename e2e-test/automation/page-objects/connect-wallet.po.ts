/**
 * Connect Wallet Page Object
 * Handles: clicking connect button, selecting injected wallet, confirming
 */
import { type Page } from "@playwright/test";
import { BasePage } from "./base-page";
import { signPendingRequests } from "../wallet-injector";

export class ConnectWalletPage extends BasePage {
  constructor(page: Page, private privateKey: `0x${string}`) {
    super(page);
  }

  /** Full connect flow: click connect → select injected → confirm */
  async connect(): Promise<void> {
    // Look for connect button (RainbowKit)
    const connectBtn = this.page.locator('button:has-text("Connect"), button:has-text("连接钱包"), [data-testid="connect-wallet"]');

    if (await connectBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await connectBtn.click();
      await this.page.waitForTimeout(1000);

      // RainbowKit modal: click "Injected" or "Browser Wallet" or first option
      const injectedOption = this.page.locator(
        'button:has-text("Injected"), button:has-text("Browser Wallet"), [data-testid="rk-wallet-option-injected"]'
      );
      if (await injectedOption.isVisible({ timeout: 3000 }).catch(() => false)) {
        await injectedOption.click();
      } else {
        // Try first wallet option in the modal
        const firstOption = this.page.locator('[role="dialog"] button').first();
        if (await firstOption.isVisible({ timeout: 2000 }).catch(() => false)) {
          await firstOption.click();
        }
      }

      await this.page.waitForTimeout(1500);

      // Process any pending sign requests (trading wallet derivation)
      await signPendingRequests(this.page, this.privateKey);
      await this.page.waitForTimeout(1000);
    }
  }

  /** Check if wallet is already connected */
  async isConnected(): Promise<boolean> {
    // If we see a truncated address or balance display, wallet is connected
    const addressDisplay = this.page.locator('[class*="address"], [data-testid="account-button"]');
    return addressDisplay.isVisible({ timeout: 2000 }).catch(() => false);
  }

  /** Generate trading wallet (sign derivation message) */
  async generateTradingWallet(): Promise<void> {
    // The app auto-generates on connect, but may need explicit trigger
    const generateBtn = this.page.locator('button:has-text("Generate"), button:has-text("生成交易钱包")');
    if (await generateBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await generateBtn.click();
      await this.page.waitForTimeout(1000);
      await signPendingRequests(this.page, this.privateKey);
      await this.page.waitForTimeout(1000);
    }
  }
}
