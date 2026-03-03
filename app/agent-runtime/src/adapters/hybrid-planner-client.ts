import type { ProviderRoute, RuntimeOptions } from "../types.js";

export type HybridActionType =
  | "navigate"
  | "click"
  | "type"
  | "press"
  | "scroll"
  | "extract"
  | "wait"
  | "ask_user"
  | "finish";

export interface HybridPlannerAction {
  action: HybridActionType;
  reason?: string;
  url?: string;
  selector?: string;
  elementId?: string;
  text?: string;
  key?: string;
  deltaY?: number;
  waitMs?: number;
  query?: string;
  question?: string;
  answer?: string;
}

export interface HybridPlannerRequest {
  task: string;
  step: number;
  maxSteps: number;
  page: {
    url: string;
    title: string;
    textSnippet: string;
    elements: Array<{
      id: string;
      selector: string;
      tag: string;
      role: string;
      text: string;
      placeholder: string;
      ariaLabel: string;
    }>;
  };
  history: Array<Record<string, unknown>>;
}

interface ProviderConfig {
  baseURL: string;
  apiKey: string;
  model: string;
}

const ALLOWED_ACTIONS = new Set<HybridActionType>([
  "navigate",
  "click",
  "type",
  "press",
  "scroll",
  "extract",
  "wait",
  "ask_user",
  "finish",
]);

export class HybridPlannerClient {
  private readonly route: ProviderRoute;
  private readonly model: string;

  constructor(route: ProviderRoute, model: string) {
    this.route = route;
    this.model = model.trim();
  }

  static fromOptions(options: RuntimeOptions): HybridPlannerClient {
    const route = options.providerRoute;
    const model = (options.providerModel || "").trim();
    return new HybridPlannerClient(route, model);
  }

  validatePreconditions(): string | null {
    try {
      this.providerConfig();
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  async nextAction(request: HybridPlannerRequest): Promise<HybridPlannerAction> {
    const config = this.providerConfig();
    const body = {
      model: config.model,
      temperature: 0.1,
      messages: [
        {
          role: "system",
          content:
            "You are a browser automation planner. Reply ONLY with strict JSON object. " +
            "Allowed actions: navigate, click, type, press, scroll, extract, wait, ask_user, finish. " +
            "Prefer minimal safe next step. If task is done, return finish with answer.",
        },
        {
          role: "user",
          content: JSON.stringify(request),
        },
      ],
      response_format: { type: "json_object" },
    };

    const response = await fetch(`${config.baseURL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = (await response.text()).slice(0, 500);
      if (response.status === 401 || response.status === 403) {
        throw new Error(
          `attached_precondition_failed: planner credentials rejected (${response.status}). ${text}`,
        );
      }
      throw new Error(`planner request failed (${response.status}): ${text}`);
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = payload?.choices?.[0]?.message?.content || "";
    const parsed = this.parsePlannerContent(content);
    return this.normalizeAction(parsed);
  }

  private parsePlannerContent(raw: string): Record<string, unknown> {
    const trimmed = (raw || "").trim();
    if (!trimmed) return { action: "wait", reason: "empty planner output", waitMs: 900 };

    const deFenced = trimmed
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/```$/, "")
      .trim();

    try {
      return JSON.parse(deFenced) as Record<string, unknown>;
    } catch {
      return { action: "wait", reason: "non-json planner output", waitMs: 900 };
    }
  }

  private normalizeAction(value: Record<string, unknown>): HybridPlannerAction {
    const action = String(value.action || "wait").trim().toLowerCase() as HybridActionType;
    const safe: HybridPlannerAction = {
      action: ALLOWED_ACTIONS.has(action) ? action : "wait",
      reason: this.asString(value.reason),
      url: this.asString(value.url),
      selector: this.asString(value.selector),
      elementId: this.asString(value.elementId),
      text: this.asString(value.text),
      key: this.asString(value.key),
      query: this.asString(value.query),
      question: this.asString(value.question),
      answer: this.asString(value.answer),
    };

    const deltaY = Number(value.deltaY);
    if (Number.isFinite(deltaY)) {
      safe.deltaY = Math.max(-3000, Math.min(3000, Math.trunc(deltaY)));
    }

    const waitMs = Number(value.waitMs);
    if (Number.isFinite(waitMs)) {
      safe.waitMs = Math.max(100, Math.min(10000, Math.trunc(waitMs)));
    }

    if (safe.action === "navigate" && !safe.url && safe.query) {
      safe.url = `https://www.google.com/search?q=${encodeURIComponent(safe.query)}`;
    }

    return safe;
  }

  private asString(v: unknown): string | undefined {
    if (typeof v !== "string") return undefined;
    const s = v.trim();
    return s || undefined;
  }

  private providerConfig(): ProviderConfig {
    const route = this.route;

    if (route === "local_ollama") {
      return {
        baseURL: this.normBase(process.env.BROWSER_USE_LOCAL_OPENAI_BASE_URL || "http://127.0.0.1:11434/v1"),
        apiKey: (process.env.BROWSER_USE_LOCAL_OPENAI_API_KEY || "ollama").trim(),
        model: this.model || process.env.OPENAI_MODEL || "qwen3-vl:2b",
      };
    }

    if (route === "ollama_cloud") {
      const hostBase = this.normBase((process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434").replace(/\/$/, ""));
      const cloudBase = this.normBase(process.env.OLLAMA_CLOUD_BASE_URL || `${hostBase}/v1`);
      return {
        baseURL: cloudBase,
        apiKey: (process.env.OLLAMA_CLOUD_API_KEY || "ollama").trim(),
        model: this.model || process.env.OLLAMA_CLOUD_MODEL || "qwen3-vl:235b-cloud",
      };
    }

    if (route === "openrouter") {
      const key = (process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY || "").trim();
      if (!key || this.isPlaceholder(key)) {
        throw new Error(
          "attached_precondition_failed: openrouter planner requires OPENROUTER_API_KEY (or OPENAI_API_KEY).",
        );
      }
      return {
        baseURL: this.normBase(process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1"),
        apiKey: key,
        model: this.model || "openai/gpt-4.1-mini",
      };
    }

    const kimiKey = (process.env.MOONSHOT_API_KEY || process.env.OPENAI_API_KEY || "").trim();
    if (!kimiKey || this.isPlaceholder(kimiKey)) {
      throw new Error("attached_precondition_failed: kimi planner requires MOONSHOT_API_KEY (or OPENAI_API_KEY).");
    }
    return {
      baseURL: this.normBase(process.env.MOONSHOT_BASE_URL || "https://api.moonshot.cn/v1"),
      apiKey: kimiKey,
      model: this.model || "moonshot-v1-8k-vision-preview",
    };
  }

  private normBase(value: string): string {
    return value.trim().replace(/\/$/, "");
  }

  private isPlaceholder(value: string): boolean {
    const normalized = value.toLowerCase();
    return (
      normalized.startsWith("your-openai") ||
      normalized.startsWith("your_ope") ||
      normalized.startsWith("your-ope") ||
      normalized.includes("your-api-key-here") ||
      normalized.startsWith("sk-your")
    );
  }
}
