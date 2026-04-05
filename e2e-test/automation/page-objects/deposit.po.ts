/**
 * Deposit Page Object
 * Handles: navigate to deposit, enter amount, confirm on-chain transaction
 * Flow: BNB → WBNB → SettlementV2.deposit()
 */
import { type Page } from "@playwright/test";
import { BasePage } from "./base-page";
import { signPendingRequests } from "../wallet-injector";

export class DepositPage extends BasePage {
  constructor(page: Page, private privateKey: `0x${string}`) {
    super(page);
  }

  /** Navigate to deposit UI */
  async navigateToDeposit(): Promise<void> {
    // Look for deposit button in the account/balance area
    const depositBtn = this.page.locator(
      'button:has-text("Deposit"), button:has-text("存款"), button:has-text("充值"), [data-testid="deposit-btn"]'
    ).first();
    if (await depositBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await depositBtn.click();
      await this.page.waitForTimeout(1000);
    }
  }

  /** Enter deposit amount */
  async enterAmount(bnbAmount: string): Promise<void> {
    const input = this.page.locator(
      'input[placeholder*="amount"], input[placeholder*="Amount"], input[placeholder*="金额"], input[type="number"], [data-testid="deposit-amount"]'
    ).first();
    await input.click();
    await input.fill("");
    await input.fill(bnbAmount);
    await this.page.waitForTimeout(500);
  }

  /** Confirm deposit transaction */
  async confirmDeposit(): Promise<boolean> {
    const confirmBtn = this.page.locator(
      'button:has-text("Confirm"), button:has-text("确认"), button:has-text("Deposit"), [data-testid="confirm-deposit"]'
    ).first();

    if (!(await confirmBtn.isEnabled({ timeout: 3000 }).catch(() => false))) {
      return false;
    }

    await confirmBtn.click();
    await this.page.waitForTimeout(1000);

    // Sign any pending transactions
    await signPendingRequests(this.page, this.privateKey);
    await this.page.waitForTimeout(2000);

    // May need multiple confirmations (approve WBNB + deposit)
    await signPendingRequests(this.page, this.privateKey);
    await this.page.waitForTimeout(3000);

    // Check for success
    const success = await this.page.locator(
      ':has-text("Success"), :has-text("成功"), .toast-success'
    ).isVisible({ timeout: 10000 }).catch(() => false);

    return success;
  }

  /** Full deposit flow */
  async deposit(bnbAmount: string): Promise<boolean> {
    await this.navigateToDeposit();
    await this.enterAmount(bnbAmount);
    return this.confirmDeposit();
  }
}
