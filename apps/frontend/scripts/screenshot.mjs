import { chromium } from "playwright";
const BASE = "http://127.0.0.1:5173";
const rand = Date.now();
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

await page.goto(`${BASE}/register`, { waitUntil: "networkidle" });
await page.getByLabel("Username").fill(`shot_${rand}`);
await page.getByLabel("Email").fill(`shot_${rand}@example.com`);
await page.getByLabel("Password").fill("password123");
await page.getByRole("button", { name: "Register" }).click();
await page.waitForURL((u) => !u.pathname.startsWith("/register"), { timeout: 10000 });

await page.getByRole("button", { name: "Add a Server" }).click();
await page.getByLabel("Server name").fill("Screenshot Server");
await page.getByRole("button", { name: "Create", exact: true }).click();
await page.waitForURL(/\/channels\/.+\/.+/, { timeout: 10000 });
await page.getByPlaceholder(/^Message /).waitFor({ timeout: 10000 });
await page.getByPlaceholder(/^Message /).fill("Hey, this is **Lumina** running for real 🎉");
await page.getByPlaceholder(/^Message /).press("Enter");
await page.getByText("Hey, this is").waitFor({ timeout: 5000 });
await page.waitForTimeout(300);

await page.screenshot({ path: "/tmp/claude-1000/-home-lucid/0df616d0-6cb1-4d2e-b75b-7d40a53252c8/scratchpad/lumina-screenshot.png" });
console.log("screenshot saved");
await browser.close();
