/**
 * Positions Page Object
 * Handles: viewing open positions, closing positions, verifying PnL
 */
import { type Page } from "@playwright/test";
import { BasePage } from "./base-page";
import { signPendingRequests } from "../wallet-injector";

export interface PositionInfo {
  token: string;
  side: string;
  size: string;
  entryPrice: string;
  markPrice: string;
  pnl: string;
  leverage: string;
  margin: string;
  liquidationPrice: string;
}

export class PositionsPage extends BasePage {
  constructor(page: Page, private privateKey: `0x${string}`) {
    super(page);
  }

  /** Get list of open positions displayed on the page */
  async getPositions(): Promise<PositionInfo[]> {
    await this.page.waitForTimeout(1000);
    return this.page.evaluate(() => {
      const positions: any[] = [];
      // Try to read from position rows
      const rows = document.querySelectorAll(
        '[data-testid="position-row"], .position-row, tr[class*="position"]'
      );
      rows.forEach((row) => {
        positions.push({
          token: row.querySelector('[data-testid="position-token"]')?.textContent || "",
          side: row.querySelector('[data-testid="position-side"]')?.textContent || "",
          size: row.querySelector('[data-testid="position-size"]')?.textContent || "",
          entryPrice: row.querySelector('[data-testid="position-entry"]')?.textContent || "",
          markPrice: row.querySelector('[data-testid="position-mark"]')?.textContent || "",
          pnl: row.querySelector('[data-testid="position-pnl"]')?.textContent || "",
          leverage: row.querySelector('[data-testid="position-leverage"]')?.textContent || "",
          margin: row.querySelector('[data-testid="position-margin"]')?.textContent || "",
          liquidationPrice: row.querySelector('[data-testid="position-liq"]')?.textContent || "",
        });
      });
      return positions;
    });
  }

  /** Get position count */
  async getPositionCount(): Promise<number> {
    const positions = await this.getPositions();
    return positions.length;
  }

  /** Close a position by clicking the close button */
  async closePosition(index = 0): Promise<boolean> {
    const closeBtn = this.page.locator(
      'button:has-text("Close"), button:has-text("平仓"), [data-testid="close-position"]'
    ).nth(index);

    if (!(await closeBtn.isVisible({ timeout: 3000 }).catch(() => false))) {
      return false;
    }

    await closeBtn.click();
    await this.page.waitForTimeout(1000);

    // Confirm close dialog
    const confirmBtn = this.page.locator(
      'button:has-text("Confirm"), button:has-text("确认")'
    ).first();
    if (await confirmBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await confirmBtn.click();
    }

    // Sign order
    await signPendingRequests(this.page, this.privateKey);
    await this.page.waitForTimeout(3000);

    return true;
  }

  /** Wait for a position to appear */
  async waitForPosition(timeout = 15000): Promise<boolean> {
    try {
      await this.page.waitForSelector(
        '[data-testid="position-row"], .position-row, tr[class*="position"]',
        { state: "visible", timeout }
      );
      return true;
    } catch {
      return false;
    }
  }
}
