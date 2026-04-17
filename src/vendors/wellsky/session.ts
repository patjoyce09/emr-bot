import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type { StructuredStepLogger } from "../../core/logger.js";
import type { WellSkyCredentials } from "../../core/secrets.js";
import type { WellSkySelectors } from "./selectors.js";

export interface WellSkyWorkerConfig {
  baseUrl: string;
  loginPath: string;
  reportPath: string;
  headless: boolean;
}

export interface WellSkySession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  close: () => Promise<void>;
}

export async function startIsolatedSession(
  tenantId: string,
  logger: StructuredStepLogger,
  config: WellSkyWorkerConfig
): Promise<WellSkySession> {
  logger.push("browser.launch", "started", { tenant_id: tenantId });
  const browser = await chromium.launch({ headless: config.headless });
  const context = await browser.newContext({
    acceptDownloads: true
  });
  const page = await context.newPage();
  logger.push("browser.launch", "succeeded", { tenant_id: tenantId });

  return {
    browser,
    context,
    page,
    close: async () => {
      await context.close();
      await browser.close();
    }
  };
}

export async function bootstrapWellSkySession(
  page: Page,
  credentials: WellSkyCredentials,
  logger: StructuredStepLogger,
  config: WellSkyWorkerConfig,
  selectors: WellSkySelectors
): Promise<void> {
  const loginUrl = new URL(config.loginPath, config.baseUrl).toString();
  logger.push("wellsky.goto_login", "started", { url: loginUrl });
  await page.goto(loginUrl, { waitUntil: "domcontentloaded" });
  logger.push("wellsky.goto_login", "succeeded", { url: loginUrl });

  logger.push("wellsky.login", "started");
  await page.locator(selectors.usernameInput).first().fill(credentials.username);
  await page.locator(selectors.passwordInput).first().fill(credentials.password);
  await page.locator(selectors.loginButton).first().click();

  try {
    await page.locator(selectors.postLoginReadyMarker).first().waitFor({ timeout: 45_000 });
  } catch {
    const mfaPromptVisible = await page.getByText(/mfa|multi-factor|verification code/i).first().isVisible().catch(() => false);
    if (mfaPromptVisible) {
      throw new Error("MFA prompt detected.");
    }

    const deniedVisible = await page.getByText(/permission denied|access denied|not authorized/i).first().isVisible().catch(() => false);
    if (deniedVisible) {
      throw new Error("Permission denied after login.");
    }

    const usernameStillVisible = await page.locator(selectors.usernameInput).first().isVisible().catch(() => false);
    if (usernameStillVisible) {
      throw new Error("Login failed with provided credentials.");
    }

    throw new Error("Session expired or login flow did not reach ready state.");
  }

  logger.push("wellsky.login", "succeeded");
}
