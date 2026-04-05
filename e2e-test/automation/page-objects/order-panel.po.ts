/**
 * Order Panel Page Object
 * Interacts with PerpetualOrderPanelV2 component
 * Handles: selecting side (Long/Short), setting leverage, entering margin, submitting order
 */
import { type Page } from "@playwright/test";
import { BasePage } from "./base-page";
import { signPendingRequests } from "../wallet-injector";

export type OrderSide = "long" | "short";
export type OrderType = "market" | "limit";

export interface OrderParams {
  side: OrderSide;
  type: OrderType;
  margin: string;         // BNB amount as string (e.g., "0.5")
  leverage?: number;       // 1-2.5
  price?: string;          // For limit orders
  reduceOnly?: boolean;
}

export class OrderPanelPage extends BasePage {
  constructor(page: Page, private privateKey: `0x${string}`) {
    super(page);
  }

  /** Select Long or Short */
  async selectSide(side: OrderSide): Promise<void> {
    const text = side === "long" ? "Long" : "Short";
    // Try multiple selectors for the side button
    const btn = this.page.locator(
      `button:has-text("${text}"), [data-testid="order-side-${side}"], .order-side-${side}`
    ).first();
    await btn.click();
    await this.page.waitForTimeout(300);
  }

  /** Select order type (Market/Limit) */
  async selectOrderType(type: OrderType): Promise<void> {
    const text = type === "market" ? "Market" : "Limit";
    const btn = this.page.locator(
      `button:has-text("${text}"), [data-testid="order-type-${type}"]`
    ).first();
    await btn.click();
    await this.page.waitForTimeout(300);
  }

  /** Set leverage via slider or button */
  async setLeverage(leverage: number): Promise<void> {
    // Look for leverage options: [1, 1.5, 2, 2.5]
    const leverageText = leverage % 1 === 0 ? `${leverage}x` : `${leverage}x`;
    const btn = this.page.locator(
      `button:has-text("${leverageText}"), [data-testid="leverage-${leverage}"]`
    ).first();
    if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await btn.click();
    } else {
      // Try direct input
      const input = this.page.locator('input[name="leverage"], [data-testid="leverage-input"]');
      if (await input.isVisible({ timeout: 1000 }).catch(() => false)) {
        await input.fill(leverage.toString());
      }
    }
    await this.page.waitForTimeout(300);
  }

  /** Enter margin amount */
  async enterMargin(amount: string): Promise<void> {
    // Find the margin/amount input
    const input = this.page.locator(
      'input[placeholder*="margin"], input[placeholder*="Amount"], input[placeholder*="金额"], input[name="margin"], [data-testid="margin-input"]'
    ).first();
    await input.click();
    await input.fill("");
    await input.fill(amount);
    await this.page.waitForTimeout(300);
  }

  /** Enter limit price (for limit orders) */
  async enterPrice(price: string): Promise<void> {
    const input = this.page.locator(
      'input[placeholder*="Price"], input[placeholder*="price"], input[placeholder*="价格"], input[name="price"], [data-testid="price-input"]'
    ).first();
    await input.click();
    await input.fill("");
    await input.fill(price);
    await this.page.waitForTimeout(300);
  }

  /** Submit the order */
  async submit(): Promise<boolean> {
    // Find submit button
    const submitBtn = this.page.locator(
      'button:has-text("Open Long"), button:has-text("Open Short"), button:has-text("Place Order"), button:has-text("下单"), [data-testid="submit-order"]'
    ).first();

    if (!(await submitBtn.isEnabled({ timeout: 3000 }).catch(() => false))) {
      return false;
    }

    await submitBtn.click();
    await this.page.waitForTimeout(500);

    // Sign the EIP-712 order
    const signed = await signPendingRequests(this.page, this.privateKey);

    // Wait for success toast or position update
    await this.page.waitForTimeout(2000);

    // Check for success indicator
    const hasError = await this.page.locator(
      '.toast-error, [data-testid="order-error"], :has-text("failed"), :has-text("失败")'
    ).isVisible({ timeout: 2000 }).catch(() => false);

    return !hasError;
  }

  /** Complete order flow: side → type → leverage → margin → (price) → submit */
  async placeOrder(params: OrderParams): Promise<boolean> {
    await this.selectSide(params.side);
    await this.selectOrderType(params.type);

    if (params.leverage) {
      await this.setLeverage(params.leverage);
    }

    await this.enterMargin(params.margin);

    if (params.type === "limit" && params.price) {
      await this.enterPrice(params.price);
    }

    return this.submit();
  }
}
