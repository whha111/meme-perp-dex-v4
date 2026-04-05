/**
 * Base Page Object — Common utilities for all page interactions
 */
import { type Page, expect } from "@playwright/test";
import { ENV, TEST_PARAMS } from "../../config/test-config";

export class BasePage {
  constructor(protected page: Page) {}

  /** Navigate to a frontend route */
  async goto(path: string): Promise<void> {
    await this.page.goto(`${ENV.FRONTEND_URL}${path}`, {
      waitUntil: "networkidle",
      timeout: TEST_PARAMS.UI_ACTION_TIMEOUT_MS,
    });
  }

  /** Wait for element to be visible */
  async waitFor(selector: string, timeout = TEST_PARAMS.UI_ACTION_TIMEOUT_MS): Promise<void> {
    await this.page.waitForSelector(selector, { state: "visible", timeout });
  }

  /** Click with retry */
  async click(selector: string, retries = 3): Promise<void> {
    for (let i = 0; i < retries; i++) {
      try {
        await this.page.click(selector, { timeout: TEST_PARAMS.UI_ACTION_TIMEOUT_MS });
        return;
      } catch (e) {
        if (i === retries - 1) throw e;
        await this.page.waitForTimeout(1000);
      }
    }
  }

  /** Fill input field */
  async fill(selector: string, value: string): Promise<void> {
    await this.page.fill(selector, value);
  }

  /** Get text content */
  async getText(selector: string): Promise<string> {
    return (await this.page.textContent(selector)) || "";
  }

  /** Wait for text to appear anywhere on page */
  async waitForText(text: string, timeout = TEST_PARAMS.UI_ACTION_TIMEOUT_MS): Promise<void> {
    await this.page.waitForFunction(
      (t) => document.body.innerText.includes(t),
      text,
      { timeout }
    );
  }

  /** Take screenshot for debugging */
  async screenshot(name: string): Promise<void> {
    await this.page.screenshot({
      path: `reports/screenshots/${name}-${Date.now()}.png`,
      fullPage: true,
    });
  }

  /** Wait for WebSocket message */
  async waitForWsMessage(type: string, timeout = TEST_PARAMS.WS_MESSAGE_TIMEOUT_MS): Promise<any> {
    return this.page.evaluate(
      ({ type, timeout }) => {
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`WS timeout: ${type}`)), timeout);
          // Hook into the app's WS handler
          const handler = (event: MessageEvent) => {
            try {
              const data = JSON.parse(event.data);
              if (data.type === type) {
                clearTimeout(timer);
                resolve(data);
              }
            } catch {}
          };
          // The app uses WebSocketManager — we listen on the raw WS
          window.addEventListener("message", handler);
        });
      },
      { type, timeout }
    );
  }
}
