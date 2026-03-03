import type {
  RuntimeAdapter,
  RuntimeExecutionRequest,
  RuntimeExecutionResult,
} from "../types.js";

export class PlaywrightRuntimeAdapter implements RuntimeAdapter {
  readonly name = "playwright_direct" as const;

  async execute(request: RuntimeExecutionRequest): Promise<RuntimeExecutionResult> {
    const playwright = await this.loadPlaywright();
    if (!playwright) {
      throw new Error("Playwright dependency is unavailable for fallback runtime.");
    }

    request.emit({
      eventName: "tool_call",
      threadId: request.threadId,
      toolName: "runtime.playwright_direct",
      content: "Running Playwright fallback runtime",
    });

    const browser = await playwright.chromium.launch({ headless: request.options.headless });
    let page: any;
    try {
      const context = await browser.newContext();
      page = await context.newPage();

      request.emit({
        eventName: "control_state",
        threadId: request.threadId,
        controlled: true,
        runtime: this.name,
      });

      if (request.options.controlBorderEnabled) {
        await this.injectControlBorder(page);
      }

      const url = request.startUrl || "https://example.com";
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });

      if (request.options.recordingEnabled) {
        const first = await page.screenshot({ type: "jpeg", quality: 60 });
        request.emitRecording({
          segmentId: `pw-${Date.now()}-1`,
          threadId: request.threadId,
          timestamp: Date.now(),
          summary: `Opened ${url}`,
          imageDataUrl: `data:image/jpeg;base64,${Buffer.from(first).toString("base64")}`,
        });
      }

      await page.waitForTimeout(600);
      await page.mouse.wheel(0, 450);
      await page.waitForTimeout(400);

      if (request.options.recordingEnabled) {
        const second = await page.screenshot({ type: "jpeg", quality: 60 });
        request.emitRecording({
          segmentId: `pw-${Date.now()}-2`,
          threadId: request.threadId,
          timestamp: Date.now(),
          summary: "Scrolled page",
          imageDataUrl: `data:image/jpeg;base64,${Buffer.from(second).toString("base64")}`,
        });
      }

      return {
        success: true,
        summary: "Playwright fallback runtime completed.",
        data: {
          url: page.url(),
          title: await page.title(),
        },
      };
    } finally {
      request.emit({
        eventName: "control_state",
        threadId: request.threadId,
        controlled: false,
        runtime: this.name,
      });
      await browser.close();
    }
  }

  private async loadPlaywright(): Promise<any | null> {
    try {
      return await import("playwright");
    } catch {
      return null;
    }
  }

  private async injectControlBorder(page: any): Promise<void> {
    await page.addInitScript(() => {
      const apply = () => {
        const id = "anorha-agent-control-border";
        if (document.getElementById(id)) return;
        const border = document.createElement("div");
        border.id = id;
        border.style.position = "fixed";
        border.style.inset = "0";
        border.style.pointerEvents = "none";
        border.style.border = "5px solid #22c55e";
        border.style.boxSizing = "border-box";
        border.style.zIndex = "2147483647";

        const chip = document.createElement("div");
        chip.style.position = "fixed";
        chip.style.top = "14px";
        chip.style.right = "14px";
        chip.style.padding = "6px 10px";
        chip.style.fontFamily = "ui-sans-serif, system-ui";
        chip.style.fontSize = "12px";
        chip.style.fontWeight = "700";
        chip.style.background = "#22c55e";
        chip.style.color = "#052e16";
        chip.style.borderRadius = "999px";
        chip.style.zIndex = "2147483647";
        chip.textContent = "Agent Controlled";

        document.documentElement.appendChild(border);
        document.documentElement.appendChild(chip);
      };
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", apply, { once: true });
      } else {
        apply();
      }
    });
  }
}
