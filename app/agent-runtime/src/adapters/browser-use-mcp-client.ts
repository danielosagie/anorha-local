import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: number;
  result: any;
}

interface JsonRpcFailure {
  jsonrpc: "2.0";
  id: number;
  error: { code: number; message: string; data?: unknown };
}

type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

interface MCPPending {
  resolve: (value: any) => void;
  reject: (reason?: unknown) => void;
  timeout: NodeJS.Timeout;
}

interface MCPTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface BrowserUseMcpRunResult {
  success: boolean;
  summary: string;
  data?: unknown;
}

export interface BrowserUseMcpRunHooks {
  onStatus?: (message: string) => void;
  onToolCall?: (name: string, args: Record<string, unknown>) => void;
  onToolResult?: (name: string, result: unknown) => void;
  onLog?: (channel: "stdout" | "stderr", message: string) => void;
}

interface ToolCallCandidate {
  name: string;
  args: Record<string, unknown>;
}

export class BrowserUseMcpClient {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private readonly command: string;
  private readonly initTimeoutMs: number;
  private readonly toolTimeoutMs: number;
  private readonly extraEnv: Record<string, string>;
  private readonly stderrLines: string[] = [];
  private readonly stdoutLines: string[] = [];
  private readonly pending = new Map<number, MCPPending>();
  private nextID = 1;
  private inputBuffer = Buffer.alloc(0);
  private initialized = false;
  private tools: MCPTool[] = [];
  private runHooks: BrowserUseMcpRunHooks | null = null;

  constructor(command: string, initTimeoutMs: number, toolTimeoutMs: number, extraEnv?: Record<string, string>) {
    this.command = command;
    this.initTimeoutMs = initTimeoutMs;
    this.toolTimeoutMs = toolTimeoutMs;
    this.extraEnv = extraEnv || {};
  }

  async runTask(
    task: string,
    metadata: Record<string, unknown>,
    hooks?: BrowserUseMcpRunHooks,
  ): Promise<BrowserUseMcpRunResult> {
    this.runHooks = hooks || null;
    try {
    await this.ensureInitialized();

    const candidates = this.buildToolCandidates(task, metadata);
    if (!candidates.length) {
      throw new Error("Browser-Use MCP server exposed no agent task tool. Refusing to call low-level browser tools directly.");
    }

    const errors: string[] = [];
    this.runHooks?.onStatus?.("Browser-Use MCP initialized. Running browser task...");
    for (const candidate of candidates) {
      try {
        this.runHooks?.onToolCall?.(candidate.name, candidate.args);
        const out = await this.callTool(candidate.name, candidate.args);
        this.runHooks?.onToolResult?.(candidate.name, out);
        const summary = this.extractText(out) || "Browser task completed.";
        const isError = Boolean((out as { isError?: boolean })?.isError);
        const plannerFailure = this.isDeterministicPlannerFailure(summary) ||
          this.isDeterministicPlannerFailure(JSON.stringify(out));
        if (isError || plannerFailure) {
          const errText = this.extractErrorText(out) || summary || "Browser-Use tool returned an error.";
          throw new Error(errText);
        }
        return {
          success: !plannerFailure,
          summary,
          data: out,
        };
      } catch (err) {
        const errText = this.stringifyError(err);
        errors.push(`${candidate.name}: ${errText}`);
        if (this.shouldAbortRetries(errText)) {
          throw new Error(errText);
        }
        this.runHooks?.onStatus?.(`Retrying Browser-Use agent after error: ${errText}`);
      }
    }

    throw new Error(`Browser-Use MCP tool call failed. Attempts: ${errors.slice(0, 8).join("; ")}`);
    } finally {
      this.runHooks = null;
    }
  }

  stderrTail(): string {
    return this.stderrLines.slice(-8).join(" | ");
  }

  stdoutTail(): string {
    return this.stdoutLines.slice(-8).join(" | ");
  }

  async close(): Promise<void> {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Browser-Use MCP client closed."));
    }
    this.pending.clear();

    if (!this.proc) {
      return;
    }

    const proc = this.proc;
    this.proc = null;
    this.initialized = false;
    this.tools = [];

    if (!proc.killed) {
      proc.kill("SIGTERM");
    }
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized && this.proc && !this.proc.killed) {
      return;
    }

    await this.startProcess();

    const initResult = await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: {
        name: "anorha-agent-runtime",
        version: "0.1.0",
      },
    }, this.initTimeoutMs);

    if (!initResult) {
      throw new Error("Browser-Use MCP initialize returned empty response.");
    }

    this.notify("notifications/initialized", {});
    const listed = await this.request("tools/list", {}, this.initTimeoutMs);
    const tools = Array.isArray((listed as { tools?: unknown[] })?.tools)
      ? ((listed as { tools?: unknown[] }).tools as MCPTool[])
      : [];
    this.tools = tools;
    this.initialized = true;
  }

  private async startProcess(): Promise<void> {
    if (this.proc && !this.proc.killed) {
      return;
    }

    this.stderrLines.length = 0;
    this.stdoutLines.length = 0;
    this.inputBuffer = Buffer.alloc(0);

    const proc = spawn(this.command, {
      shell: true,
      stdio: "pipe",
      env: {
        ...process.env,
        ...this.extraEnv,
      },
    });
    this.proc = proc;

    proc.stdout.on("data", (chunk: Buffer | string) => {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      this.inputBuffer = Buffer.concat([this.inputBuffer, data]);
      this.parseIncoming();
    });

    proc.stderr.on("data", (chunk: Buffer | string) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      this.pushLogLines(this.stderrLines, text);
      const compact = text.trim();
      if (compact) {
        // eslint-disable-next-line no-console
        console.warn(`[browser-use][mcp] ${compact}`);
        this.emitLog("stderr", compact);
      }
    });

    proc.on("error", (error) => {
      const msg = `spawn error: ${this.stringifyError(error)}`;
      this.pushLogLines(this.stderrLines, msg);
      this.rejectAllPending(new Error(msg));
    });

    proc.on("exit", (code, signal) => {
      const msg = `process exited (code=${code ?? "null"}, signal=${signal ?? "null"})`;
      this.pushLogLines(this.stderrLines, msg);
      this.rejectAllPending(new Error(`Browser-Use MCP ${msg}`));
      this.proc = null;
      this.initialized = false;
      this.tools = [];
    });
  }

  private parseIncoming(): void {
    while (this.inputBuffer.length > 0) {
      const frameState = this.parseContentLengthFrame();
      if (frameState === "parsed") {
        continue;
      }
      if (frameState === "need-more") {
        return;
      }
      if (!this.parseJSONLine()) {
        return;
      }
    }
  }

  private parseContentLengthFrame(): "parsed" | "need-more" | "not-framed" {
    const peek = this.inputBuffer.toString("utf8", 0, Math.min(this.inputBuffer.length, 64));
    if (!/^\s*content-length:/i.test(peek)) {
      return "not-framed";
    }

    const headerEndCRLF = this.inputBuffer.indexOf("\r\n\r\n");
    const headerEndLF = this.inputBuffer.indexOf("\n\n");
    let headerEnd = -1;
    let delimiterLength = 0;

    if (headerEndCRLF !== -1 && (headerEndLF === -1 || headerEndCRLF < headerEndLF)) {
      headerEnd = headerEndCRLF;
      delimiterLength = 4;
    } else if (headerEndLF !== -1) {
      headerEnd = headerEndLF;
      delimiterLength = 2;
    } else {
      return "need-more";
    }

    const headerText = this.inputBuffer.slice(0, headerEnd).toString("utf8");
    const lengthMatch = /content-length:\s*(\d+)/i.exec(headerText);
    if (!lengthMatch) {
      return "not-framed";
    }

    const contentLength = Number(lengthMatch[1]);
    const bodyStart = headerEnd + delimiterLength;
    const totalLength = bodyStart + contentLength;
    if (this.inputBuffer.length < totalLength) {
      return "need-more";
    }

    const body = this.inputBuffer.slice(bodyStart, totalLength).toString("utf8");
    this.inputBuffer = this.inputBuffer.slice(totalLength);
    this.handlePayload(body);
    return "parsed";
  }

  private parseJSONLine(): boolean {
    const newline = this.inputBuffer.indexOf("\n");
    if (newline === -1) {
      return false;
    }

    const line = this.inputBuffer.slice(0, newline + 1).toString("utf8");
    this.inputBuffer = this.inputBuffer.slice(newline + 1);
    const trimmed = line.trim();
    if (!trimmed) {
      return true;
    }

    this.pushLogLines(this.stdoutLines, trimmed);
    this.emitLog("stdout", trimmed);
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      this.handlePayload(trimmed);
    }
    return true;
  }

  private emitLog(channel: "stdout" | "stderr", message: string): void {
    if (!this.runHooks?.onLog) {
      return;
    }
    this.runHooks.onLog(channel, message);
  }

  private handlePayload(payload: string): void {
    let parsed: any;
    try {
      parsed = JSON.parse(payload);
    } catch {
      this.pushLogLines(this.stdoutLines, payload.trim());
      return;
    }

    if (typeof parsed?.id === "number") {
      const pending = this.pending.get(parsed.id);
      if (!pending) {
        return;
      }
      clearTimeout(pending.timeout);
      this.pending.delete(parsed.id);

      if ((parsed as JsonRpcFailure).error) {
        const err = (parsed as JsonRpcFailure).error;
        pending.reject(new Error(`MCP ${err.code}: ${err.message}`));
        return;
      }
      pending.resolve((parsed as JsonRpcSuccess).result);
      return;
    }

    // Server notifications are currently not surfaced to chat.
  }

  private request(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<any> {
    if (!this.proc || this.proc.killed) {
      throw new Error("Browser-Use MCP process is not running.");
    }

    const id = this.nextID++;
    const payload = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };

    const msg = `${JSON.stringify(payload)}\n`;
    this.proc.stdin.write(msg);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        let message = `MCP request timed out for method ${method} after ${timeoutMs}ms`;
        if (method === "initialize" && this.stdoutShowsInitServerException()) {
          message += " (likely stdio framing mismatch: server emitted exception notifications without initialize response)";
        }
        reject(new Error(message));
      }, timeoutMs);

      this.pending.set(id, {
        resolve,
        reject,
        timeout,
      });
    });
  }

  private notify(method: string, params: Record<string, unknown>): void {
    if (!this.proc || this.proc.killed) {
      return;
    }

    const payload = {
      jsonrpc: "2.0",
      method,
      params,
    };

    const msg = `${JSON.stringify(payload)}\n`;
    this.proc.stdin.write(msg);
  }

  private async callTool(name: string, args: Record<string, unknown>): Promise<any> {
    return this.request("tools/call", { name, arguments: args }, this.toolTimeoutMs);
  }

  private rankToolNames(): string[] {
    const names = this.tools.map((tool) => tool.name).filter(Boolean);
    const exactPriority = [
      "agent.run",
      "agent_run",
      "run_agent",
      "retry_with_browser_use_agent",
      "browser_use.run",
      "browser_use.run_task",
      "run",
      "task",
    ];

    const ranked: string[] = [];
    for (const preferred of exactPriority) {
      if (names.includes(preferred)) {
        ranked.push(preferred);
      }
    }

    for (const name of names) {
      if (ranked.includes(name)) {
        continue;
      }
      if (/agent|task|run/i.test(name)) {
        ranked.push(name);
      }
    }

    return ranked.filter((name) => !/^browser_(navigate|click|type|press|scroll|get_state|extract|wait|tab)/i.test(name));
  }

  private buildToolCandidates(task: string, metadata: Record<string, unknown>): ToolCallCandidate[] {
    const payloadBase = {
      task,
      prompt: task,
      query: task,
      input: task,
      instruction: task,
      ...metadata,
    };
    const rankedNames = this.rankToolNames();
    const candidates: ToolCallCandidate[] = [];

    for (const name of rankedNames) {
      const tool = this.tools.find((entry) => entry.name === name);
      if (!tool || !this.isAgentTool(tool.name)) {
        continue;
      }
      const filteredVariants = this.buildSchemaFilteredVariants(tool, payloadBase);
      for (const args of filteredVariants) {
        candidates.push({ name: tool.name, args });
      }
    }

    return candidates;
  }

  private isAgentTool(name: string): boolean {
    return /agent|task|run/i.test(name) || name === "retry_with_browser_use_agent";
  }

  private buildSchemaFilteredVariants(tool: MCPTool, payloadBase: Record<string, unknown>): Record<string, unknown>[] {
    const schema = tool.inputSchema as { properties?: Record<string, unknown>; required?: string[] } | undefined;
    const propertyNames = Object.keys(schema?.properties || {});
    if (!propertyNames.length) {
      return [{ task: String(payloadBase.task || "") }];
    }

    const prioritizedSeeds: Array<Record<string, unknown>> = [
      payloadBase,
      { task: payloadBase.task, prompt: payloadBase.prompt, startUrl: payloadBase.startUrl, url: payloadBase.url },
      { task: payloadBase.task },
    ];
    const variants: Record<string, unknown>[] = [];
    for (const seed of prioritizedSeeds) {
      const args: Record<string, unknown> = {};
      for (const key of propertyNames) {
        if (typeof seed[key] !== "undefined") {
          args[key] = seed[key];
        }
      }
      if (!("task" in args) && propertyNames.includes("task")) {
        args.task = String(payloadBase.task || "");
      }
      if (!("prompt" in args) && propertyNames.includes("prompt")) {
        args.prompt = String(payloadBase.task || "");
      }
      if (!("query" in args) && propertyNames.includes("query")) {
        args.query = String(payloadBase.task || "");
      }
      if (!("instruction" in args) && propertyNames.includes("instruction")) {
        args.instruction = String(payloadBase.task || "");
      }
      if (!("input" in args) && propertyNames.includes("input")) {
        args.input = String(payloadBase.task || "");
      }
      if (this.hasRequiredFields(args, schema?.required || [])) {
        variants.push(args);
      }
    }

    const deduped = new Map<string, Record<string, unknown>>();
    for (const variant of variants) {
      deduped.set(JSON.stringify(variant), variant);
    }
    return [...deduped.values()];
  }

  private hasRequiredFields(args: Record<string, unknown>, required: string[]): boolean {
    for (const key of required) {
      const value = args[key];
      if (typeof value === "undefined" || value === null || value === "") {
        return false;
      }
    }
    return true;
  }

  private extractText(result: any): string {
    if (!result) {
      return "";
    }

    const candidates = [
      result.summary,
      result.answer,
      result.response,
      result.output,
      result.message,
      result.text,
      result.finalAnswer,
    ].filter((v) => typeof v === "string") as string[];
    if (candidates.length) {
      return candidates.find((v) => v.trim().length > 0)?.trim() || "";
    }

    const content = Array.isArray(result.content) ? result.content : [];
    const textParts: string[] = [];
    for (const item of content) {
      if (typeof item?.text === "string" && item.text.trim()) {
        textParts.push(item.text.trim());
      }
      if (typeof item === "string" && item.trim()) {
        textParts.push(item.trim());
      }
    }
    if (textParts.length) {
      return textParts.join("\n\n");
    }

    if (typeof result === "string") {
      return result.trim();
    }

    return "";
  }

  private extractErrorText(result: any): string {
    if (!result) {
      return "";
    }

    const candidates = [
      result.error,
      result.message,
      result.summary,
      result.response,
      result.text,
    ].filter((v) => typeof v === "string") as string[];

    if (candidates.length) {
      return candidates.find((v) => v.trim().length > 0)?.trim() || "";
    }

    const content = Array.isArray(result.content) ? result.content : [];
    for (const item of content) {
      if (typeof item?.text === "string" && item.text.trim()) {
        return item.text.trim();
      }
    }

    return "";
  }

  private pushLogLines(target: string[], value: string): void {
    const lines = value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (!lines.length) {
      return;
    }
    for (const line of lines) {
      target.push(line);
      if (target.length > 80) {
        target.shift();
      }
    }
  }

  private rejectAllPending(error: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private stdoutShowsInitServerException(): boolean {
    const joined = this.stdoutLines.join("\n").toLowerCase();
    return joined.includes("mcp.server.exception_handler") && joined.includes("internal server error");
  }

  private stringifyError(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    return String(error);
  }

  private shouldAbortRetries(errText: string): boolean {
    const normalized = errText.toLowerCase();
    return (
      normalized.includes("invalid_api_key") ||
      normalized.includes("incorrect api key") ||
      normalized.includes("planner_init_failed") ||
      normalized.includes("planner model") ||
      normalized.includes("chatopenai") ||
      normalized.includes("chatollama") ||
      normalized.includes("authentication") ||
      normalized.includes("api key") ||
      normalized.includes("error code: 404") ||
      normalized.includes("404") ||
      normalized.includes("model") && normalized.includes("not found") ||
      normalized.includes("unauthorized") ||
      normalized.includes("forbidden")
    );
  }

  private isDeterministicPlannerFailure(text: string): boolean {
    const normalized = (text || "").toLowerCase();
    return (
      normalized.includes("planner_init_failed") ||
      normalized.includes("planner model is empty") ||
      normalized.includes("planner_model_not_found") ||
      normalized.includes("chatopenai") ||
      normalized.includes("chatollama") ||
      normalized.includes("error code: 404") ||
      normalized.includes("authentication") ||
      normalized.includes("unauthorized") ||
      normalized.includes("api key") ||
      (normalized.includes("model") && normalized.includes("not found"))
    );
  }
}
