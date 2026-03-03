import { BrowserUseRuntimeAdapter } from "./adapters/browser-use-runtime-adapter.js";
import { PlaywrightAttachedRuntimeAdapter } from "./adapters/playwright-attached-runtime-adapter.js";
import { PlaywrightRuntimeAdapter } from "./adapters/playwright-runtime-adapter.js";
import type {
  RuntimeAdapter,
  RuntimeBackend,
  RuntimeExecutionRequest,
  RuntimeExecutionResult,
} from "./types.js";

export class RuntimeManager {
  private readonly adapters: Partial<Record<RuntimeBackend, RuntimeAdapter>>;

  constructor() {
    this.adapters = {
      browser_use_ts: new BrowserUseRuntimeAdapter(),
      playwright_attached: new PlaywrightAttachedRuntimeAdapter(),
      playwright_direct: new PlaywrightRuntimeAdapter(),
    };
  }

  private normalizeBackend(raw: unknown): RuntimeBackend {
    const value = String(raw ?? "")
      .trim()
      .toLowerCase();

    switch (value) {
      case "playwright_attached":
      case "attached":
      case "cdp":
      case "connect_over_cdp":
        return "playwright_attached";
      case "playwright_direct":
      case "playwright":
      case "direct":
        return "playwright_direct";
      case "browser_use_ts":
      case "browser_use":
      case "browser-use":
      case "browser":
      default:
        return "browser_use_ts";
    }
  }

  async execute(request: RuntimeExecutionRequest): Promise<RuntimeExecutionResult> {
    const requested = String(request.options.runtimeBackend ?? "");
    const preferred = this.normalizeBackend(request.options.runtimeBackend);
    let adapter = this.adapters[preferred];

    if (!adapter) {
      // eslint-disable-next-line no-console
      console.warn(
        `[anorha-agent-runtime] unsupported backend requested=${requested} normalized=${preferred}; falling back`,
      );
      adapter = this.adapters.browser_use_ts || this.adapters.playwright_direct;
    }

    if (!adapter) {
      throw new Error(
        `No runtime adapters are available (requested backend: ${requested || "unknown"})`,
      );
    }

    if (requested.trim() !== preferred) {
      // eslint-disable-next-line no-console
      console.log(
        `[anorha-agent-runtime] backend normalized requested=${requested} effective=${preferred}`,
      );
    }

    try {
      return await adapter.execute(request);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const shouldFallbackFromAttached =
        preferred === "playwright_attached" &&
        (message.includes("connect ECONNREFUSED") ||
          message.includes("connectOverCDP") ||
          message.includes("attached_precondition_failed:"));

      if (!shouldFallbackFromAttached) {
        throw error;
      }

      const fallback = this.adapters.browser_use_ts || this.adapters.playwright_direct;
      if (!fallback) {
        throw error;
      }

      request.emit({
        eventName: "error",
        threadId: request.threadId,
        error:
          "Attached runtime could not proceed (CDP/planner precondition). Falling back to managed browser runtime.",
      });
      // eslint-disable-next-line no-console
      console.warn(
        `[anorha-agent-runtime] attached backend unavailable (${message}); falling back to ${fallback.name}`,
      );
      return fallback.execute(request);
    }
  }

  async intervene(threadId: string): Promise<void> {
    for (const adapter of Object.values(this.adapters)) {
      if (adapter.intervene) {
        await adapter.intervene(threadId);
      }
    }
  }

  async resume(threadId: string): Promise<void> {
    for (const adapter of Object.values(this.adapters)) {
      if (adapter.resume) {
        await adapter.resume(threadId);
      }
    }
  }
}
