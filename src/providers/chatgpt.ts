import { type Page } from "playwright";
import { BaseChatProvider } from "./base.js";
import type { GenerateRequest, ProviderName } from "./types.js";

/** Ends every prompt the bridge sends; a chat is archived only if it carries it. */
export const BRIDGE_MARKER = "Generate the image directly without asking clarifying questions.";

/**
 * ChatGPT web adapter (chatgpt.com). Uses the user's own logged-in session
 * from the persistent profile; image generation is requested in plain
 * language, which routes to ChatGPT's built-in image model.
 */
export class ChatGptProvider extends BaseChatProvider {
  readonly name: ProviderName = "chatgpt";
  protected readonly newChatUrl = "https://chatgpt.com/";

  protected readonly composerSelectors = [
    "#prompt-textarea",
    'div[contenteditable="true"][data-virtualkeyboard]',
    'form div[contenteditable="true"]',
    'textarea[data-testid="prompt-textarea"]',
  ];

  protected readonly sendSelectors = [
    '[data-testid="send-button"]',
    'button[aria-label*="Send" i]',
    'form button[type="submit"]',
  ];

  /** The chat's own menu (Pin / Archive / Delete) in the page header. */
  protected readonly chatMenuSelectors = [
    '[data-testid="conversation-options-button"]',
    'header button[aria-haspopup="menu"][aria-label="Ещё"]',
    'header button[aria-haspopup="menu"][aria-label="Open conversation options"]',
  ];

  // Generated images are served from OpenAI's file/asset hosts, or exist as
  // in-page blobs while rendering.
  protected readonly imageSrcMarkers = [
    // Current chatgpt.com serves finished images from its own backend proxy.
    "/backend-api/estuary/content",
    "/backend-api/content",
    "oaiusercontent.com",
    "files.openai.com",
    "openai.com/attachments",
    "blob:",
  ];

  protected async detectAuthenticated(page: Page): Promise<boolean> {
    const url = page.url();
    if (url.includes("auth.openai.com") || url.includes("/auth/")) return false;
    const loginButton = page
      .locator('[data-testid="login-button"], a[href*="/auth/login"]')
      .first();
    if (await loginButton.isVisible().catch(() => false)) return false;
    // The composer only renders for a usable session.
    return (await this.findFirst(page, this.composerSelectors)) !== null;
  }

  protected async detectBusy(page: Page): Promise<boolean> {
    // The stop button disappears while the image itself renders, so the
    // image-gen loading frame (and its progress bar) must count as busy too —
    // otherwise a running generation looks like a finished, image-less reply.
    const busy = page
      .locator(
        '[data-testid="stop-button"], button[aria-label*="Stop" i], ' +
          '[data-testid^="image-gen-loading"], main [role="progressbar"]'
      )
      .first();
    return busy.isVisible().catch(() => false);
  }

  protected buildPrompt(req: GenerateRequest): string {
    const base = req.inputImagePath
      ? `Edit the attached image: ${req.prompt}`
      : `Create an image: ${req.prompt}`;
    return base + this.aspectClause(req.aspectRatio) + ` ${BRIDGE_MARKER}`;
  }

  /**
   * Archive the chat this job just used, so bridge chats don't pile up in the
   * history; archived chats stay reachable from ChatGPT settings. Only a
   * conversation whose first message is a bridge prompt is touched, so a chat
   * the user opened in this tab is never archived.
   */
  protected async archiveChat(page: Page, req: GenerateRequest): Promise<void> {
    if (!page.url().includes("/c/")) return; // the job ended before a conversation existed
    // A new chat first lives at a temporary /c/local-chatgpt:… address; only
    // the real id can be archived.
    const realId = /\/c\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/;
    let id = realId.exec(page.url())?.[1];
    for (let i = 0; i < 15 && !id; i++) {
      await page.waitForTimeout(1000);
      id = realId.exec(page.url())?.[1];
    }
    if (!id) throw new Error(`the chat never got its real address (${page.url()})`);

    const readFirstPrompt = () =>
      page.evaluate(() => document.querySelector("[data-user-message-bubble]")?.textContent ?? "");
    let firstPrompt = await readFirstPrompt();
    let menu = await this.findFirst(page, this.chatMenuSelectors);
    // Load the chat only if it is not on screen. ChatGPT fails to load a chat
    // now and then ("Couldn't load this conversation"), hence a second try.
    for (let attempt = 0; attempt < 2 && !(firstPrompt && menu); attempt++) {
      await page.goto(`https://chatgpt.com/c/${id}`, { waitUntil: "domcontentloaded" });
      for (let i = 0; i < 15 && !(firstPrompt && menu); i++) {
        await page.waitForTimeout(1000);
        firstPrompt = await readFirstPrompt();
        menu = await this.findFirst(page, this.chatMenuSelectors);
      }
    }
    if (!firstPrompt) throw new Error(`chat ${id} did not load`);
    if (!firstPrompt.includes(BRIDGE_MARKER)) {
      req.log(`Chat ${id} left in history: its first message is not a bridge prompt`);
      return;
    }
    if (!menu) throw new Error("the chat menu button was not found; the UI may have changed");
    // The window is in plain view: make sure nobody switched this tab to another chat.
    if (!page.url().includes(id)) throw new Error(`the tab left chat ${id} before archiving`);
    // Right after archiving the chat's own menu won't open, so the proof is the
    // sidebar: an archived chat drops out of it. A new chat is always listed
    // there; an old one may not be loaded, and then success stays unconfirmed.
    const sidebarLink = page.locator(`a[href="/c/${id}"]`).first();
    const listed = (await sidebarLink.count()) > 0;
    if (!(await this.clickChatMenuItem(page, /^(Архивировать|Archive)$/i))) {
      throw new Error("the Archive item could not be clicked");
    }
    if (!listed) {
      req.log(`Chat ${id} archived, unconfirmed: it was not in the sidebar to begin with`);
      return;
    }
    const gone = await sidebarLink.waitFor({ state: "detached", timeout: 10_000 }).then(
      () => true,
      () => false
    );
    if (!gone) throw new Error(`chat ${id} is still in the sidebar after clicking Archive`);
    req.log(`Chat ${id} archived`);
  }

  /**
   * Open the chat menu and click the item matching `name`. For a while after
   * a load or a generation ChatGPT keeps re-mounting the page header: the
   * button detaches under the click and an open menu closes, so the whole
   * step is retried.
   */
  private async clickChatMenuItem(page: Page, name: RegExp): Promise<boolean> {
    const ok = (p: Promise<unknown>) => p.then(() => true, () => false);
    for (let attempt = 0; attempt < 10; attempt++) {
      const menu = await this.findFirst(page, this.chatMenuSelectors);
      const item = page.getByRole("menuitem", { name });
      if (
        menu &&
        (await ok(menu.click({ timeout: 2000 }))) &&
        (await ok(item.waitFor({ timeout: 2000 }))) &&
        (await ok(item.click({ timeout: 2000 })))
      ) {
        return true;
      }
      await page.keyboard.press("Escape").catch(() => undefined);
      await page.waitForTimeout(1000);
    }
    return false;
  }
}
