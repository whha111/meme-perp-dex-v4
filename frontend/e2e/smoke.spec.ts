import { test, expect } from "@playwright/test";

// Run tests serially to avoid cold-start stampede on Next.js dev server
test.describe("Smoke Tests", () => {
  test.describe.configure({ mode: "serial" });
  test.setTimeout(60_000);

  test("homepage loads and shows MEMEPERP branding", async ({ page }) => {
    // First test warms up the page — allow extra time for Next.js compilation
    await page.goto("/", { timeout: 45_000 });
    await expect(page.getByRole("link", { name: /MEMEPERP/i }).first()).toBeVisible({ timeout: 15_000 });
  });

  test("homepage shows section headings", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 2 })).toHaveCount(2, { timeout: 15_000 });
  });

  test("connect wallet button is visible", async ({ page }) => {
    await page.goto("/");
    const connectBtn = page.getByRole("button", { name: /连接钱包|Connect Wallet/i });
    await expect(connectBtn).toBeVisible({ timeout: 15_000 });
  });

  test("language selector works", async ({ page }) => {
    await page.goto("/");
    const langBtn = page.getByRole("button", { name: /Select language/i });
    await expect(langBtn).toBeVisible({ timeout: 15_000 });
  });

  test("navigation to /perp works", async ({ page }) => {
    await page.goto("/perp", { waitUntil: "domcontentloaded", timeout: 45_000 });
    await expect(page).toHaveURL(/\/perp/);
    await expect(page.locator("text=MEMEPERP").first()).toBeVisible({ timeout: 15_000 });
  });

  test("no console errors on load", async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });
    await page.goto("/", { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(3000);
    const criticalErrors = errors.filter(
      (e) =>
        !e.includes("WebSocket") &&
        !e.includes("ERR_CONNECTION_REFUSED") &&
        !e.includes("Failed to fetch") &&
        !e.includes("Failed to load resource") &&
        !e.includes("NEXT_REDIRECT") &&
        !e.includes("hydrat")
    );
    expect(criticalErrors).toHaveLength(0);
  });
});
