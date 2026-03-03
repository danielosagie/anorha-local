export type RuntimeBackend = "browser_use_ts" | "playwright_direct" | "playwright_attached";
export type ProviderRoute = "local_ollama" | "ollama_cloud" | "kimi" | "openrouter";
export type WorkflowOperation = "create" | "read" | "update" | "delete";
export type WorkflowMode = "async" | "sync";
export type ViewportProfile = "desktop" | "tablet" | "mobile";
export type WorkflowSiteStatus = "active" | "draft" | "disabled";
export type WorkflowToolStatus = "active" | "draft" | "archived";
export type WorkflowSessionType = "create" | "verify" | "update";
export type WorkflowRunStatus =
  | "queued"
  | "running"
  | "completed"
  | "completed_with_errors"
  | "failed"
  | "canceled";
export type WorkflowItemStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "canceled";
export type WorkflowStageName = "navigate" | "fill_data" | "confirm" | "complete" | "verify";
export type WorkflowStageStatus = "pending" | "running" | "success" | "failed" | "skipped";

export interface RuntimeOptions {
  browserControlEnabled: boolean;
  headless: boolean;
  webToolsEnabled: boolean;
  runtimeBackend: RuntimeBackend;
  runtimeCDPURL?: string;
  runtimeTabIndex?: number;
  runtimeTabMatch?: string;
  runtimeTabPolicy?: "pinned" | "ask" | "active";
  runtimeMaxSteps?: number;
  recordingEnabled: boolean;
  controlBorderEnabled: boolean;
  providerRoute: ProviderRoute;
  providerModel?: string;
  escalationEligible: boolean;
  verificationRuns: number;
}

export interface WorkflowRuntimeOverrides {
  runtimeBackend?: RuntimeBackend;
  runtimeCDPURL?: string;
  runtimeTabIndex?: number;
  runtimeTabMatch?: string;
  runtimeTabPolicy?: "pinned" | "ask" | "active";
  runtimeMaxSteps?: number;
  providerRoute?: ProviderRoute;
  providerModel?: string;
  headless?: boolean;
  viewportProfile?: ViewportProfile;
}

export interface WorkflowCatalogSite {
  id: string;
  key: string;
  name: string;
  description?: string;
  status: WorkflowSiteStatus;
  domains: string[];
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowCatalogTool {
  id: string;
  siteId: string;
  key: string;
  name: string;
  description?: string;
  group: string;
  status: WorkflowToolStatus;
  workflowKey: string;
  operation: WorkflowOperation;
  stagePlan: WorkflowStageName[];
  requiredFields: string[];
  allowedFields: string[];
  promptTemplate: string;
  selectorHints?: Record<string, unknown>;
  presetCode?: string;
  version: number;
  verifiedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowCatalogCreateSiteRequest {
  key: string;
  name: string;
  description?: string;
  status?: WorkflowSiteStatus;
  domains?: string[];
}

export interface WorkflowCatalogUpdateSiteRequest {
  name?: string;
  description?: string;
  status?: WorkflowSiteStatus;
  domains?: string[];
}

export interface WorkflowCatalogCreateToolRequest {
  siteId: string;
  key: string;
  name: string;
  description?: string;
  group: string;
  status?: WorkflowToolStatus;
  workflowKey: string;
  operation: WorkflowOperation;
  stagePlan?: WorkflowStageName[];
  requiredFields?: string[];
  allowedFields?: string[];
  promptTemplate: string;
  selectorHints?: Record<string, unknown>;
  presetCode?: string;
}

export interface WorkflowCatalogUpdateToolRequest {
  name?: string;
  description?: string;
  group?: string;
  status?: WorkflowToolStatus;
  operation?: WorkflowOperation;
  stagePlan?: WorkflowStageName[];
  requiredFields?: string[];
  allowedFields?: string[];
  promptTemplate?: string;
  selectorHints?: Record<string, unknown>;
  presetCode?: string;
}

export interface WorkflowCatalogVerifyToolRequest {
  dryRun?: boolean;
  sampleInput?: Record<string, unknown>;
  runtime?: WorkflowRuntimeOverrides;
}

export interface WorkflowCatalogVerifyToolResponse {
  tool: WorkflowCatalogTool;
  dryRun: {
    valid: boolean;
    missingFields: string[];
    notes: string[];
  };
  sampleRun?: {
    runId: string;
    status: WorkflowRunStatus;
  };
}

export interface WorkflowSessionRequest {
  workflowKey: string;
  operation: WorkflowOperation;
  mode?: WorkflowMode;
  sessionType?: WorkflowSessionType;
  siteId?: string;
  toolIds?: string[];
  items: WorkflowItemCommand[];
  runtime?: WorkflowRuntimeOverrides;
  selection?: {
    itemIds?: string[];
    externalItemIds?: string[];
    indexRange?: { start: number; end: number };
  };
  metadata?: Record<string, unknown>;
}

export interface WorkflowItemCommand {
  itemId?: string;
  externalItemId?: string;
  operation?: WorkflowOperation;
  prompt?: string;
  input?: Record<string, unknown>;
}

export interface WorkflowRunRequest {
  workflowKey: string;
  operation: WorkflowOperation;
  mode?: WorkflowMode;
  items: WorkflowItemCommand[];
  runtime?: WorkflowRuntimeOverrides;
  selection?: {
    itemIds?: string[];
    externalItemIds?: string[];
    indexRange?: { start: number; end: number };
  };
  metadata?: Record<string, unknown>;
}

export interface WorkflowRetryRequest {
  itemIds?: string[];
}

export interface RunPayload {
  threadId: string;
  message: string;
  options: RuntimeOptions;
  startUrl?: string;
  workflowRunId?: string;
  workflowItemId?: string;
  workflowKey?: string;
  workflowOperation?: WorkflowOperation;
  workflowStagePlan?: WorkflowStageName[];
  workflowInput?: Record<string, unknown>;
  viewportProfile?: ViewportProfile;
}

export interface RecordingSegment {
  segmentId: string;
  threadId: string;
  timestamp: number;
  summary: string;
  imageDataUrl?: string;
}

export interface FailureReport {
  threadId: string;
  runtimeBackend: RuntimeBackend;
  errorClass: string;
  errorMessage: string;
  stepTrace: string[];
  artifacts?: Record<string, unknown>;
}

export type RuntimeEvent =
  | { eventName: "chat"; threadId: string; content?: string }
  | { eventName: "thinking"; threadId: string; thinking?: string }
  | { eventName: "tool_call"; threadId: string; toolName: string; content?: string }
  | {
      eventName: "tool_result";
      threadId: string;
      toolName?: string;
      content?: string;
      toolResult?: boolean;
      toolResultData?: unknown;
      toolState?: unknown;
    }
  | {
      eventName: "workflow_stage";
      threadId: string;
      runId: string;
      itemId: string;
      stage: WorkflowStageName;
      status: WorkflowStageStatus;
      attempt: number;
      durationMs?: number;
      evidence?: string;
      error?: string;
      missingFields?: string[];
    }
  | {
      eventName: "workflow_item_result";
      threadId: string;
      runId: string;
      itemId: string;
      status: WorkflowItemStatus;
      attempt: number;
      summary?: string;
      error?: string;
      missingFields?: string[];
      startedAt?: string;
      endedAt?: string;
      durationMs?: number;
    }
  | {
      eventName: "workflow_run";
      threadId: string;
      runId: string;
      status: WorkflowRunStatus;
      summary?: string;
      completed?: number;
      total?: number;
      failed?: number;
      canceled?: number;
    }
  | { eventName: "media_event"; threadId: string; segment: RecordingSegment }
  | { eventName: "done"; threadId: string; content?: string }
  | { eventName: "error"; threadId: string; error: string; report?: FailureReport }
  | { eventName: "control_state"; threadId: string; controlled: boolean; runtime: RuntimeBackend };

export interface RuntimeExecutionRequest {
  threadId: string;
  message: string;
  options: RuntimeOptions;
  startUrl?: string;
  workflowRunId?: string;
  workflowItemId?: string;
  workflowKey?: string;
  workflowOperation?: WorkflowOperation;
  workflowStagePlan?: WorkflowStageName[];
  workflowInput?: Record<string, unknown>;
  viewportProfile?: ViewportProfile;
  emit: (event: RuntimeEvent) => void;
  emitRecording: (segment: RecordingSegment) => void;
}

export interface RuntimeExecutionResult {
  success: boolean;
  summary: string;
  data?: unknown;
  error?: string;
}

export interface RuntimeAdapter {
  readonly name: RuntimeBackend;
  execute(request: RuntimeExecutionRequest): Promise<RuntimeExecutionResult>;
  intervene?(threadId: string): Promise<void> | void;
  resume?(threadId: string): Promise<void> | void;
}

export interface WorkflowRunItemView {
  id: string;
  index: number;
  externalItemId: string;
  operation: WorkflowOperation;
  status: WorkflowItemStatus;
  attempts: number;
  currentStage: WorkflowStageName | "";
  missingFields: string[];
  error: string;
  summary: string;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
}

export interface WorkflowRunView {
  id: string;
  workflowKey: string;
  operation: WorkflowOperation;
  mode: WorkflowMode;
  status: WorkflowRunStatus;
  metadata: Record<string, unknown>;
  runtime: WorkflowRuntimeOverrides;
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  totals: {
    total: number;
    pending: number;
    running: number;
    succeeded: number;
    failed: number;
    canceled: number;
  };
  itemIds: string[];
}

export const DEFAULT_OPTIONS: RuntimeOptions = {
  browserControlEnabled: true,
  headless: false,
  webToolsEnabled: true,
  runtimeBackend: "playwright_attached",
  runtimeCDPURL: "http://127.0.0.1:9222",
  runtimeTabPolicy: "pinned",
  runtimeMaxSteps: 8,
  recordingEnabled: true,
  controlBorderEnabled: true,
  providerRoute: "local_ollama",
  providerModel: "",
  escalationEligible: true,
  verificationRuns: 2,
};
