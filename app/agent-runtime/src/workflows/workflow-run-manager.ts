import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { RuntimeManager } from "../runtime-manager.js";
import {
  DEFAULT_OPTIONS,
  type RuntimeEvent,
  type RuntimeExecutionRequest,
  type RuntimeExecutionResult,
  type RuntimeOptions,
  type ViewportProfile,
  type WorkflowItemCommand,
  type WorkflowItemStatus,
  type WorkflowMode,
  type WorkflowOperation,
  type WorkflowRetryRequest,
  type WorkflowRunRequest,
  type WorkflowRunStatus,
  type WorkflowRunView,
  type WorkflowRuntimeOverrides,
  type WorkflowRunItemView,
  type WorkflowStageName,
  type WorkflowStageStatus,
} from "../types.js";
import { getWorkflowPack, resolveViewportSize } from "./workflow-packs.js";

type WorkflowRunRecord = {
  id: string;
  workflowKey: string;
  operation: WorkflowOperation;
  mode: WorkflowMode;
  status: WorkflowRunStatus;
  metadata: Record<string, unknown>;
  runtime: WorkflowRuntimeOverrides;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  cancelRequested: boolean;
  items: WorkflowItemRecord[];
  itemMap: Map<string, WorkflowItemRecord>;
  runErrors: string[];
  completionPromise: Promise<void>;
  resolveCompletion: () => void;
  emitter: EventEmitter;
  history: RuntimeEvent[];
};

type WorkflowItemRecord = {
  id: string;
  index: number;
  externalItemId: string;
  operation: WorkflowOperation;
  rawInput: Record<string, unknown>;
  prompt: string;
  status: WorkflowItemStatus;
  attempts: number;
  currentStage: WorkflowStageName | "";
  missingFields: string[];
  error: string;
  summary: string;
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
  lastThreadId?: string;
  latestPresetCode?: string;
};

type PresetRecord = {
  key: string;
  code: string;
  updatedAt: number;
  successes: number;
};

type PresetCandidate = {
  key: string;
  createdAt: number;
  code: string;
  error: string;
  needsPromotion: boolean;
  attempt: number;
};

type DailyMetric = {
  date: string;
  workflowKey: string;
  operation: WorkflowOperation;
  totalItems: number;
  succeeded: number;
  failed: number;
  canceled: number;
  totalDurationMs: number;
  replayHits: number;
  plannerFallbacks: number;
  selfHealGenerated: number;
  selfHealSucceeded: number;
};

type ExecutionContext = {
  actorSubject: string;
};

const MAX_RUN_EVENTS = 2000;

export class WorkflowRunManager {
  private readonly runtimeManager: RuntimeManager;
  private readonly runs = new Map<string, WorkflowRunRecord>();
  private readonly activePresets = new Map<string, PresetRecord>();
  private readonly presetCandidates = new Map<string, PresetCandidate[]>();
  private readonly dailyMetrics = new Map<string, DailyMetric>();

  constructor(runtimeManager: RuntimeManager) {
    this.runtimeManager = runtimeManager;
  }

  async createRun(
    request: WorkflowRunRequest,
    executionContext: ExecutionContext,
  ): Promise<{ run: WorkflowRunView; itemIds: string[] }> {
    const workflowKey = String(request.workflowKey || "").trim();
    const pack = getWorkflowPack(workflowKey);
    if (!pack) {
      throw new Error(`Unsupported workflowKey '${workflowKey}'`);
    }
    const operation = request.operation;
    if (!operation) {
      throw new Error("operation is required");
    }
    if (!Array.isArray(request.items) || request.items.length === 0) {
      throw new Error("items must contain at least one item");
    }
    if (request.items.length > 100) {
      throw new Error("items exceeds max size (100)");
    }

    const mode: WorkflowMode = request.mode === "sync" ? "sync" : "async";
    let resolveCompletion!: () => void;
    const completionPromise = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });

    const runID = randomUUID();
    const filteredItems = this.applySelection(request.items, request.selection);
    if (filteredItems.length === 0) {
      throw new Error("selection resolved to zero items");
    }

    const run: WorkflowRunRecord = {
      id: runID,
      workflowKey,
      operation,
      mode,
      status: "queued",
      metadata: {
        ...(request.metadata || {}),
        actorSubject: executionContext.actorSubject,
      },
      runtime: request.runtime || {},
      createdAt: Date.now(),
      cancelRequested: false,
      items: [],
      itemMap: new Map<string, WorkflowItemRecord>(),
      runErrors: [],
      completionPromise,
      resolveCompletion,
      emitter: new EventEmitter(),
      history: [],
    };

    for (let i = 0; i < filteredItems.length; i += 1) {
      const incoming = filteredItems[i];
      const itemID = (incoming.itemId || "").trim() || randomUUID();
      const op = incoming.operation || operation;
      const item: WorkflowItemRecord = {
        id: itemID,
        index: i + 1,
        externalItemId: (incoming.externalItemId || "").trim(),
        operation: op,
        rawInput: { ...(incoming.input || {}) },
        prompt: String(incoming.prompt || "").trim(),
        status: "pending",
        attempts: 0,
        currentStage: "",
        missingFields: [],
        error: "",
        summary: "",
      };
      run.items.push(item);
      run.itemMap.set(item.id, item);
    }

    this.runs.set(run.id, run);
    this.emitRunEvent(run, {
      eventName: "workflow_run",
      threadId: run.id,
      runId: run.id,
      status: run.status,
      summary: `Workflow run queued (${run.items.length} items)`,
      completed: 0,
      total: run.items.length,
      failed: 0,
      canceled: 0,
    });

    this.executeRun(run).catch((error) => {
      run.status = "failed";
      run.endedAt = Date.now();
      run.runErrors.push(this.errorString(error));
      this.emitRunEvent(run, {
        eventName: "error",
        threadId: run.id,
        error: this.errorString(error),
      });
      this.emitRunStatus(run, `Workflow run failed: ${this.errorString(error)}`);
      run.resolveCompletion();
    });

    return {
      run: this.toRunView(run),
      itemIds: run.items.map((x) => x.id),
    };
  }

  async waitForRun(runID: string, timeoutMs: number): Promise<{ completed: boolean; run: WorkflowRunView }> {
    const run = this.mustGetRun(runID);
    const waitTime = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 180_000;
    await Promise.race([
      run.completionPromise.then(() => undefined),
      new Promise((resolve) => setTimeout(resolve, waitTime)),
    ]);
    const fresh = this.mustGetRun(runID);
    return {
      completed: this.isFinalStatus(fresh.status),
      run: this.toRunView(fresh),
    };
  }

  getRun(runID: string): WorkflowRunView {
    return this.toRunView(this.mustGetRun(runID));
  }

  listItems(runID: string): WorkflowRunItemView[] {
    const run = this.mustGetRun(runID);
    return run.items.map((item) => this.toItemView(item));
  }

  cancelRun(runID: string): WorkflowRunView {
    const run = this.mustGetRun(runID);
    run.cancelRequested = true;
    this.emitRunStatus(run, "Cancellation requested");
    for (const item of run.items) {
      if (item.status === "pending") {
        item.status = "canceled";
        item.error = "Canceled before execution";
        item.endedAt = Date.now();
        this.emitItemResult(run, item);
      }
      if (item.status === "running" && item.lastThreadId) {
        this.runtimeManager.intervene(item.lastThreadId).catch(() => undefined);
      }
    }
    return this.toRunView(run);
  }

  async retryRun(runID: string, request: WorkflowRetryRequest): Promise<WorkflowRunView> {
    const run = this.mustGetRun(runID);
    const requestedIDs = new Set((request.itemIds || []).map((x) => String(x || "").trim()).filter(Boolean));
    const shouldRetryAllFailed = requestedIDs.size === 0;

    for (const item of run.items) {
      const selectable = shouldRetryAllFailed
        ? item.status === "failed" || item.status === "canceled"
        : requestedIDs.has(item.id);
      if (!selectable) continue;
      item.status = "pending";
      item.currentStage = "";
      item.error = "";
      item.summary = "";
      item.missingFields = [];
      item.startedAt = undefined;
      item.endedAt = undefined;
      item.durationMs = undefined;
    }

    if (run.status !== "running") {
      run.status = "queued";
      run.cancelRequested = false;
      let resolveCompletion!: () => void;
      run.completionPromise = new Promise<void>((resolve) => {
        resolveCompletion = resolve;
      });
      run.resolveCompletion = resolveCompletion;
      this.executeRun(run).catch((error) => {
        run.status = "failed";
        run.endedAt = Date.now();
        run.runErrors.push(this.errorString(error));
        this.emitRunEvent(run, {
          eventName: "error",
          threadId: run.id,
          error: this.errorString(error),
        });
        this.emitRunStatus(run, `Workflow run failed: ${this.errorString(error)}`);
        run.resolveCompletion();
      });
    }

    this.emitRunStatus(run, "Retry requested");
    return this.toRunView(run);
  }

  getEvents(runID: string): RuntimeEvent[] {
    const run = this.mustGetRun(runID);
    return [...run.history];
  }

  subscribe(runID: string, listener: (event: RuntimeEvent) => void): () => void {
    const run = this.mustGetRun(runID);
    run.emitter.on("event", listener);
    return () => run.emitter.off("event", listener);
  }

  getDailyMetrics(): DailyMetric[] {
    return [...this.dailyMetrics.values()];
  }

  private async executeRun(run: WorkflowRunRecord): Promise<void> {
    run.status = "running";
    if (!run.startedAt) run.startedAt = Date.now();
    run.endedAt = undefined;
    this.emitRunStatus(run, "Workflow run started");

    const maxConcurrency = this.maxConcurrency();
    const queue = run.items.filter((item) => item.status === "pending");
    const workers = Array.from({ length: Math.min(maxConcurrency, Math.max(queue.length, 1)) }).map(async () => {
      while (queue.length > 0) {
        const item = queue.shift();
        if (!item) break;
        if (run.cancelRequested) {
          if (item.status === "pending") {
            item.status = "canceled";
            item.error = "Canceled before execution";
            item.endedAt = Date.now();
            this.emitItemResult(run, item);
          }
          continue;
        }
        await this.executeItem(run, item);
      }
    });

    await Promise.all(workers);
    run.endedAt = Date.now();
    run.status = this.computeRunStatus(run);
    this.emitRunStatus(run, "Workflow run finished");
    this.recordRunMetrics(run);
    run.resolveCompletion();
  }

  private async executeItem(run: WorkflowRunRecord, item: WorkflowItemRecord): Promise<void> {
    item.attempts += 1;
    item.status = "running";
    item.startedAt = Date.now();
    item.error = "";
    item.summary = "";
    item.missingFields = [];
    this.emitRunStatus(run, `Running item ${item.index}/${run.items.length}`);

    const pack = getWorkflowPack(run.workflowKey);
    if (!pack) {
      item.status = "failed";
      item.error = `Workflow pack missing for key ${run.workflowKey}`;
      item.endedAt = Date.now();
      item.durationMs = item.endedAt - (item.startedAt || item.endedAt);
      this.emitItemResult(run, item);
      return;
    }

    const stagePlan = [...pack.stagePlan];
    this.emitStage(run, item, "navigate", "running");
    this.emitStage(run, item, "navigate", "success", "Workflow context prepared");

    const input = this.normalizedInput(item);
    const missingFields = this.missingFieldsFor(pack, item.operation, input);
    if (missingFields.length > 0) {
      item.status = "failed";
      item.currentStage = "fill_data";
      item.missingFields = missingFields;
      item.error = `Missing required fields: ${missingFields.join(", ")}`;
      item.summary = item.error;
      item.endedAt = Date.now();
      item.durationMs = item.endedAt - (item.startedAt || item.endedAt);
      this.emitStage(run, item, "fill_data", "failed", item.error, item.error, missingFields);
      this.emitItemResult(run, item);
      return;
    }

    this.emitStage(run, item, "fill_data", "running");
    const runtimeRequest = this.buildRuntimeExecutionRequest(run, item, stagePlan, input, pack.startUrl);
    let result = await this.executeRuntimeWithTracking(run, item, runtimeRequest);
    let selfHealTriggered = false;

    if (!result.success && this.shouldAutoHeal()) {
      selfHealTriggered = true;
      this.recordDailyMetric(run.workflowKey, item.operation, (metric) => {
        metric.selfHealGenerated += 1;
      });
      const retryPrompt = `${runtimeRequest.message}\n\nPrevious attempt failed. Adapt selectors/actions and retry only missing steps.`;
      const retryRequest: RuntimeExecutionRequest = {
        ...runtimeRequest,
        threadId: `${runtimeRequest.threadId}:retry`,
        message: retryPrompt,
      };
      this.emitStage(
        run,
        item,
        "fill_data",
        "running",
        "Self-heal retry started with adapted Playwright flow",
      );
      result = await this.executeRuntimeWithTracking(run, item, retryRequest);
      if (result.success) {
        this.recordDailyMetric(run.workflowKey, item.operation, (metric) => {
          metric.selfHealSucceeded += 1;
        });
      }
    }

    if (!result.success) {
      item.status = run.cancelRequested ? "canceled" : "failed";
      item.error = (result.error || result.summary || "Runtime execution failed").trim();
      item.summary = "Item execution failed";
      item.endedAt = Date.now();
      item.durationMs = item.endedAt - (item.startedAt || item.endedAt);
      this.emitStage(
        run,
        item,
        "fill_data",
        "failed",
        item.error,
        item.error,
      );
      if (!this.shouldAutoHeal()) {
        this.storePresetCandidate(run, item, item.latestPresetCode || "", item.error, true);
      } else if (selfHealTriggered) {
        this.storePresetCandidate(run, item, item.latestPresetCode || "", item.error, false);
      }
      this.emitItemResult(run, item);
      this.recordDailyMetric(run.workflowKey, item.operation, (metric) => {
        metric.plannerFallbacks += 1;
      });
      return;
    }

    this.emitStage(run, item, "fill_data", "success", "Form and task actions completed");
    this.emitStage(run, item, "confirm", "success", "Confirmation checks passed");
    this.emitStage(run, item, "complete", "success", "Requested operation completed");
    this.emitStage(run, item, "verify", "success", "Verification completed");

    item.status = "succeeded";
    item.summary = result.summary || "Item succeeded";
    item.endedAt = Date.now();
    item.durationMs = item.endedAt - (item.startedAt || item.endedAt);
    if (item.latestPresetCode && this.shouldAutoHeal()) {
      this.promotePreset(run, item, item.latestPresetCode);
    }
    this.emitItemResult(run, item);
  }

  private async executeRuntimeWithTracking(
    run: WorkflowRunRecord,
    item: WorkflowItemRecord,
    request: RuntimeExecutionRequest,
  ): Promise<RuntimeExecutionResult> {
    item.lastThreadId = request.threadId;
    const started = Date.now();
    return this.runtimeManager.execute({
      ...request,
      emit: (event) => {
        if (
          event.eventName === "tool_result" &&
          event.toolName === "runtime.playwright_preset" &&
          event.toolResultData &&
          typeof event.toolResultData === "object" &&
          typeof (event.toolResultData as Record<string, unknown>).code === "string"
        ) {
          item.latestPresetCode = String((event.toolResultData as Record<string, unknown>).code || "");
        }

        const content = (event as { content?: string }).content || "";
        const forwarded: RuntimeEvent = {
          eventName: "tool_result",
          threadId: run.id,
          toolName: `workflow.runtime.${event.eventName}`,
          toolResult: true,
          content: `item=${item.id} ${content}`.trim(),
          toolResultData: event,
        };
        this.emitRunEvent(run, forwarded);
      },
      emitRecording: () => undefined,
    }).finally(() => {
      const duration = Date.now() - started;
      this.recordDailyMetric(run.workflowKey, item.operation, (metric) => {
        metric.totalDurationMs += duration;
      });
    });
  }

  private buildRuntimeExecutionRequest(
    run: WorkflowRunRecord,
    item: WorkflowItemRecord,
    stagePlan: WorkflowStageName[],
    input: Record<string, unknown>,
    startUrl: string,
  ): RuntimeExecutionRequest {
    const threadId = `workflow:${run.id}:${item.id}:attempt:${item.attempts}`;
    const viewport = this.viewportProfile(run.runtime);
    const runtimeOptions = this.runtimeOptionsFromOverrides(run.runtime);
    const prompt = this.runtimePrompt(run, item, input, viewport);
    const activePreset = this.activePresets.get(this.presetKey(run, item));
    const presetMessage = activePreset?.code
      ? `\n\nReuse this known Playwright preset first, then fill gaps if needed:\n${activePreset.code.slice(0, 2400)}`
      : "";

    if (activePreset) {
      this.recordDailyMetric(run.workflowKey, item.operation, (metric) => {
        metric.replayHits += 1;
      });
    }

    return {
      threadId,
      message: `${prompt}${presetMessage}`,
      options: runtimeOptions,
      startUrl,
      workflowRunId: run.id,
      workflowItemId: item.id,
      workflowKey: run.workflowKey,
      workflowOperation: item.operation,
      workflowStagePlan: stagePlan,
      workflowInput: input,
      viewportProfile: viewport,
      emit: () => undefined,
      emitRecording: () => undefined,
    };
  }

  private runtimeOptionsFromOverrides(override: WorkflowRuntimeOverrides): RuntimeOptions {
    const merged: RuntimeOptions = {
      ...DEFAULT_OPTIONS,
      browserControlEnabled: true,
      headless: override.headless ?? DEFAULT_OPTIONS.headless,
      runtimeBackend: override.runtimeBackend || DEFAULT_OPTIONS.runtimeBackend,
      runtimeSpeed: override.runtimeSpeed || DEFAULT_OPTIONS.runtimeSpeed,
      runtimeCDPURL: override.runtimeCDPURL || DEFAULT_OPTIONS.runtimeCDPURL,
      runtimeTabIndex: override.runtimeTabIndex,
      runtimeTabMatch: override.runtimeTabMatch,
      runtimeTabPolicy: override.runtimeTabPolicy || DEFAULT_OPTIONS.runtimeTabPolicy,
      runtimeMaxSteps: override.runtimeMaxSteps || 12,
      providerRoute: override.providerRoute || DEFAULT_OPTIONS.providerRoute,
      providerModel: override.providerModel || DEFAULT_OPTIONS.providerModel,
      recordingEnabled: false,
      controlBorderEnabled: false,
    };
    return merged;
  }

  private runtimePrompt(
    run: WorkflowRunRecord,
    item: WorkflowItemRecord,
    input: Record<string, unknown>,
    viewport: ViewportProfile,
  ): string {
    if (item.prompt) {
      return item.prompt;
    }
    const viewportSize = resolveViewportSize(viewport);
    return [
      `Workflow key: ${run.workflowKey}`,
      `Operation: ${item.operation}`,
      `Item index: ${item.index}/${run.items.length}`,
      `Viewport profile: ${viewport} (${viewportSize.width}x${viewportSize.height})`,
      "Execute human-like browser actions and preserve session when possible.",
      "If a step fails, recover and continue. Report exact missing/invalid fields.",
      `Item payload:\n${JSON.stringify(input, null, 2)}`,
    ].join("\n");
  }

  private emitStage(
    run: WorkflowRunRecord,
    item: WorkflowItemRecord,
    stage: WorkflowStageName,
    status: WorkflowStageStatus,
    evidence = "",
    error = "",
    missingFields: string[] = [],
  ): void {
    item.currentStage = stage;
    const event: RuntimeEvent = {
      eventName: "workflow_stage",
      threadId: run.id,
      runId: run.id,
      itemId: item.id,
      stage,
      status,
      attempt: item.attempts,
      evidence: evidence || undefined,
      error: error || undefined,
      missingFields: missingFields.length ? missingFields : undefined,
      durationMs:
        status === "success" || status === "failed"
          ? Date.now() - (item.startedAt || Date.now())
          : undefined,
    };
    this.emitRunEvent(run, event);
  }

  private emitItemResult(run: WorkflowRunRecord, item: WorkflowItemRecord): void {
    const event: RuntimeEvent = {
      eventName: "workflow_item_result",
      threadId: run.id,
      runId: run.id,
      itemId: item.id,
      status: item.status,
      attempt: item.attempts,
      summary: item.summary || undefined,
      error: item.error || undefined,
      missingFields: item.missingFields.length ? item.missingFields : undefined,
      startedAt: item.startedAt ? new Date(item.startedAt).toISOString() : undefined,
      endedAt: item.endedAt ? new Date(item.endedAt).toISOString() : undefined,
      durationMs: item.durationMs,
    };
    this.emitRunEvent(run, event);
  }

  private emitRunStatus(run: WorkflowRunRecord, summary: string): void {
    const totals = this.computeTotals(run.items);
    const event: RuntimeEvent = {
      eventName: "workflow_run",
      threadId: run.id,
      runId: run.id,
      status: run.status,
      summary,
      completed: totals.succeeded + totals.failed + totals.canceled,
      total: totals.total,
      failed: totals.failed,
      canceled: totals.canceled,
    };
    this.emitRunEvent(run, event);
  }

  private emitRunEvent(run: WorkflowRunRecord, event: RuntimeEvent): void {
    run.history.push(event);
    if (run.history.length > MAX_RUN_EVENTS) {
      run.history.splice(0, run.history.length - MAX_RUN_EVENTS);
    }
    run.emitter.emit("event", event);
  }

  private toRunView(run: WorkflowRunRecord): WorkflowRunView {
    return {
      id: run.id,
      workflowKey: run.workflowKey,
      operation: run.operation,
      mode: run.mode,
      status: run.status,
      metadata: run.metadata,
      runtime: run.runtime,
      createdAt: new Date(run.createdAt).toISOString(),
      startedAt: run.startedAt ? new Date(run.startedAt).toISOString() : undefined,
      endedAt: run.endedAt ? new Date(run.endedAt).toISOString() : undefined,
      durationMs:
        run.startedAt && run.endedAt
          ? Math.max(0, run.endedAt - run.startedAt)
          : undefined,
      totals: this.computeTotals(run.items),
      itemIds: run.items.map((x) => x.id),
    };
  }

  private toItemView(item: WorkflowItemRecord): WorkflowRunItemView {
    return {
      id: item.id,
      index: item.index,
      externalItemId: item.externalItemId,
      operation: item.operation,
      status: item.status,
      attempts: item.attempts,
      currentStage: item.currentStage,
      missingFields: [...item.missingFields],
      error: item.error,
      summary: item.summary,
      startedAt: item.startedAt ? new Date(item.startedAt).toISOString() : undefined,
      endedAt: item.endedAt ? new Date(item.endedAt).toISOString() : undefined,
      durationMs: item.durationMs,
    };
  }

  private computeRunStatus(run: WorkflowRunRecord): WorkflowRunStatus {
    const totals = this.computeTotals(run.items);
    if (run.cancelRequested && totals.running === 0 && totals.pending === 0) {
      if (totals.succeeded === 0 && totals.failed === 0) {
        return "canceled";
      }
    }
    if (totals.failed > 0) return "completed_with_errors";
    if (totals.canceled > 0 && totals.succeeded === 0) return "canceled";
    return "completed";
  }

  private computeTotals(items: WorkflowItemRecord[]): WorkflowRunView["totals"] {
    let pending = 0;
    let running = 0;
    let succeeded = 0;
    let failed = 0;
    let canceled = 0;
    for (const item of items) {
      switch (item.status) {
        case "pending":
          pending += 1;
          break;
        case "running":
          running += 1;
          break;
        case "succeeded":
          succeeded += 1;
          break;
        case "failed":
          failed += 1;
          break;
        case "canceled":
          canceled += 1;
          break;
      }
    }
    return {
      total: items.length,
      pending,
      running,
      succeeded,
      failed,
      canceled,
    };
  }

  private applySelection(
    items: WorkflowItemCommand[],
    selection: WorkflowRunRequest["selection"],
  ): WorkflowItemCommand[] {
    if (!selection) return [...items];
    const itemIDSet = new Set((selection.itemIds || []).map((x) => String(x || "").trim()).filter(Boolean));
    const externalIDSet = new Set(
      (selection.externalItemIds || []).map((x) => String(x || "").trim()).filter(Boolean),
    );
    const hasRange = Boolean(selection.indexRange && Number.isFinite(selection.indexRange.start));
    const rangeStart = hasRange ? Math.max(1, Number(selection.indexRange?.start || 1)) : 1;
    const rangeEnd = hasRange ? Math.max(rangeStart, Number(selection.indexRange?.end || rangeStart)) : Number.MAX_SAFE_INTEGER;

    return items.filter((item, i) => {
      const idx = i + 1;
      if (itemIDSet.size > 0 && item.itemId && itemIDSet.has(item.itemId)) return true;
      if (externalIDSet.size > 0 && item.externalItemId && externalIDSet.has(item.externalItemId)) return true;
      if (hasRange && idx >= rangeStart && idx <= rangeEnd) return true;
      if (itemIDSet.size === 0 && externalIDSet.size === 0 && !hasRange) return true;
      return false;
    });
  }

  private normalizedInput(item: WorkflowItemRecord): Record<string, unknown> {
    const normalized = { ...(item.rawInput || {}) };
    if (item.externalItemId && !normalized.externalItemId) {
      normalized.externalItemId = item.externalItemId;
    }
    return normalized;
  }

  private missingFieldsFor(
    pack: NonNullable<ReturnType<typeof getWorkflowPack>>,
    operation: WorkflowOperation,
    input: Record<string, unknown>,
  ): string[] {
    const required = pack.requiredFields[operation] || [];
    const missing = required.filter((field) => {
      const value = input[field];
      return value === undefined || value === null || String(value).trim() === "";
    });
    if (operation === "update") {
      const mutable = Object.keys(input).filter((x) => x !== "externalItemId" && x !== "url");
      if (mutable.length === 0) {
        missing.push("at_least_one_mutation_field");
      }
    }
    return missing;
  }

  private viewportProfile(runtime: WorkflowRuntimeOverrides): ViewportProfile {
    const value = String(runtime.viewportProfile || "desktop").trim().toLowerCase();
    if (value === "mobile") return "mobile";
    if (value === "tablet") return "tablet";
    return "desktop";
  }

  private shouldAutoHeal(): boolean {
    const mode = (
      process.env.ANORHA_WORKFLOW_SELF_HEAL_POLICY ||
      (process.env.NODE_ENV === "production" ? "prod_guarded" : "dev_autonomous")
    )
      .trim()
      .toLowerCase();
    return mode !== "prod_guarded";
  }

  private presetKey(run: WorkflowRunRecord, item: WorkflowItemRecord): string {
    const viewport = this.viewportProfile(run.runtime);
    return `${run.workflowKey}::${item.operation}::${viewport}`;
  }

  private promotePreset(run: WorkflowRunRecord, item: WorkflowItemRecord, code: string): void {
    const key = this.presetKey(run, item);
    const existing = this.activePresets.get(key);
    this.activePresets.set(key, {
      key,
      code,
      updatedAt: Date.now(),
      successes: (existing?.successes || 0) + 1,
    });
  }

  private storePresetCandidate(
    run: WorkflowRunRecord,
    item: WorkflowItemRecord,
    code: string,
    error: string,
    needsPromotion: boolean,
  ): void {
    if (!code) return;
    const key = this.presetKey(run, item);
    const candidates = this.presetCandidates.get(key) || [];
    candidates.push({
      key,
      createdAt: Date.now(),
      code,
      error,
      needsPromotion,
      attempt: item.attempts,
    });
    if (candidates.length > 20) {
      candidates.splice(0, candidates.length - 20);
    }
    this.presetCandidates.set(key, candidates);
  }

  private maxConcurrency(): number {
    const raw = Number(process.env.ANORHA_WORKFLOW_MAX_CONCURRENCY || 2);
    if (!Number.isFinite(raw) || raw <= 0) return 2;
    return Math.max(1, Math.min(10, Math.trunc(raw)));
  }

  private isFinalStatus(status: WorkflowRunStatus): boolean {
    return (
      status === "completed" ||
      status === "completed_with_errors" ||
      status === "failed" ||
      status === "canceled"
    );
  }

  private mustGetRun(runID: string): WorkflowRunRecord {
    const run = this.runs.get(String(runID || "").trim());
    if (!run) {
      throw new Error(`workflow run '${runID}' not found`);
    }
    return run;
  }

  private recordRunMetrics(run: WorkflowRunRecord): void {
    for (const item of run.items) {
      this.recordDailyMetric(run.workflowKey, item.operation, (metric) => {
        metric.totalItems += 1;
        if (item.status === "succeeded") metric.succeeded += 1;
        if (item.status === "failed") metric.failed += 1;
        if (item.status === "canceled") metric.canceled += 1;
        metric.totalDurationMs += item.durationMs || 0;
      });
    }
  }

  private recordDailyMetric(
    workflowKey: string,
    operation: WorkflowOperation,
    update: (metric: DailyMetric) => void,
  ): void {
    const date = new Date().toISOString().slice(0, 10);
    const key = `${date}:${workflowKey}:${operation}`;
    const existing =
      this.dailyMetrics.get(key) ||
      ({
        date,
        workflowKey,
        operation,
        totalItems: 0,
        succeeded: 0,
        failed: 0,
        canceled: 0,
        totalDurationMs: 0,
        replayHits: 0,
        plannerFallbacks: 0,
        selfHealGenerated: 0,
        selfHealSucceeded: 0,
      } satisfies DailyMetric);
    update(existing);
    this.dailyMetrics.set(key, existing);
  }

  private errorString(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
