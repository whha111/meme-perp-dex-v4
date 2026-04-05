/**
 * Withdrawal Page Object
 * Handles: Merkle proof withdrawal flow
 * Flow: Request withdrawal → Get Merkle proof → Submit on-chain
 */
import { type Page } from "@playwright/test";
import { BasePage } from "./base-page";
import { signPendingRequests } from "../wallet-injector";

export class WithdrawalPage extends BasePage {
  constructor(page: Page, private privateKey: `0x${string}`) {
    super(page);
  }

  /** Navigate to withdrawal UI */
  async navigateToWithdraw(): Promise<void> {
    const withdrawBtn = this.page.locator(
      'button:has-text("Withdraw"), button:has-text("提款"), button:has-text("提现"), [data-testid="withdraw-btn"]'
    ).first();
    if (await withdrawBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await withdrawBtn.click();
      await this.page.waitForTimeout(1000);
    }
  }

  /** Enter withdrawal amount */
  async enterAmount(bnbAmount: string): Promise<void> {
    const input = this.page.locator(
      'input[placeholder*="amount"], input[placeholder*="withdraw"], input[type="number"], [data-testid="withdraw-amount"]'
    ).first();
    await input.click();
    await input.fill("");
    await input.fill(bnbAmount);
    await this.page.waitForTimeout(500);
  }

  /** Confirm withdrawal (sign + submit on-chain) */
  async confirmWithdraw(): Promise<boolean> {
    const confirmBtn = this.page.locator(
      'button:has-text("Confirm"), button:has-text("确认"), button:has-text("Withdraw"), [data-testid="confirm-withdraw"]'
    ).first();

    if (!(await confirmBtn.isEnabled({ timeout: 3000 }).catch(() => false))) {
      return false;
    }

    await confirmBtn.click();
    await this.page.waitForTimeout(1000);

    // Sign Merkle proof request
    await signPendingRequests(this.page, this.privateKey);
    await this.page.waitForTimeout(2000);

    // Sign on-chain transaction
    await signPendingRequests(this.page, this.privateKey);
    await this.page.waitForTimeout(5000);

    const success = await this.page.locator(
      ':has-text("Success"), :has-text("成功"), .toast-success'
    ).isVisible({ timeout: 15000 }).catch(() => false);

    return success;
  }

  /** Full withdrawal flow */
  async withdraw(bnbAmount: string): Promise<boolean> {
    await this.navigateToWithdraw();
    await this.enterAmount(bnbAmount);
    return this.confirmWithdraw();
  }
}
