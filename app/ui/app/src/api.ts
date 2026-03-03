import {
  ChatResponse,
  ChatsResponse,
  ChatEvent,
  DownloadEvent,
  ErrorEvent,
  InferenceComputeResponse,
  ModelCapabilitiesResponse,
  Model,
  ChatRequest,
  Settings,
  User,
} from "@/gotypes";
import { parseJsonlFromResponse } from "./util/jsonl-parsing";
import { ollamaClient as ollama } from "./lib/ollama-client";
import type { ModelResponse } from "ollama/browser";
import { API_BASE, OLLAMA_DOT_COM } from "./lib/config";

export type AppAuthProvider = "clerk" | "ollama";
export const APP_AUTH_PROVIDER: AppAuthProvider =
  ((import.meta as any)?.env?.VITE_ANORHA_AUTH_PROVIDER || "clerk")
    .toString()
    .trim()
    .toLowerCase() === "ollama"
    ? "ollama"
    : "clerk";
export const APP_AUTH_SIGNIN_URL: string = (
  (import.meta as any)?.env?.VITE_ANORHA_AUTH_SIGNIN_URL || ""
)
  .toString()
  .trim();

// Extend Model class with utility methods
declare module "@/gotypes" {
  interface Model {
    isCloud(): boolean;
  }
}

Model.prototype.isCloud = function (): boolean {
  return this.model.endsWith("cloud");
};

export type CloudStatusSource = "env" | "config" | "both" | "none";
export interface CloudStatusResponse {
  disabled: boolean;
  source: CloudStatusSource;
}
// Helper function to convert Uint8Array to base64
function uint8ArrayToBase64(uint8Array: Uint8Array): string {
  const chunkSize = 0x8000; // 32KB chunks to avoid stack overflow
  let binary = "";

  for (let i = 0; i < uint8Array.length; i += chunkSize) {
    const chunk = uint8Array.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}

export async function fetchUser(): Promise<User | null> {
  const response = await fetch(`${API_BASE}/api/me`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
  });

  if (response.ok) {
    const userData: User = await response.json();

    if (userData.avatarurl && !userData.avatarurl.startsWith("http")) {
      userData.avatarurl = `${OLLAMA_DOT_COM}${userData.avatarurl}`;
    }

    return userData;
  }

  if (response.status === 401 || response.status === 403) {
    return null;
  }

  throw new Error(`Failed to fetch user: ${response.status}`);
}

export async function fetchConnectUrl(): Promise<string> {
  if (APP_AUTH_PROVIDER === "clerk" && APP_AUTH_SIGNIN_URL) {
    return APP_AUTH_SIGNIN_URL;
  }

  const response = await fetch(`${API_BASE}/api/me`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
  });

  if (response.status === 401) {
    const data = await response.json();
    if (data.signin_url) {
      return data.signin_url;
    }
  }

  throw new Error("Failed to fetch connect URL");
}

export async function disconnectUser(): Promise<void> {
  if (APP_AUTH_PROVIDER === "clerk") {
    return;
  }

  const response = await fetch(`${API_BASE}/api/signout`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    throw new Error("Failed to disconnect user");
  }
}

export async function getChats(): Promise<ChatsResponse> {
  const response = await fetch(`${API_BASE}/api/v1/chats`);
  const data = await response.json();
  return new ChatsResponse(data);
}

export async function getChat(chatId: string): Promise<ChatResponse> {
  const response = await fetch(`${API_BASE}/api/v1/chat/${chatId}`);
  const data = await response.json();
  return new ChatResponse(data);
}

export async function getModels(query?: string): Promise<Model[]> {
  try {
    const { models: modelsResponse } = await ollama.list();

    let models: Model[] = modelsResponse
      .filter((m: ModelResponse) => {
        const families = m.details?.families;

        if (!families || families.length === 0) {
          return true;
        }

        const isBertOnly = families.every((family: string) =>
          family.toLowerCase().includes("bert"),
        );

        return !isBertOnly;
      })
      .map((m: ModelResponse) => {
        // Remove the latest tag from the returned model
        const modelName = m.name.replace(/:latest$/, "");

        return new Model({
          model: modelName,
          digest: m.digest,
          modified_at: m.modified_at ? new Date(m.modified_at) : undefined,
        });
      });

    // Add OpenRouter models (best effort), namespaced as openrouter/<model-id>.
    try {
      const openRouterModels = await getProviderModels("openrouter");
      for (const modelId of openRouterModels) {
        const prefixed = `openrouter/${modelId}`;
        if (!models.some((m) => m.model === prefixed)) {
          models.push(
            new Model({
              model: prefixed,
            }),
          );
        }
      }
    } catch {
      // Ignore provider discovery failures; local model listing still works.
    }

    // Filter by query if provided
    if (query) {
      const normalizedQuery = query.toLowerCase().trim();

      const filteredModels = models.filter((m: Model) => {
        return m.model.toLowerCase().startsWith(normalizedQuery);
      });

      let exactMatch = false;
      for (const m of filteredModels) {
        if (m.model.toLowerCase() === normalizedQuery) {
          exactMatch = true;
          break;
        }
      }

      // Add query if it's in the registry and not already in the list
      if (!exactMatch && !normalizedQuery.startsWith("openrouter/")) {
        const result = await getModelUpstreamInfo(new Model({ model: query }));
        const existsUpstream = !!result.digest && !result.error;
        if (existsUpstream) {
          filteredModels.push(new Model({ model: query }));
        }
      }

      models = filteredModels;
    }

    return models;
  } catch (err) {
    throw new Error(`Failed to fetch models: ${err}`);
  }
}

export async function getProviderModels(
  route: "local_ollama" | "ollama_cloud" | "kimi" | "openrouter",
): Promise<string[]> {
  const response = await fetch(
    `${API_BASE}/api/v1/providers/models?route=${encodeURIComponent(route)}`,
  );
  if (!response.ok) {
    throw new Error(`Failed to fetch provider models: ${response.status}`);
  }
  const data = await response.json();
  return Array.isArray(data.models) ? data.models : [];
}

export async function getCredentialStatus(): Promise<
  Record<string, { available: boolean; source: string }>
> {
  const response = await fetch(`${API_BASE}/api/v1/credentials/status`);
  if (!response.ok) {
    throw new Error("Failed to fetch credential status");
  }
  const data = await response.json();
  return data.status || {};
}

export async function setCredential(
  provider: "openrouter" | "kimi" | "ollama_cloud",
  secret: string,
): Promise<void> {
  const response = await fetch(`${API_BASE}/api/v1/credentials`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider, secret }),
  });
  if (!response.ok) {
    throw new Error("Failed to set credential");
  }
}

export async function getModelCapabilities(
  modelName: string,
): Promise<ModelCapabilitiesResponse> {
  try {
    const showResponse = await ollama.show({ model: modelName });

    return new ModelCapabilitiesResponse({
      capabilities: Array.isArray(showResponse.capabilities)
        ? showResponse.capabilities
        : [],
    });
  } catch (error) {
    // Model might not be downloaded yet, return empty capabilities
    console.error(`Failed to get capabilities for ${modelName}:`, error);
    return new ModelCapabilitiesResponse({ capabilities: [] });
  }
}

export type ChatEventUnion = ChatEvent | DownloadEvent | ErrorEvent;

export interface RuntimeRequestOptions {
  browserControlEnabled?: boolean;
  runtimeBackend?: "browser_use_ts" | "playwright_direct" | "playwright_attached";
  runtimeCDPURL?: string;
  runtimeTabIndex?: number;
  runtimeTabMatch?: string;
  runtimeTabPolicy?: "pinned" | "ask" | "active";
  runtimeMaxSteps?: number;
  providerRoute?: "local_ollama" | "ollama_cloud" | "kimi" | "openrouter";
  providerModel?: string;
}

const RUNTIME_API_BASE =
  (import.meta as any)?.env?.VITE_ANORHA_RUNTIME_API_BASE || "http://127.0.0.1:7318";

export type WorkflowOperation = "create" | "read" | "update" | "delete";
export type WorkflowMode = "async" | "sync";
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
export type WorkflowStageStatus = "pending" | "running" | "success" | "failed" | "skipped";

export interface WorkflowItemCommand {
  itemId?: string;
  externalItemId?: string;
  operation?: WorkflowOperation;
  prompt?: string;
  input?: Record<string, unknown>;
}

export interface WorkflowRunRequestPayload {
  workflowKey: string;
  operation: WorkflowOperation;
  mode?: WorkflowMode;
  items: WorkflowItemCommand[];
  runtime?: RuntimeRequestOptions & {
    viewportProfile?: "desktop" | "tablet" | "mobile";
    headless?: boolean;
  };
  selection?: {
    itemIds?: string[];
    externalItemIds?: string[];
    indexRange?: { start: number; end: number };
  };
  metadata?: Record<string, unknown>;
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
  stagePlan: Array<"navigate" | "fill_data" | "confirm" | "complete" | "verify">;
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

export interface WorkflowCatalogVerifyResult {
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

export interface WorkflowSessionRequestPayload {
  workflowKey: string;
  operation: WorkflowOperation;
  mode?: WorkflowMode;
  sessionType?: WorkflowSessionType;
  siteId?: string;
  toolIds?: string[];
  items: WorkflowItemCommand[];
  runtime?: WorkflowRunRequestPayload["runtime"];
  selection?: WorkflowRunRequestPayload["selection"];
  metadata?: Record<string, unknown>;
}

export interface WorkflowRunView {
  id: string;
  workflowKey: string;
  operation: WorkflowOperation;
  mode: WorkflowMode;
  status: WorkflowRunStatus;
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  metadata: Record<string, unknown>;
  runtime: Record<string, unknown>;
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

export interface WorkflowRunItemView {
  id: string;
  index: number;
  externalItemId: string;
  operation: WorkflowOperation;
  status: WorkflowItemStatus;
  attempts: number;
  currentStage: "navigate" | "fill_data" | "confirm" | "complete" | "verify" | "";
  missingFields: string[];
  error: string;
  summary: string;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
}

export type WorkflowRunEvent =
  | {
      eventName: "workflow_stage";
      runId: string;
      itemId: string;
      stage: "navigate" | "fill_data" | "confirm" | "complete" | "verify";
      status: WorkflowStageStatus;
      attempt: number;
      durationMs?: number;
      evidence?: string;
      error?: string;
      missingFields?: string[];
    }
  | {
      eventName: "workflow_item_result";
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
      runId: string;
      status: WorkflowRunStatus;
      summary?: string;
      completed?: number;
      total?: number;
      failed?: number;
      canceled?: number;
    }
  | {
      eventName: "error";
      error: string;
    }
  | {
      eventName: "tool_result" | "tool_call" | "thinking";
      content?: string;
      toolName?: string;
      toolResultData?: unknown;
      thinking?: string;
    };

export async function* sendMessage(
  chatId: string,
  message: string,
  model: Model,
  attachments?: Array<{ filename: string; data: Uint8Array }>,
  signal?: AbortSignal,
  index?: number,
  webSearch?: boolean,
  fileTools?: boolean,
  forceUpdate?: boolean,
  think?: boolean | string,
  runtimeOptions?: RuntimeRequestOptions,
): AsyncGenerator<ChatEventUnion> {
  // Convert Uint8Array to base64 for JSON serialization
  const serializedAttachments = attachments?.map((att) => ({
    filename: att.filename,
    data: uint8ArrayToBase64(att.data),
  }));

  // Send think parameter when it's explicitly set (true, false, or a non-empty string).
  const shouldSendThink =
    think !== undefined &&
    (typeof think === "boolean" || (typeof think === "string" && think !== ""));

  const response = await fetch(`${API_BASE}/api/v1/chat/${chatId}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(
      new ChatRequest({
        model: model.model,
        prompt: message,
        ...(index !== undefined ? { index } : {}),
        ...(serializedAttachments !== undefined
          ? { attachments: serializedAttachments }
          : {}),
        // Always send web_search as a boolean value (default to false)
        web_search: webSearch ?? false,
        file_tools: fileTools ?? false,
        ...(forceUpdate !== undefined ? { forceUpdate } : {}),
        ...(shouldSendThink ? { think } : {}),
        ...(runtimeOptions?.browserControlEnabled !== undefined
          ? { browserControlEnabled: runtimeOptions.browserControlEnabled }
          : {}),
        ...(runtimeOptions?.runtimeBackend
          ? { runtimeBackend: runtimeOptions.runtimeBackend }
          : {}),
        ...(runtimeOptions?.runtimeCDPURL
          ? { runtimeCDPURL: runtimeOptions.runtimeCDPURL }
          : {}),
        ...(runtimeOptions?.runtimeTabIndex !== undefined
          ? { runtimeTabIndex: runtimeOptions.runtimeTabIndex }
          : {}),
        ...(runtimeOptions?.runtimeTabMatch
          ? { runtimeTabMatch: runtimeOptions.runtimeTabMatch }
          : {}),
        ...(runtimeOptions?.runtimeTabPolicy
          ? { runtimeTabPolicy: runtimeOptions.runtimeTabPolicy }
          : {}),
        ...(runtimeOptions?.runtimeMaxSteps !== undefined
          ? { runtimeMaxSteps: runtimeOptions.runtimeMaxSteps }
          : {}),
        ...(runtimeOptions?.providerRoute
          ? { providerRoute: runtimeOptions.providerRoute }
          : {}),
        ...(runtimeOptions?.providerModel
          ? { providerModel: runtimeOptions.providerModel }
          : {}),
      }),
    ),
    signal,
  });

  for await (const event of parseJsonlFromResponse<ChatEventUnion>(response)) {
    switch (event.eventName) {
      case "download":
        yield new DownloadEvent(event);
        break;
      case "error":
        yield new ErrorEvent(event);
        break;
      default:
        yield new ChatEvent(event);
        break;
    }
  }
}

function runtimeHeaders(token?: string): Record<string, string> {
  const resolvedToken = token || getWorkflowAuthToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (resolvedToken && resolvedToken.trim()) {
    headers.Authorization = `Bearer ${resolvedToken.trim()}`;
  }
  return headers;
}

export function getWorkflowAuthToken(): string {
  try {
    const fromStorage = localStorage.getItem("anorha.workflow.token") || "";
    if (fromStorage.trim()) return fromStorage.trim();
  } catch {
    // ignore localStorage access errors
  }
  const fromEnv = ((import.meta as any)?.env?.VITE_ANORHA_WORKFLOW_TOKEN || "")
    .toString()
    .trim();
  return fromEnv;
}

export async function createWorkflowRun(
  payload: WorkflowRunRequestPayload,
  token?: string,
): Promise<{
  success: boolean;
  mode: WorkflowMode;
  completed?: boolean;
  run: WorkflowRunView;
  items?: WorkflowRunItemView[];
  itemIds?: string[];
}> {
  const response = await fetch(`${RUNTIME_API_BASE}/v1/workflow-runs`, {
    method: "POST",
    headers: runtimeHeaders(token),
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || `Failed to create workflow run (${response.status})`);
  }
  return await response.json();
}

export async function listWorkflowCatalogSites(token?: string): Promise<{
  success: boolean;
  sites: WorkflowCatalogSite[];
}> {
  const response = await fetch(`${RUNTIME_API_BASE}/v1/workflow-catalog/sites`, {
    method: "GET",
    headers: runtimeHeaders(token),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || `Failed to fetch workflow catalog sites (${response.status})`);
  }
  return await response.json();
}

export async function createWorkflowCatalogSite(
  payload: {
    key: string;
    name: string;
    description?: string;
    status?: WorkflowSiteStatus;
    domains?: string[];
  },
  token?: string,
): Promise<{ success: boolean; site: WorkflowCatalogSite }> {
  const response = await fetch(`${RUNTIME_API_BASE}/v1/workflow-catalog/sites`, {
    method: "POST",
    headers: runtimeHeaders(token),
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || `Failed to create workflow site (${response.status})`);
  }
  return await response.json();
}

export async function updateWorkflowCatalogSite(
  siteId: string,
  payload: {
    name?: string;
    description?: string;
    status?: WorkflowSiteStatus;
    domains?: string[];
  },
  token?: string,
): Promise<{ success: boolean; site: WorkflowCatalogSite }> {
  const response = await fetch(
    `${RUNTIME_API_BASE}/v1/workflow-catalog/sites/${encodeURIComponent(siteId)}`,
    {
      method: "PATCH",
      headers: runtimeHeaders(token),
      body: JSON.stringify(payload),
    },
  );
  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || `Failed to update workflow site (${response.status})`);
  }
  return await response.json();
}

export async function listWorkflowCatalogSiteTools(
  siteId: string,
  token?: string,
): Promise<{ success: boolean; tools: WorkflowCatalogTool[] }> {
  const response = await fetch(
    `${RUNTIME_API_BASE}/v1/workflow-catalog/sites/${encodeURIComponent(siteId)}/tools`,
    {
      method: "GET",
      headers: runtimeHeaders(token),
    },
  );
  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || `Failed to fetch workflow tools (${response.status})`);
  }
  return await response.json();
}

export async function createWorkflowCatalogTool(
  payload: {
    siteId: string;
    key: string;
    name: string;
    description?: string;
    group: string;
    status?: WorkflowToolStatus;
    workflowKey: string;
    operation: WorkflowOperation;
    stagePlan?: Array<"navigate" | "fill_data" | "confirm" | "complete" | "verify">;
    requiredFields?: string[];
    allowedFields?: string[];
    promptTemplate: string;
    selectorHints?: Record<string, unknown>;
    presetCode?: string;
  },
  token?: string,
): Promise<{ success: boolean; tool: WorkflowCatalogTool }> {
  const response = await fetch(`${RUNTIME_API_BASE}/v1/workflow-catalog/tools`, {
    method: "POST",
    headers: runtimeHeaders(token),
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || `Failed to create workflow tool (${response.status})`);
  }
  return await response.json();
}

export async function updateWorkflowCatalogTool(
  toolId: string,
  payload: Partial<{
    name: string;
    description: string;
    group: string;
    status: WorkflowToolStatus;
    operation: WorkflowOperation;
    stagePlan: Array<"navigate" | "fill_data" | "confirm" | "complete" | "verify">;
    requiredFields: string[];
    allowedFields: string[];
    promptTemplate: string;
    selectorHints: Record<string, unknown>;
    presetCode: string;
  }>,
  token?: string,
): Promise<{ success: boolean; tool: WorkflowCatalogTool }> {
  const response = await fetch(
    `${RUNTIME_API_BASE}/v1/workflow-catalog/tools/${encodeURIComponent(toolId)}`,
    {
      method: "PATCH",
      headers: runtimeHeaders(token),
      body: JSON.stringify(payload),
    },
  );
  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || `Failed to update workflow tool (${response.status})`);
  }
  return await response.json();
}

export async function deleteWorkflowCatalogTool(
  toolId: string,
  token?: string,
): Promise<{ success: boolean }> {
  const response = await fetch(
    `${RUNTIME_API_BASE}/v1/workflow-catalog/tools/${encodeURIComponent(toolId)}`,
    {
      method: "DELETE",
      headers: runtimeHeaders(token),
    },
  );
  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || `Failed to delete workflow tool (${response.status})`);
  }
  return await response.json();
}

export async function verifyWorkflowCatalogTool(
  toolId: string,
  payload: {
    dryRun?: boolean;
    sampleInput?: Record<string, unknown>;
    runtime?: WorkflowRunRequestPayload["runtime"];
  },
  token?: string,
): Promise<{ success: boolean; result: WorkflowCatalogVerifyResult }> {
  const response = await fetch(
    `${RUNTIME_API_BASE}/v1/workflow-catalog/tools/${encodeURIComponent(toolId)}/verify`,
    {
      method: "POST",
      headers: runtimeHeaders(token),
      body: JSON.stringify(payload),
    },
  );
  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || `Failed to verify workflow tool (${response.status})`);
  }
  return await response.json();
}

export async function createWorkflowSession(
  payload: WorkflowSessionRequestPayload,
  token?: string,
): Promise<{
  success: boolean;
  mode: WorkflowMode;
  completed?: boolean;
  session: WorkflowRunView;
  items?: WorkflowRunItemView[];
  itemIds?: string[];
}> {
  const response = await fetch(`${RUNTIME_API_BASE}/v1/workflow-sessions`, {
    method: "POST",
    headers: runtimeHeaders(token),
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || `Failed to create workflow session (${response.status})`);
  }
  return await response.json();
}

export async function getWorkflowSession(
  sessionId: string,
  token?: string,
): Promise<{ success: boolean; session: WorkflowRunView }> {
  const response = await fetch(
    `${RUNTIME_API_BASE}/v1/workflow-sessions/${encodeURIComponent(sessionId)}`,
    {
      method: "GET",
      headers: runtimeHeaders(token),
    },
  );
  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || `Failed to fetch workflow session (${response.status})`);
  }
  return await response.json();
}

export async function listWorkflowSessionItems(
  sessionId: string,
  token?: string,
): Promise<{ success: boolean; items: WorkflowRunItemView[] }> {
  const response = await fetch(
    `${RUNTIME_API_BASE}/v1/workflow-sessions/${encodeURIComponent(sessionId)}/items`,
    {
      method: "GET",
      headers: runtimeHeaders(token),
    },
  );
  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || `Failed to fetch workflow session items (${response.status})`);
  }
  return await response.json();
}

export async function cancelWorkflowSession(
  sessionId: string,
  token?: string,
): Promise<{ success: boolean; session: WorkflowRunView }> {
  const response = await fetch(
    `${RUNTIME_API_BASE}/v1/workflow-sessions/${encodeURIComponent(sessionId)}/cancel`,
    {
      method: "POST",
      headers: runtimeHeaders(token),
    },
  );
  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || `Failed to cancel workflow session (${response.status})`);
  }
  return await response.json();
}

export async function retryWorkflowSessionItems(
  sessionId: string,
  itemIds?: string[],
  token?: string,
): Promise<{ success: boolean; session: WorkflowRunView; items: WorkflowRunItemView[] }> {
  const response = await fetch(
    `${RUNTIME_API_BASE}/v1/workflow-sessions/${encodeURIComponent(sessionId)}/retry`,
    {
      method: "POST",
      headers: runtimeHeaders(token),
      body: JSON.stringify({ itemIds: itemIds || [] }),
    },
  );
  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || `Failed to retry workflow session items (${response.status})`);
  }
  return await response.json();
}

export async function* streamWorkflowSessionEvents(
  sessionId: string,
  token?: string,
): AsyncGenerator<WorkflowRunEvent> {
  const response = await fetch(
    `${RUNTIME_API_BASE}/v1/workflow-sessions/${encodeURIComponent(sessionId)}/events`,
    {
      method: "GET",
      headers: token && token.trim() ? { Authorization: `Bearer ${token.trim()}` } : runtimeHeaders(token),
    },
  );
  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || `Failed to stream workflow session events (${response.status})`);
  }
  if (!response.body) {
    throw new Error("Workflow session event stream has no body");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let eventBreak = buffer.indexOf("\n\n");
    while (eventBreak >= 0) {
      const rawEvent = buffer.slice(0, eventBreak);
      buffer = buffer.slice(eventBreak + 2);

      const dataLines = rawEvent
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim());
      const payload = dataLines.join("\n").trim();
      if (payload) {
        try {
          const parsed = JSON.parse(payload) as WorkflowRunEvent;
          yield parsed;
        } catch {
          // Ignore malformed frames to keep stream alive.
        }
      }

      eventBreak = buffer.indexOf("\n\n");
    }
  }
}

export async function getWorkflowRun(runId: string, token?: string): Promise<{
  success: boolean;
  run: WorkflowRunView;
}> {
  const response = await fetch(
    `${RUNTIME_API_BASE}/v1/workflow-runs/${encodeURIComponent(runId)}`,
    {
      method: "GET",
      headers: runtimeHeaders(token),
    },
  );
  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || `Failed to fetch workflow run (${response.status})`);
  }
  return await response.json();
}

export async function listWorkflowRunItems(
  runId: string,
  token?: string,
): Promise<{ success: boolean; items: WorkflowRunItemView[] }> {
  const response = await fetch(
    `${RUNTIME_API_BASE}/v1/workflow-runs/${encodeURIComponent(runId)}/items`,
    {
      method: "GET",
      headers: runtimeHeaders(token),
    },
  );
  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || `Failed to fetch workflow run items (${response.status})`);
  }
  return await response.json();
}

export async function cancelWorkflowRun(
  runId: string,
  token?: string,
): Promise<{ success: boolean; run: WorkflowRunView }> {
  const response = await fetch(
    `${RUNTIME_API_BASE}/v1/workflow-runs/${encodeURIComponent(runId)}/cancel`,
    {
      method: "POST",
      headers: runtimeHeaders(token),
    },
  );
  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || `Failed to cancel workflow run (${response.status})`);
  }
  return await response.json();
}

export async function retryWorkflowRunItems(
  runId: string,
  itemIds?: string[],
  token?: string,
): Promise<{ success: boolean; run: WorkflowRunView; items: WorkflowRunItemView[] }> {
  const response = await fetch(
    `${RUNTIME_API_BASE}/v1/workflow-runs/${encodeURIComponent(runId)}/retry`,
    {
      method: "POST",
      headers: runtimeHeaders(token),
      body: JSON.stringify({ itemIds: itemIds || [] }),
    },
  );
  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || `Failed to retry workflow run items (${response.status})`);
  }
  return await response.json();
}

export async function getWorkflowDailyMetrics(
  token?: string,
): Promise<{ success: boolean; metrics: Array<Record<string, unknown>> }> {
  const response = await fetch(`${RUNTIME_API_BASE}/v1/workflow-metrics/daily`, {
    method: "GET",
    headers: runtimeHeaders(token),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || `Failed to fetch workflow metrics (${response.status})`);
  }
  return await response.json();
}

export async function* streamWorkflowRunEvents(
  runId: string,
  token?: string,
): AsyncGenerator<WorkflowRunEvent> {
  const response = await fetch(
    `${RUNTIME_API_BASE}/v1/workflow-runs/${encodeURIComponent(runId)}/events`,
    {
      method: "GET",
      headers: token && token.trim() ? { Authorization: `Bearer ${token.trim()}` } : {},
    },
  );
  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || `Failed to stream workflow events (${response.status})`);
  }
  if (!response.body) {
    throw new Error("Workflow event stream has no body");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let eventBreak = buffer.indexOf("\n\n");
    while (eventBreak >= 0) {
      const rawEvent = buffer.slice(0, eventBreak);
      buffer = buffer.slice(eventBreak + 2);

      const dataLines = rawEvent
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim());
      const payload = dataLines.join("\n").trim();
      if (payload) {
        try {
          const parsed = JSON.parse(payload) as WorkflowRunEvent;
          yield parsed;
        } catch {
          // Ignore malformed frames to keep stream alive.
        }
      }

      eventBreak = buffer.indexOf("\n\n");
    }
  }
}

export async function getSettings(): Promise<{
  settings: Settings;
}> {
  const response = await fetch(`${API_BASE}/api/v1/settings`);
  if (!response.ok) {
    throw new Error("Failed to fetch settings");
  }
  const data = await response.json();
  return {
    settings: new Settings(data.settings),
  };
}

export async function updateSettings(settings: Settings): Promise<{
  settings: Settings;
}> {
  const response = await fetch(`${API_BASE}/api/v1/settings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(settings),
  });
  if (!response.ok) {
    const error = await response.text();
    throw new Error(error || "Failed to update settings");
  }
  const data = await response.json();
  return {
    settings: new Settings(data.settings),
  };
}

export async function updateCloudSetting(
  enabled: boolean,
): Promise<CloudStatusResponse> {
  const response = await fetch(`${API_BASE}/api/v1/cloud`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ enabled }),
  });
  if (!response.ok) {
    const error = await response.text();
    throw new Error(error || "Failed to update cloud setting");
  }

  const data = await response.json();
  return {
    disabled: Boolean(data.disabled),
    source: (data.source as CloudStatusSource) || "none",
  };
}

export async function renameChat(chatId: string, title: string): Promise<void> {
  const response = await fetch(`${API_BASE}/api/v1/chat/${chatId}/rename`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ title: title.trim() }),
  });
  if (!response.ok) {
    const error = await response.text();
    throw new Error(error || "Failed to rename chat");
  }
}

export async function deleteChat(chatId: string): Promise<void> {
  const response = await fetch(`${API_BASE}/api/v1/chat/${chatId}`, {
    method: "DELETE",
  });
  if (!response.ok) {
    const error = await response.text();
    throw new Error(error || "Failed to delete chat");
  }
}

// Get upstream information for model staleness checking
export async function getModelUpstreamInfo(
  model: Model,
): Promise<{ digest?: string; pushTime: number; error?: string }> {
  try {
    const response = await fetch(`${API_BASE}/api/v1/model/upstream`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: model.model,
      }),
    });

    if (!response.ok) {
      console.warn(
        `Failed to check upstream digest for ${model.model}: ${response.status}`,
      );
      return { pushTime: 0 };
    }

    const data = await response.json();

    if (data.error) {
      console.warn(`Upstream digest check: ${data.error}`);
      return { error: data.error, pushTime: 0 };
    }

    return { digest: data.digest, pushTime: data.pushTime || 0 };
  } catch (error) {
    console.warn(`Error checking model staleness:`, error);
    return { pushTime: 0 };
  }
}

export async function* pullModel(
  modelName: string,
  signal?: AbortSignal,
): AsyncGenerator<{
  status: string;
  digest?: string;
  total?: number;
  completed?: number;
  done?: boolean;
}> {
  const response = await fetch(`${API_BASE}/api/v1/models/pull`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name: modelName }),
    signal,
  });

  if (!response.ok) {
    throw new Error(`Failed to pull model: ${response.statusText}`);
  }

  for await (const event of parseJsonlFromResponse<{
    status: string;
    digest?: string;
    total?: number;
    completed?: number;
    done?: boolean;
  }>(response)) {
    yield event;
  }
}

export async function getInferenceCompute(): Promise<InferenceComputeResponse> {
  const response = await fetch(`${API_BASE}/api/v1/inference-compute`);
  if (!response.ok) {
    throw new Error(
      `Failed to fetch inference compute: ${response.statusText}`,
    );
  }

  const data = await response.json();
  return new InferenceComputeResponse(data);
}

export async function fetchHealth(): Promise<boolean> {
  try {
    // Use the /api/version endpoint as a health check
    const response = await fetch(`${API_BASE}/api/version`, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
      },
    });

    if (response.ok) {
      const data = await response.json();
      // If we get a version back, the server is healthy
      return !!data.version;
    }

    return false;
  } catch (error) {
    console.error("Error checking health:", error);
    return false;
  }
}

export async function getCloudStatus(): Promise<CloudStatusResponse | null> {
  const response = await fetch(`${API_BASE}/api/v1/cloud`);
  if (!response.ok) {
    throw new Error(`Failed to fetch cloud status: ${response.status}`);
  }

  const data = await response.json();
  return {
    disabled: Boolean(data.disabled),
    source: (data.source as CloudStatusSource) || "none",
  };
}
