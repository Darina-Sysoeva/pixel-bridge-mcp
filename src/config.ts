import os from "node:os";
import path from "node:path";

/**
 * Runtime configuration, driven entirely by environment variables so no
 * credentials or machine-specific paths ever live in code or in git.
 */
export interface Config {
  /** Root directory for profiles + logs (default ~/.pixel-bridge). */
  home: string;
  /** Directory holding one persistent browser profile per provider. */
  profilesDir: string;
  /** Directory for logs and failure screenshots. */
  logsDir: string;
  /** Run the browser headless. Default false: image-gen sites behave better headed, and manual login needs a visible window. */
  headless: boolean;
  /**
   * Optional Playwright browser channel, e.g. "chrome" or "msedge".
   * Using the real installed Chrome tends to be more stable with consumer
   * web apps than the bundled Chromium. Empty = bundled Chromium.
   */
  browserChannel: string | undefined;
  /** Optional explicit browser executable path (overrides channel/bundled Chromium). */
  executablePath: string | undefined;
  /**
   * Attach mode: connect to an already-running browser you started yourself
   * (e.g. chrome --remote-debugging-port=9222 --user-data-dir=...), instead
   * of launching one. Your existing logins in that browser are used as-is.
   * Example: http://127.0.0.1:9222
   */
  cdpUrl: string | undefined;
  /**
   * Shared mode (default on): one browser per provider profile that outlives
   * any single bridge process. The first call starts it detached with a
   * remote-debugging port; later processes find it through the profile's
   * DevToolsActivePort file and attach. A process closes only its own tab on
   * shutdown, so the window stays until the user closes it.
   * PIXEL_BRIDGE_SHARED_BROWSER=0 restores one browser per process.
   */
  sharedBrowser: boolean;
  /** Hard ceiling for a single generation job, in ms. */
  generationTimeoutMs: number;
  /** Default time generate_image waits inline before returning a job id, in ms. */
  defaultWaitMs: number;
  /** How long provider_login waits for manual authentication, in ms. */
  loginTimeoutMs: number;
  /**
   * How long checkSession waits for the signed-in UI to appear before
   * reporting "not authenticated", in ms. Chat SPAs render the composer
   * seconds after domcontentloaded, so a single immediate probe on a cold
   * start reports a perfectly good session as logged out.
   */
  sessionCheckTimeoutMs: number;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return !["0", "false", "no", "off"].includes(raw.toLowerCase());
}

export function loadConfig(): Config {
  const home =
    process.env.PIXEL_BRIDGE_HOME ?? path.join(os.homedir(), ".pixel-bridge");
  return {
    home,
    profilesDir: process.env.PIXEL_BRIDGE_PROFILE_DIR ?? path.join(home, "profiles"),
    logsDir: path.join(home, "logs"),
    headless: envBool("PIXEL_BRIDGE_HEADLESS", false),
    browserChannel: process.env.PIXEL_BRIDGE_BROWSER_CHANNEL || undefined,
    executablePath: process.env.PIXEL_BRIDGE_EXECUTABLE_PATH || undefined,
    cdpUrl: process.env.PIXEL_BRIDGE_CDP_URL || undefined,
    sharedBrowser: envBool("PIXEL_BRIDGE_SHARED_BROWSER", true),
    generationTimeoutMs: envInt("PIXEL_BRIDGE_GENERATION_TIMEOUT_S", 300) * 1000,
    defaultWaitMs: envInt("PIXEL_BRIDGE_DEFAULT_WAIT_S", 150) * 1000,
    loginTimeoutMs: envInt("PIXEL_BRIDGE_LOGIN_TIMEOUT_S", 300) * 1000,
    sessionCheckTimeoutMs: envInt("PIXEL_BRIDGE_SESSION_CHECK_TIMEOUT_S", 20) * 1000,
  };
}

export const config = loadConfig();
