import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type {
  RuntimeAdapter,
  RuntimeExecutionRequest,
  RuntimeExecutionResult,
} from "../types.js";
import {
  resolveBrowserUseLaunchSpec,
  resolveBrowserUseSelection,
  type BrowserUseHealth,
  type BrowserUseLLMSelection,
} from "../browser-use-launcher.js";
import { BrowserUseMcpClient } from "./browser-use-mcp-client.js";

interface BrowserUseRunResponse {
  success: boolean;
  summary?: string;
  frames?: Array<{ summary: string; imageDataUrl?: string }>;
  data?: unknown;
  error?: string;
}

type BrowserUseMode = "mcp" | "http" | "auto";

export class BrowserUseRuntimeAdapter implements RuntimeAdapter {
  readonly name = "browser_use_ts" as const;
  private readonly baseUrl: string;
  private proc: ChildProcessWithoutNullStreams | null = null;
  private spawnError: Error | null = null;
  private startingPromise: Promise<void> | null = null;
  private lastStderr = "";
  private readonly mode: BrowserUseMode;
  private mcpClient: BrowserUseMcpClient | null = null;
  private mcpClientKey = "";
  private lastStatusMessage = "";
  private lastStatusAt = 0;

  constructor(baseUrl?: string) {
    this.baseUrl = (baseUrl || process.env.BROWSER_USE_BASE_URL || "http://127.0.0.1:9999").replace(/\/$/, "");
    this.mode = this.resolveMode(process.env.BROWSER_USE_MODE);
  }

  async execute(request: RuntimeExecutionRequest): Promise<RuntimeExecutionResult> {
    try {
      const mode = this.mode;
      if (mode === "http") {
        return await this.tryHTTPService(request);
      }

      if (mode === "mcp") {
        return await this.tryMCP(request);
      }

      try {
        return await this.tryMCP(request);
      } catch (mcpError) {
        try {
          return await this.tryHTTPService(request);
        } catch (httpError) {
          throw new Error(
            `Browser-Use runtime failed in auto mode. MCP: ${this.stringifyError(mcpError)} HTTP: ${this.stringifyError(httpError)}`,
          );
        }
      }
    } catch (error) {
      return this.buildFailureResult(request, error);
    }
  }

  private async tryMCP(request: RuntimeExecutionRequest): Promise<RuntimeExecutionResult> {
    const selection = resolveBrowserUseSelection(request);
    const launchSpec = resolveBrowserUseLaunchSpec(selection);
    const credentialHint = this.browserUseCredentialHint(request);
    if (credentialHint) {
      throw new Error(credentialHint);
    }

    const runtimeSpeed = this.resolveRuntimeSpeed(request);
    const taskPrompt = this.applyRuntimeSpeedDirective(request.message, runtimeSpeed);
    const client = await this.getMcpClient(launchSpec.command, selection.env);
    const metadata: Record<string, unknown> = {
      threadId: request.threadId,
      startUrl: request.startUrl,
      url: request.startUrl,
      providerRoute: request.options.providerRoute,
      providerModel: request.options.providerModel,
      llm: request.options.providerModel,
      model: request.options.providerModel,
      headless: request.options.headless,
      runtimeSpeed,
      transport: selection.transport,
      structuredOutputMode: selection.structuredOutputMode,
      flashMode: selection.flashMode,
      useThinking: selection.useThinking,
      runtimeSource: selection.runtimeSource,
    };

    const totalPlanSteps = 4;
    const emitStep = (step: number, status: "planned" | "running" | "success" | "failed", detail: string, ok?: boolean) => {
      const prefix = `Step ${step}/${totalPlanSteps} [${status}]`;
      request.emit({
        eventName: "tool_result",
        threadId: request.threadId,
        toolName: `runtime.step.${step}`,
        toolResult: ok,
        content: `${prefix} ${detail}`,
        toolResultData: {
          step,
          totalSteps: totalPlanSteps,
          status,
          detail,
        },
      });
    };

    const emitStatus = (message: string) => {
      const now = Date.now();
      const normalized = String(message || "").trim();
      if (!normalized) {
        return;
      }
      const sameMessage = normalized === this.lastStatusMessage;
      const minGapMs = sameMessage ? 20000 : 1200;
      if (now - this.lastStatusAt < minGapMs) {
        return;
      }
      this.lastStatusMessage = normalized;
      this.lastStatusAt = now;
      request.emit({
        eventName: "thinking",
        threadId: request.threadId,
        thinking: normalized.slice(0, 600),
      });
    };

    emitStep(1, "planned", "Understand goal and create browser action plan.", true);
    const routeLabel = request.options.providerRoute || "unknown_route";
    const modelLabel = request.options.providerModel || "default";
    emitStep(2, "planned", `Initialize MCP session and bind selected model route (${routeLabel}, ${modelLabel}).`, true);
    emitStep(3, "planned", "Execute browser actions and collect intermediate outputs.", true);
    emitStep(4, "planned", "Summarize outcome and return structured result.", true);
    this.emitSelectionTrace(request, selection, launchSpec.health);

    const contextQuestion = this.buildContextQuestion(request.message);
    if (contextQuestion) {
      request.emit({
        eventName: "tool_result",
        threadId: request.threadId,
        toolName: "runtime.context_question",
        toolResult: true,
        content: `Context check: ${contextQuestion.question} Assumption used: ${contextQuestion.assumption}`,
        toolResultData: contextQuestion,
      });
    }

    try {
      emitStep(1, "running", "Analyzing task goal and constraints.");
      emitStep(1, "success", "Task goal understood.", true);
      emitStep(2, "running", "Starting Browser-Use MCP client session.");
      request.emit({
        eventName: "tool_call",
        threadId: request.threadId,
        toolName: "browser_use",
        content: "Starting Browser-Use MCP task",
      });
      emitStep(2, "success", "MCP client session ready.", true);

      emitStep(3, "running", "Executing browser steps.");
      const result = await client.runTask(taskPrompt, metadata, {
        onStatus: (message) => emitStatus(message),
        onToolCall: (name, args) => {
          request.emit({
            eventName: "tool_call",
            threadId: request.threadId,
            toolName: `browser_use.${name}`,
            content: this.summarizeToolCall(name, args),
          });
        },
        onToolResult: (name, out) => {
          request.emit({
            eventName: "tool_result",
            threadId: request.threadId,
            toolName: `browser_use.${name}`,
            toolResult: true,
            content: this.extractRuntimeSummary(out),
            toolResultData: out,
          });
        },
        onLog: (channel, message) => {
          const plannerStatus = this.parsePlannerStatus(message);
          if (plannerStatus) {
            request.emit({
              eventName: "tool_result",
              threadId: request.threadId,
              toolName: "runtime.browser_use_planner",
              toolResult: Boolean(plannerStatus.plannerInitOk),
              content:
                `Planner provider=${String(plannerStatus.plannerProvider || selection.transport)} ` +
                `model=${String(plannerStatus.plannerModel || selection.model || "default")} ` +
                `init=${plannerStatus.plannerInitOk ? "ok" : "failed"}`,
              toolResultData: plannerStatus,
            });
            return;
          }
          const summarized = this.summarizeMcpLog(message);
          if (summarized && !this.isTransportNoise(summarized)) {
            emitStatus(summarized);
          }

          if (this.looksLikeLoginWall(message)) {
            request.emit({
              eventName: "tool_result",
              threadId: request.threadId,
              toolName: "runtime.login_required",
              toolResult: true,
              content:
                "Login wall detected. Complete sign-in in the browser window, then send 'continue' in chat to resume.",
              toolResultData: {
                kind: "login_required",
                detectedFrom: message.slice(0, 800),
              },
            });
            emitStep(3, "running", "Paused at login wall awaiting user authentication.");
          }
        },
      });
      emitStep(3, "success", "Browser execution completed.", true);
      emitStep(4, "running", "Preparing final response summary.");
      emitStep(4, "success", "Final response summary ready.", true);
      launchSpec.health.mcpBootOk = true;
      const plannerFailureCode = this.detectPlannerFailureCode(result.summary, result.data);
      const normalizedSuccess = result.success && !plannerFailureCode;
      return {
        success: normalizedSuccess,
        summary: result.summary || (normalizedSuccess ? "Browser task completed." : "Browser task failed."),
        data: this.mergeRuntimeData(selection, launchSpec.health, {
          toolResultParseable: Boolean(result.summary || result.data),
          plannerInitOk: !plannerFailureCode,
          plannerInitError: plannerFailureCode ? result.summary : "",
          failureCode: plannerFailureCode,
          raw: result.data,
        }),
        error: plannerFailureCode ? result.summary : undefined,
      };
    } catch (error) {
      emitStep(3, "failed", this.stringifyError(error), false);
      const command = launchSpec.command;
      const stderrTail = client.stderrTail();
      const stdoutTail = client.stdoutTail();
      let message = `Browser-Use MCP runtime failed using command '${command}': ${this.stringifyError(error)}`;
      if (stderrTail) {
        message += ` | stderr: ${stderrTail}`;
      }
      if (stdoutTail) {
        message += ` | stdout: ${stdoutTail}`;
      }
      if (this.stderrLooksLikeCliArgError(`${stderrTail}\n${stdoutTail}`)) {
        message += " Hint: This CLI expects `browser-use --mcp` instead of server host/port args.";
      }
      throw new Error(message);
    }
  }

  private summarizeToolCall(name: string, args: Record<string, unknown>): string {
    const task = typeof args.task === "string"
      ? args.task
      : typeof args.prompt === "string"
        ? args.prompt
        : typeof args.query === "string"
          ? args.query
          : "";
    if (task) {
      return `Browser-Use agent call (${name}): ${task.slice(0, 220)}`;
    }
    return `Browser-Use agent call (${name})`;
  }

  private summarizeMcpLog(message: string): string {
    const trimmed = (message || "").trim();
    if (!trimmed) return "";
    if (trimmed.startsWith("ANORHA_BROWSER_USE_PLANNER ")) {
      return "Planner status received";
    }

    if (trimmed.startsWith("{") && trimmed.includes("\"jsonrpc\"")) {
      try {
        const parsed = JSON.parse(trimmed) as { id?: number; method?: string; result?: unknown; error?: unknown };
        if (parsed.method) {
          return `MCP notification: ${parsed.method}`;
        }
        if (parsed.result && typeof parsed.id === "number") {
          if (typeof parsed.result === "object" && parsed.result && "tools" in (parsed.result as Record<string, unknown>)) {
            const tools = (parsed.result as { tools?: unknown[] }).tools;
            const count = Array.isArray(tools) ? tools.length : 0;
            return `Browser-Use tools available (${count})`;
          }
          return "";
        }
        if (parsed.error) {
          return `Browser-Use MCP error${typeof parsed.id === "number" ? ` (id=${parsed.id})` : ""}`;
        }
      } catch {
        // fall through to generic shortening
      }
    }

    if (trimmed.length > 260) {
      return `${trimmed.slice(0, 260)}...`;
    }
    return trimmed;
  }

  private isTransportNoise(message: string): boolean {
    const value = (message || "").toLowerCase();
    return (
      value.includes("tools available") ||
      value.includes("planner status received") ||
      value.includes("mcp response received") ||
      value.startsWith("{\"jsonrpc\"")
    );
  }

  private async getMcpClient(command: string, extraEnv: Record<string, string>): Promise<BrowserUseMcpClient> {
    const initTimeout = this.intFromEnv("BROWSER_USE_MCP_INIT_TIMEOUT_MS", 15000);
    const toolTimeout = this.intFromEnv("BROWSER_USE_MCP_TOOL_TIMEOUT_MS", 180000);
    const key = JSON.stringify({
      command,
      initTimeout,
      toolTimeout,
      extraEnv,
    });

    if (this.mcpClient && this.mcpClientKey === key) {
      return this.mcpClient;
    }

    if (this.mcpClient) {
      await this.mcpClient.close();
      this.mcpClient = null;
      this.mcpClientKey = "";
    }

    this.mcpClient = new BrowserUseMcpClient(command, initTimeout, toolTimeout, extraEnv);
    this.mcpClientKey = key;
    return this.mcpClient;
  }

  private resolveMode(raw: string | undefined): BrowserUseMode {
    const normalized = (raw || "mcp").trim().toLowerCase();
    if (normalized === "http" || normalized === "mcp" || normalized === "auto") {
      return normalized;
    }
    return "mcp";
  }

  private intFromEnv(key: string, fallback: number): number {
    const raw = Number(process.env[key]);
    return Number.isFinite(raw) && raw > 0 ? raw : fallback;
  }

  private boolEnv(key: string): boolean {
    const raw = (process.env[key] || "").trim().toLowerCase();
    return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
  }

  private shellQuote(value: string): string {
    if (/^[A-Za-z0-9._/:=-]+$/.test(value)) {
      return value;
    }
    return `'${value.replace(/'/g, `'\\''`)}'`;
  }

  private async tryHTTPService(request: RuntimeExecutionRequest): Promise<RuntimeExecutionResult> {
    const selection = resolveBrowserUseSelection(request);
    await this.ensureHTTPServiceRunning();
    const healthError = await this.checkHTTPServiceHealth();
    const runtimeSpeed = this.resolveRuntimeSpeed(request);
    const taskPrompt = this.applyRuntimeSpeedDirective(request.message, runtimeSpeed);

    const payload = {
      contractVersion: "anorha.browser-use.v1",
      threadId: request.threadId,
      task: taskPrompt,
      startUrl: request.startUrl,
      runtime: {
        headless: request.options.headless,
        modelRoute: request.options.providerRoute,
        modelName: request.options.providerModel,
        speedMode: runtimeSpeed,
      },
      features: {
        recordingEnabled: request.options.recordingEnabled,
        controlBorderEnabled: request.options.controlBorderEnabled,
      },
    };

    const routes = ["/api/v1/agent/run", "/api/agent/run", "/agent/run"];
    const routeErrors: string[] = [];
    for (const route of routes) {
      const response = await this.postJSON(route, payload);
      if (response?.ok) {
        const data = (await response.json()) as BrowserUseRunResponse;
        this.emitFrames(request, data.frames);
        return {
          success: Boolean(data.success),
          summary: data.summary || (data.success ? "Browser-Use runtime completed." : "Browser-Use runtime failed."),
          data: this.mergeRuntimeData(selection, {
            ...selection.health,
            mcpBootOk: true,
          }, data.data),
          error: data.error,
        };
      }
      if (!response) {
        routeErrors.push(`${route}: request failed`);
        continue;
      }
      let bodyText = "";
      try {
        bodyText = (await response.text()).trim();
      } catch {
        bodyText = "";
      }
      const compactBody = bodyText.length > 300 ? `${bodyText.slice(0, 300)}...` : bodyText;
      routeErrors.push(`${route}: HTTP ${response.status}${compactBody ? ` (${compactBody})` : ""}`);
    }

    const parts: string[] = [];
    if (healthError) {
      parts.push(healthError.message);
    }
    if (routeErrors.length > 0) {
      parts.push(`Run endpoint errors: ${routeErrors.join("; ")}`);
    }
    if (parts.length === 0) {
      parts.push("Browser-Use service endpoints are unavailable.");
    }
    throw new Error(parts.join(" "));
  }

  private emitFrames(request: RuntimeExecutionRequest, frames: Array<{ summary: string; imageDataUrl?: string }> | undefined): void {
    if (!Array.isArray(frames)) {
      return;
    }
    for (const frame of frames) {
      request.emitRecording({
        segmentId: `sdk-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
        threadId: request.threadId,
        timestamp: Date.now(),
        summary: String(frame.summary || "Browser frame"),
        imageDataUrl: typeof frame.imageDataUrl === "string" ? frame.imageDataUrl : undefined,
      });
    }
  }

  private async checkHTTPServiceHealth(): Promise<Error | null> {
    const healthPaths = ["/health", "/api/health", "/api/v1/health"];
    const failures: string[] = [];
    for (const p of healthPaths) {
      try {
        const res = await fetch(`${this.baseUrl}${p}`);
        if (res.ok) {
          return null;
        }
        failures.push(`${p} -> HTTP ${res.status}`);
      } catch {
        failures.push(`${p} -> request failed`);
      }
    }
    return new Error(
      `Browser-Use local service is not healthy at ${this.baseUrl}. Health checks: ${failures.join(", ")}`,
    );
  }

  private async ensureHTTPServiceRunning(): Promise<void> {
    const autostart = (process.env.BROWSER_USE_AUTOSTART || "1").toLowerCase();
    if (autostart === "0" || autostart === "false" || autostart === "off") {
      return;
    }

    const healthy = await this.checkHTTPServiceHealth();
    if (!healthy) {
      return;
    }

    if (this.startingPromise) {
      await this.startingPromise;
      return;
    }

    this.startingPromise = this.startHTTPService();
    try {
      await this.startingPromise;
    } finally {
      this.startingPromise = null;
    }
  }

  private async startHTTPService(): Promise<void> {
    const primary = this.normalizeStartCommand((process.env.BROWSER_USE_CMD || this.defaultHTTPStartCommand()).trim());
    if (!primary) {
      return;
    }

    const commands: string[] = [primary];
    const fallback = this.toServerOnlyCommand(primary);
    if (fallback && fallback !== primary) {
      commands.push(fallback);
    }

    const waitMs = this.intFromEnv("BROWSER_USE_START_TIMEOUT_MS", 20000);
    const attemptErrors: string[] = [];

    for (const command of commands) {
      if (this.proc && !this.proc.killed) {
        if (await this.waitForHealthy(waitMs)) {
          return;
        }
        this.proc.kill("SIGTERM");
        this.proc = null;
      }

      this.spawnError = null;
      this.lastStderr = "";
      this.proc = spawn(command, {
        shell: true,
        stdio: "pipe",
        env: {
          ...process.env,
          BROWSER_USE_BASE_URL: this.baseUrl,
        },
      });

      this.proc.stdout.on("data", (d) => {
        // eslint-disable-next-line no-console
        console.log(`[browser-use][http] ${String(d).trim()}`);
      });
      this.proc.stderr.on("data", (d) => {
        const line = String(d).trim();
        if (line) {
          this.lastStderr = `${this.lastStderr}\n${line}`.trim();
          // eslint-disable-next-line no-console
          console.warn(`[browser-use][http] ${line}`);
        }
      });
      this.proc.on("error", (err) => {
        this.spawnError = err;
      });
      this.proc.on("exit", () => {
        this.proc = null;
      });

      const ready = await this.waitForHealthy(waitMs);
      if (ready) {
        return;
      }

      const spawnError = this.spawnError;
      const stderrTail = this.lastStderr.split("\n").slice(-4).join(" | ");
      if (spawnError) {
        attemptErrors.push(`${command} -> spawn failed: ${String(spawnError)}`);
      } else if (stderrTail) {
        attemptErrors.push(`${command} -> ${stderrTail}`);
      } else {
        attemptErrors.push(`${command} -> Browser-Use service did not become healthy within ${waitMs}ms`);
      }

      if (this.proc && !this.proc.killed) {
        this.proc.kill("SIGTERM");
        this.proc = null;
      }
    }

    let message = `Browser-Use service did not become healthy at ${this.baseUrl}. Attempts: ${attemptErrors.join("; ")}`;
    if (this.stderrLooksLikeCliArgError(this.lastStderr)) {
      message += " Hint: Your CLI expects `browser-use server` without host/port flags.";
    }
    throw new Error(message);
  }

  private async waitForHealthy(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.spawnError) {
        return false;
      }
      const healthError = await this.checkHTTPServiceHealth();
      if (!healthError) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 600));
    }
    return false;
  }

  private defaultHTTPStartCommand(): string {
    return "uvx --from browser-use browser-use server";
  }

  private normalizeStartCommand(command: string): string {
    if (!command) {
      return command;
    }
    let normalized = command.replace(/\bbrowser-use\s+serve\b/g, "browser-use server");
    if (/\bbrowser-use\s+server\b/.test(normalized)) {
      normalized = normalized
        .replace(/\s--host(?:=|\s+)\S+/g, "")
        .replace(/\s--port(?:=|\s+)\S+/g, "")
        .replace(/\s+/g, " ")
        .trim();
    }
    return normalized;
  }

  private toServerOnlyCommand(command: string): string | null {
    if (!/\bbrowser-use\b/.test(command)) {
      return null;
    }
    if (!/\bbrowser-use\s+(server|serve)\b/.test(command)) {
      return null;
    }
    return command
      .replace(/\bbrowser-use\s+serve\b/g, "browser-use server")
      .replace(/\s--host(?:=|\s+)\S+/g, "")
      .replace(/\s--port(?:=|\s+)\S+/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  private stderrLooksLikeCliArgError(stderr: string): boolean {
    const s = stderr.toLowerCase();
    return s.includes("invalid choice") || s.includes("invalid argument") || s.includes("server_command");
  }

  private async postJSON(path: string, body: Record<string, unknown>): Promise<Response | null> {
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Anorha-Contract": "browser-use-v1",
        },
        body: JSON.stringify(body),
      });
      return res;
    } catch {
      return null;
    }
  }

  private stringifyError(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    return String(error);
  }

  private extractRuntimeSummary(value: unknown): string {
    if (!value) {
      return "Browser tool completed.";
    }
    if (typeof value === "string") {
      return value.slice(0, 500);
    }
    if (typeof value === "object") {
      try {
        const obj = value as Record<string, unknown>;
        const summary = [
          obj.summary,
          obj.message,
          obj.result,
          obj.output,
          obj.text,
        ].find((v) => typeof v === "string" && String(v).trim() !== "");
        if (typeof summary === "string") {
          return summary.slice(0, 500);
        }
        return JSON.stringify(value).slice(0, 500);
      } catch {
        return "Browser tool completed.";
      }
    }
    return "Browser tool completed.";
  }

  private buildContextQuestion(message: string): { question: string; assumption: string } | null {
    const prompt = (message || "").trim();
    if (!prompt) {
      return {
        question: "What should the task prioritize?",
        assumption: "Proceeding with balanced behavior: accuracy first, then speed.",
      };
    }

    const hasUrl = /https?:\/\//i.test(prompt);
    const hasLocation = /\b(in|near|around)\s+[a-z]/i.test(prompt) || /\b[A-Z]{2}\b/.test(prompt);
    if (!hasUrl) {
      return {
        question: "Should this run start from a specific URL?",
        assumption: "Proceeding by discovering the target page through search/navigation.",
      };
    }
    if (!hasLocation && /marketplace|nearby|local|store|listing|restaurant|shop/i.test(prompt)) {
      return {
        question: "Do you want results constrained to a specific city/state?",
        assumption: "Proceeding without a strict geo constraint unless the site enforces one.",
      };
    }
    return null;
  }

  private looksLikeLoginWall(message: string): boolean {
    const value = (message || "").toLowerCase();
    return (
      value.includes("sign in") ||
      value.includes("log in") ||
      value.includes("login") ||
      value.includes("authenticate") ||
      value.includes("verification code") ||
      value.includes("2fa") ||
      value.includes("captcha") ||
      value.includes("one-time code") ||
      value.includes("password")
    );
  }

  private resolveRuntimeSpeed(request: RuntimeExecutionRequest): "fast" | "human" {
    const value = String(request.options.runtimeSpeed || "").trim().toLowerCase();
    return value === "human" ? "human" : "fast";
  }

  private applyRuntimeSpeedDirective(task: string, speed: "fast" | "human"): string {
    const trimmedTask = String(task || "").trim();
    if (!trimmedTask) {
      return trimmedTask;
    }
    if (speed === "human") {
      return (
        "Execution mode: human-like pacing. Prefer cautious interactions and allow short waits when pages are unstable.\n\n" +
        trimmedTask
      );
    }
    return (
      "Execution mode: fast. Minimize waits, avoid unnecessary pauses, and finish as quickly as possible while preserving accuracy.\n\n" +
      trimmedTask
    );
  }

  private browserUseCredentialHint(request: RuntimeExecutionRequest): string | null {
    if (request.options.providerRoute === "local_ollama") {
      return null;
    }

    const route = request.options.providerRoute;
    const openAI = (process.env.OPENAI_API_KEY || "").trim();
    const anthropic = (process.env.ANTHROPIC_API_KEY || "").trim();
    const openRouter = (process.env.OPENROUTER_API_KEY || "").trim();
    const moonshot = (process.env.MOONSHOT_API_KEY || "").trim();
    const ollamaCloud = (process.env.OLLAMA_CLOUD_API_KEY || "").trim();

    const isPlaceholder = (value: string) => {
      const normalized = value.toLowerCase();
      return (
        normalized.startsWith("your-openai") ||
        normalized.startsWith("your_ope") ||
        normalized.startsWith("your-ope") ||
        normalized.startsWith("sk-your") ||
        normalized.includes("your-api-key-here")
      );
    };

    const hasUsable = (value: string) => Boolean(value) && !isPlaceholder(value);

    if (route === "openrouter") {
      if (hasUsable(openRouter) || hasUsable(openAI) || hasUsable(anthropic)) {
        return null;
      }
      return "Browser use (openrouter route) requires a valid OPENROUTER_API_KEY (preferred) or OPENAI_API_KEY/ANTHROPIC_API_KEY. A placeholder key was detected or no key is set.";
    }

    if (route === "kimi") {
      if (hasUsable(moonshot) || hasUsable(openAI) || hasUsable(anthropic)) {
        return null;
      }
      return "Browser use (kimi route) requires a valid MOONSHOT_API_KEY (preferred) or OPENAI_API_KEY/ANTHROPIC_API_KEY. A placeholder key was detected or no key is set.";
    }

    if (route === "ollama_cloud") {
      return null;
    }

    if (hasUsable(openAI) || hasUsable(anthropic)) {
      return null;
    }

    const cmd = resolveBrowserUseLaunchSpec(resolveBrowserUseSelection(request)).command;
    if (!/\bbrowser-use\b/.test(cmd) || !/\b--mcp\b/.test(cmd)) {
      return null;
    }

    return "Browser-Use MCP requires OPENAI_API_KEY or ANTHROPIC_API_KEY for local mode. Set one of these env vars (and use `uvx --from browser-use browser-use --mcp`) or disable Browser use for this chat.";
  }

  private emitSelectionTrace(
    request: RuntimeExecutionRequest,
    selection: BrowserUseLLMSelection,
    health: BrowserUseHealth,
  ): void {
    request.emit({
      eventName: "tool_result",
      threadId: request.threadId,
      toolName: "runtime.browser_use_config",
      toolResult: health.providerConfigOk,
      content:
        `Browser-Use config route=${selection.route} model=${selection.model || "default"} transport=${selection.transport} ` +
        `schema=${selection.structuredOutputMode} flash=${selection.flashMode ? "on" : "off"} thinking=${selection.useThinking ? "on" : "off"} source=${selection.runtimeSource}`,
      toolResultData: this.mergeRuntimeData(selection, health, {
        toolResultParseable: false,
      }),
    });
  }

  private mergeRuntimeData(
    selection: BrowserUseLLMSelection,
    health: BrowserUseHealth,
    data: unknown,
  ): Record<string, unknown> {
    const base: Record<string, unknown> = {
      providerRoute: selection.route,
      transport: selection.transport,
      model: selection.model,
      structuredOutputMode: selection.structuredOutputMode,
      flashMode: selection.flashMode,
      useThinking: selection.useThinking,
      runtimeSource: selection.runtimeSource,
      runtimeBundleFound: health.runtimeBundleFound,
      browserBundleFound: health.browserBundleFound,
      mcpBootOk: health.mcpBootOk,
      providerConfigOk: health.providerConfigOk,
    };
    if (data && typeof data === "object" && !Array.isArray(data)) {
      return {
        ...base,
        ...(data as Record<string, unknown>),
      };
    }
    if (typeof data !== "undefined") {
      base.raw = data;
    }
    return base;
  }

  private buildFailureResult(request: RuntimeExecutionRequest, error: unknown): RuntimeExecutionResult {
    const selection = resolveBrowserUseSelection(request);
    const launchSpec = resolveBrowserUseLaunchSpec(selection);
    const stderrTail = this.mcpClient?.stderrTail() || this.lastStderr.split("\n").slice(-8).join(" | ");
    const stdoutTail = this.mcpClient?.stdoutTail() || "";
    const failureCode = this.classifyFailureCode(`${this.stringifyError(error)}\n${stderrTail}\n${stdoutTail}`);

    return {
      success: false,
      summary: `Browser-Use runtime failed (${failureCode}).`,
      error: this.stringifyError(error),
      data: this.mergeRuntimeData(selection, launchSpec.health, {
        failureCode,
        stderrTail,
        stdoutTail,
      }),
    };
  }

  private classifyFailureCode(message: string): string {
    const value = (message || "").toLowerCase();
    if (!value.trim()) return "model_output_empty";
    if (value.includes("planner_model_not_found") || (value.includes("model") && value.includes("not found"))) {
      return "planner_model_not_found";
    }
    if (value.includes("planner_init_failed") || value.includes("planner init")) {
      return "planner_init_failed";
    }
    if (value.includes("json") || value.includes("schema") || value.includes("parse")) {
      return "structured_output_parse_failed";
    }
    if (value.includes("api key") || value.includes("unauthorized") || value.includes("authentication")) {
      return "provider_auth_failed";
    }
    if (value.includes("spawn") || value.includes("initialize") || value.includes("healthcheck startup")) {
      return "mcp_start_failed";
    }
    if (this.looksLikeLoginWall(value)) {
      return "login_wall_detected";
    }
    if (value.includes("no actions") || value.includes("opened") || value.includes("idle")) {
      return "browser_started_no_actions";
    }
    return "browser_started_no_actions";
  }

  private detectPlannerFailureCode(summary: string, data: unknown): string {
    const haystack = `${summary || ""}\n${JSON.stringify(data || {})}`;
    const normalized = haystack.toLowerCase();
    if (normalized.includes("planner_model_not_found") || (normalized.includes("model") && normalized.includes("not found"))) {
      return "planner_model_not_found";
    }
    if (normalized.includes("planner_init_failed") || normalized.includes("chatopenai") || normalized.includes("chatollama")) {
      return "planner_init_failed";
    }
    if (normalized.includes("api key") || normalized.includes("unauthorized") || normalized.includes("authentication")) {
      return "provider_auth_failed";
    }
    return "";
  }

  private parsePlannerStatus(message: string): Record<string, unknown> | null {
    const trimmed = (message || "").trim();
    const prefix = "ANORHA_BROWSER_USE_PLANNER ";
    if (!trimmed.startsWith(prefix)) {
      return null;
    }
    try {
      return JSON.parse(trimmed.slice(prefix.length)) as Record<string, unknown>;
    } catch {
      return {
        plannerInitOk: false,
        plannerInitError: trimmed.slice(prefix.length),
      };
    }
  }
}
