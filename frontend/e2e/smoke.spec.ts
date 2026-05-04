import { expect, test } from "@playwright/test";

const routes = [
  "/",
  "/perp",
  "/perp?marketId=PEPE-USDT-PERP",
  "/perp?marketId=DOGE-USDT-PERP",
  "/exchange",
  "/deposit",
  "/vault",
  "/account",
  "/settings",
  "/wallet",
];

test.describe("DEXI smoke tests", () => {
  test.describe.configure({ mode: "serial" });
  test.setTimeout(90_000);

  for (const route of routes) {
    test(`${route} renders without a server error`, async ({ page }) => {
      const response = await page.goto(route, { waitUntil: "domcontentloaded", timeout: 60_000 });
      expect(response?.status()).toBeLessThan(500);
      await expect(page.locator("body")).toBeVisible();
      await expect(page.getByText("DEXI").first()).toBeVisible({ timeout: 20_000 });
    });
  }

  test("perp terminal exposes market, chart, order panels, and account rail", async ({ page }) => {
    await page.goto("/perp?marketId=DOGE-USDT-PERP", { waitUntil: "domcontentloaded", timeout: 60_000 });

    await expect(page.getByText(/DOGE-USDT|DOGE\/USDT/).first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("USDT").first()).toBeVisible();
    await expect(page.getByText("BNB").first()).toBeVisible();
    await expect(page.getByText(/Positions:/).first()).toBeVisible();
  });

  test("bare perp route opens the default trading terminal", async ({ page }) => {
    await page.goto("/perp", { waitUntil: "domcontentloaded", timeout: 60_000 });

    await expect(page.getByText(/PEPE-USDT|PEPE\/USDT/).first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("USDT").first()).toBeVisible();
    await expect(page.getByText("BNB").first()).toBeVisible();
    await expect(page.getByText("Markets")).toHaveCount(0);
  });

  test("top navigation reaches account, vault, and deposit", async ({ page }) => {
    await page.goto("/perp?marketId=PEPE-USDT-PERP", { waitUntil: "domcontentloaded", timeout: 60_000 });

    await page.locator('a[href="/exchange"]').first().click();
    await expect(page).toHaveURL(/\/exchange/);

    await page.goto("/perp?marketId=PEPE-USDT-PERP", { waitUntil: "domcontentloaded", timeout: 60_000 });

    await page.locator('a[href="/account"]').first().click();
    await expect(page).toHaveURL(/\/account/);

    await page.locator('a[href="/vault"]').first().click();
    await expect(page).toHaveURL(/\/vault/);

    await page.locator('a[href="/deposit"]').first().click();
    await expect(page).toHaveURL(/\/deposit/);
  });

  test("swap page quotes a zero-fee BNB to PEPE route", async ({ page }) => {
    await page.goto("/exchange", { waitUntil: "domcontentloaded", timeout: 60_000 });

    await expect(page.getByText("DEXI fee 0 bps").first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("swap-client-ready")).toHaveAttribute("data-ready", "true", {
      timeout: 20_000,
    });
    const quoteResponse = page.waitForResponse(
      (response) => response.url().includes("/api/swap/quote") && response.status() === 200,
      { timeout: 30_000 }
    );
    await page.locator('input[inputmode="decimal"]').fill("0.001");
    await quoteResponse;
    await expect(page.getByTestId("swap-min-received")).toContainText("PEPE", { timeout: 20_000 });
    await expect(page.getByTestId("swap-route")).toContainText("PEPE", { timeout: 20_000 });
  });

  test("no critical console errors on terminal load", async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });

    await page.goto("/perp?marketId=PEPE-USDT-PERP", { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(3000);

    const criticalErrors = errors.filter(
      (error) =>
        !error.includes("WebSocket") &&
        !error.includes("ERR_CONNECTION_REFUSED") &&
        !error.includes("Failed to fetch") &&
        !error.includes("Failed to load resource") &&
        !error.includes("NEXT_REDIRECT") &&
        !error.toLowerCase().includes("hydration")
    );
    expect(criticalErrors).toHaveLength(0);
  });
});
