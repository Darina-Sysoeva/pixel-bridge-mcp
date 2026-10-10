import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { config } from "./config.js";
import { getLogger } from "./logger.js";

const log = getLogger("browser");

/**
 * Three modes:
 *
 * SHARED (default): one persistent Chromium profile per provider under
 * ~/.pixel-bridge/profiles/, run as a browser that outlives this process.
 * Every bridge process (each Claude session, any one-off script) attaches to
 * the same window, so there is no browser per image and no fight over the
 * profile. The user logs in manually once and the session is reused.
 *
 * LAUNCH (PIXEL_BRIDGE_SHARED_BROWSER=0): the same profiles, but the browser
 * belongs to this process and closes with it.
 *
 * ATTACH (PIXEL_BRIDGE_CDP_URL set): connect to a browser the USER started
 * with --remote-debugging-port. Their existing logins are used as-is. We only
 * ever operate on tabs we opened ourselves — never the user's tabs — and on
 * shutdown we close our tabs and disconnect, leaving their browser running.
 *
 * No credentials are ever handled by this code in either mode.
 *
 * All work for a given provider is serialized through a per-provider queue so
 * two jobs never fight over the same tab.
 */
class BrowserManager {
  private contexts = new Map<string, BrowserContext>();
  private cdpBrowser: Browser | null = null;
  /** Shared browsers we are attached to, one per provider profile. */
  private sharedBrowsers = new Map<string, Browser>();
  /** Tabs we created, one per provider. */
  private pages = new Map<string, Page>();
  private queues = new Map<string, Promise<unknown>>();

  private async getCdpContext(): Promise<BrowserContext> {
    if (this.cdpBrowser?.isConnected()) {
      const existing = this.cdpBrowser.contexts()[0];
      if (existing) return existing;
    }
    log.info(`Attaching to running browser at ${config.cdpUrl}`);
    try {
      this.cdpBrowser = await chromium.connectOverCDP(config.cdpUrl!);
    } catch (err) {
      throw new Error(
        `Could not attach to a browser at ${config.cdpUrl}. Start your browser with ` +
          `--remote-debugging-port and a dedicated --user-data-dir first (see README "Attach mode"). ` +
          `Underlying error: ${String(err)}`
      );
    }
    const context = this.cdpBrowser.contexts()[0] ?? (await this.cdpBrowser.newContext());
    context.setDefaultTimeout(20_000);
    return context;
  }

  private async launchContext(provider: string): Promise<BrowserContext> {
    const existing = this.contexts.get(provider);
    if (existing) {
      try {
        existing.pages();
        return existing;
      } catch {
        this.contexts.delete(provider);
      }
    }

    const profileDir = path.join(config.profilesDir, provider);
    fs.mkdirSync(profileDir, { recursive: true });
    log.info(
      `Launching persistent context for ${provider} (profile: ${profileDir}, headless: ${config.headless})`
    );
    // Chromium does not reliably honor proxy env vars on its own; forward
    // them explicitly so corporate/sandbox proxies work.
    const proxyServer = process.env.HTTPS_PROXY ?? process.env.https_proxy;
    const context = await chromium.launchPersistentContext(profileDir, {
      headless: config.headless,
      channel: config.browserChannel,
      executablePath: config.executablePath,
      viewport: { width: 1440, height: 900 },
      acceptDownloads: true,
      proxy: proxyServer ? { server: proxyServer } : undefined,
      args: ["--disable-blink-features=AutomationControlled"],
    });
    context.setDefaultTimeout(20_000);
    context.on("close", () => {
      this.contexts.delete(provider);
      log.info(`Context for ${provider} closed`);
    });
    this.contexts.set(provider, context);
    return context;
  }

  private async getSharedContext(provider: string): Promise<BrowserContext> {
    const attached = this.sharedBrowsers.get(provider);
    if (attached?.isConnected()) return attached.contexts()[0];

    const profileDir = path.join(config.profilesDir, provider);
    fs.mkdirSync(profileDir, { recursive: true });
    const browser = (await connectToProfile(profileDir)) ?? (await launchShared(profileDir));
    browser.on("disconnected", () => {
      this.sharedBrowsers.delete(provider);
      log.info(`Disconnected from the shared browser for ${provider}`);
    });
    this.sharedBrowsers.set(provider, browser);
    // The default context is the profile itself: its cookies are the login.
    const context = browser.contexts()[0];
    context.setDefaultTimeout(20_000);
    return context;
  }

  async getContext(provider: string): Promise<BrowserContext> {
    if (config.cdpUrl) return this.getCdpContext();
    return config.sharedBrowser ? this.getSharedContext(provider) : this.launchContext(provider);
  }

  /** Get (or create) OUR tab for this provider. Never reuses a user-opened tab. */
  async getPage(provider: string): Promise<Page> {
    const existing = this.pages.get(provider);
    if (existing && !existing.isClosed()) return existing;
    const context = await this.getContext(provider);
    const page = await context.newPage();
    this.pages.set(provider, page);
    return page;
  }

  /**
   * Run `fn` exclusively for this provider — calls queue up behind each other
   * so concurrent tool calls can't interleave keystrokes in one tab.
   * Different providers still run in parallel.
   */
  async withProvider<T>(provider: string, fn: (page: Page) => Promise<T>): Promise<T> {
    const prev = this.queues.get(provider) ?? Promise.resolve();
    const run = prev
      .catch(() => undefined) // one failed job must not poison the queue
      .then(async () => {
        const page = await this.getPage(provider);
        return fn(page);
      });
    this.queues.set(provider, run);
    return run;
  }

  async closeAll(): Promise<void> {
    // Close only tabs we opened.
    for (const [name, page] of this.pages) {
      if (!page.isClosed()) {
        await page.close().catch((err) => log.warn(`Error closing tab ${name}: ${String(err)}`));
      }
    }
    this.pages.clear();
    for (const [name, ctx] of this.contexts) {
      try {
        await ctx.close();
      } catch (err) {
        log.warn(`Error closing context ${name}: ${String(err)}`);
      }
    }
    this.contexts.clear();
    for (const browser of this.sharedBrowsers.values()) {
      // Disconnects only: the shared window stays for the next process.
      await browser.close().catch(() => undefined);
    }
    this.sharedBrowsers.clear();
    if (this.cdpBrowser) {
      // Disconnects from the user's browser; does not terminate it.
      await this.cdpBrowser.close().catch(() => undefined);
      this.cdpBrowser = null;
    }
  }
}

/** CDP endpoint Chrome records in the profile when started with --remote-debugging-port=0. */
function readDevToolsEndpoint(profileDir: string): string | null {
  try {
    const [port, wsPath] = fs
      .readFileSync(path.join(profileDir, "DevToolsActivePort"), "utf8")
      .split("\n")
      .map((s) => s.trim());
    return port && wsPath ? `ws://127.0.0.1:${port}${wsPath}` : null;
  } catch {
    return null;
  }
}

function connectOverCdp(endpoint: string): Promise<Browser | null> {
  return chromium.connectOverCDP(endpoint, { timeout: 10_000 }).then(
    (browser) => {
      log.info(`Attached to shared browser at ${endpoint}`);
      return browser;
    },
    () => null
  );
}

async function connectToProfile(profileDir: string): Promise<Browser | null> {
  const endpoint = readDevToolsEndpoint(profileDir);
  if (!endpoint) return null;
  // With every window closed, macOS Chrome keeps running but turns CDP clients
  // away ("Browser context management is not supported"); a new tab brings a
  // window back. If even that fails, the file is stale and the browser gone.
  return (
    (await connectOverCdp(endpoint)) ??
    ((await openBlankTab(endpoint)) ? connectOverCdp(endpoint) : null)
  );
}

async function openBlankTab(endpoint: string): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${new URL(endpoint).port}/json/new?about:blank`, {
      method: "PUT",
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Start the profile's browser detached, so it outlives this process. The
 * flags repeat what Playwright launched the profile with where it matters:
 * without --use-mock-keychain the stored cookies, and so the login, cannot be
 * decrypted.
 */
async function launchShared(profileDir: string): Promise<Browser> {
  const args = [
    `--user-data-dir=${profileDir}`,
    "--remote-debugging-port=0",
    "--use-mock-keychain",
    "--password-store=basic",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-blink-features=AutomationControlled",
    // The window mostly sits behind others; throttled timers stall generation polling.
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--window-size=1440,900",
  ];
  const proxyServer = process.env.HTTPS_PROXY ?? process.env.https_proxy;
  if (proxyServer) args.push(`--proxy-server=${proxyServer}`);
  if (config.headless) args.push("--headless=new");
  // No start URL: this profile reopens its previous tabs on launch, so a URL
  // here would add one more tab on every start.

  const stale = readDevToolsEndpoint(profileDir);
  // On this Mac a cold start of the profile's Chrome has taken 80-90 s before
  // its debugging port showed up. A retry in that window used to spawn one
  // more Chrome each time; now it waits for the one already starting.
  const early = { reason: null as string | null };
  if (profileBrowserRunning(profileDir)) {
    log.info(`Shared browser for ${profileDir} is still starting, waiting for it`);
  } else {
    spawnShared(profileDir, args, early);
  }

  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline && !early.reason) {
    await new Promise((r) => setTimeout(r, 500));
    const endpoint = readDevToolsEndpoint(profileDir);
    if (!endpoint || endpoint === stale) continue;
    const browser = await connectToProfile(profileDir);
    if (browser) return browser;
  }
  throw new Error(
    `The shared browser for ${profileDir} did not come up (${early.reason ?? "timed out"}). ` +
      `If another Chrome already holds this profile, e.g. one started by an older bridge in ` +
      `another Claude session, close that window or restart that session, then retry.`
  );
}

/** True if a Chrome main process for this profile is alive, ready or not. */
function profileBrowserRunning(profileDir: string): boolean {
  try {
    return execFileSync("ps", ["-axo", "command="], { encoding: "utf8" })
      .split("\n")
      .some((cmd) => cmd.includes(`--user-data-dir=${profileDir} `) && !cmd.includes("--type="));
  } catch {
    return false;
  }
}

function spawnShared(profileDir: string, args: string[], early: { reason: string | null }): void {
  log.info(`Starting shared browser (profile: ${profileDir}, headless: ${config.headless})`);
  const child = spawn(config.executablePath ?? chromium.executablePath(), args, {
    detached: true,
    stdio: "ignore",
  });
  child.on("error", (err) => (early.reason = String(err)));
  // Exit code 0 at once means another Chrome already had the profile and took
  // over. If that is a shared browser another bridge process is starting right
  // now, its port shows up shortly, so only other exit codes stop the wait.
  child.on("exit", (code) => {
    if (code !== 0) early.reason = `exit code ${code}`;
  });
  child.unref();
}

export const browserManager = new BrowserManager();
