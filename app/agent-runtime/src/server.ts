import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";
import { ThreadEventBus } from "./event-bus.js";
import { listProviderModels } from "./provider-router.js";
import { RuntimeManager } from "./runtime-manager.js";
import { authorizeWorkflowRequest, WorkflowAuthError } from "./workflows/clerk-auth.js";
import { WorkflowCatalogStore, workflowToolGroups } from "./workflows/catalog-store.js";
import { WorkflowRunManager } from "./workflows/workflow-run-manager.js";
import type {
  FailureReport,
  RunPayload,
  RuntimeEvent,
  RuntimeOptions,
  WorkflowCatalogCreateSiteRequest,
  WorkflowCatalogCreateToolRequest,
  WorkflowCatalogUpdateSiteRequest,
  WorkflowCatalogUpdateToolRequest,
  WorkflowCatalogVerifyToolRequest,
  WorkflowRetryRequest,
  WorkflowSessionRequest,
  WorkflowRunRequest,
} from "./types.js";

const bus = new ThreadEventBus();
const runtimeManager = new RuntimeManager();
const workflowRunManager = new WorkflowRunManager(runtimeManager);
const workflowCatalogStore = new WorkflowCatalogStore();

const HOST = process.env.ANORHA_RUNTIME_HOST || "127.0.0.1";
const PORT = Number(process.env.ANORHA_RUNTIME_PORT || "7318");

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-cache",
  });
  res.end(JSON.stringify(payload));
}

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
}

function writeSse(res: ServerResponse, event: RuntimeEvent): void {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function workflowSyncTimeoutMs(): number {
  const raw = Number(process.env.ANORHA_WORKFLOW_SYNC_TIMEOUT_MS || 180000);
  if (!Number.isFinite(raw) || raw <= 0) return 180000;
  return Math.max(5000, Math.min(15 * 60 * 1000, Math.trunc(raw)));
}

function runPath(url: URL): { runId: string; suffix: string } | null {
  const match = /^\/v1\/workflow-runs\/([^/]+)(?:\/(items|events|cancel|retry))?$/.exec(url.pathname);
  if (!match) return null;
  return {
    runId: decodeURIComponent(match[1]),
    suffix: match[2] || "",
  };
}

function sessionPath(url: URL): { sessionId: string; suffix: string } | null {
  const match = /^\/v1\/workflow-sessions\/([^/]+)(?:\/(items|events|cancel|retry))?$/.exec(url.pathname);
  if (!match) return null;
  return {
    sessionId: decodeURIComponent(match[1]),
    suffix: match[2] || "",
  };
}

function catalogSitePath(url: URL): { siteId: string; suffix: string } | null {
  const match = /^\/v1\/workflow-catalog\/sites\/([^/]+)(?:\/(tools))?$/.exec(url.pathname);
  if (!match) return null;
  return {
    siteId: decodeURIComponent(match[1]),
    suffix: match[2] || "",
  };
}

function catalogToolPath(url: URL): { toolId: string; suffix: string } | null {
  const match = /^\/v1\/workflow-catalog\/tools\/([^/]+)(?:\/(verify))?$/.exec(url.pathname);
  if (!match) return null;
  return {
    toolId: decodeURIComponent(match[1]),
    suffix: match[2] || "",
  };
}

async function authorizeOrReturn(req: IncomingMessage, res: ServerResponse): Promise<{ subject: string } | null> {
  try {
    return await authorizeWorkflowRequest(req);
  } catch (error) {
    if (error instanceof WorkflowAuthError) {
      sendJson(res, error.statusCode, { success: false, error: error.message, code: "workflow_auth_error" });
      return null;
    }
    throw error;
  }
}

const server = createServer(async (req, res) => {
  try {
    const method = req.method || "GET";
    const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);

    if (method === "GET" && url.pathname === "/health") {
      return sendJson(res, 200, { healthy: true });
    }

    if (method === "GET" && url.pathname === "/v1/workflow-metrics/daily") {
      const auth = await authorizeOrReturn(req, res);
      if (!auth) return;
      return sendJson(res, 200, { success: true, metrics: workflowRunManager.getDailyMetrics() });
    }

    if (method === "GET" && url.pathname === "/v1/workflow-catalog/tool-groups") {
      const auth = await authorizeOrReturn(req, res);
      if (!auth) return;
      return sendJson(res, 200, { success: true, groups: workflowToolGroups() });
    }

    if (url.pathname === "/v1/workflow-catalog/sites") {
      const auth = await authorizeOrReturn(req, res);
      if (!auth) return;
      if (method === "GET") {
        const sites = await workflowCatalogStore.listSites();
        return sendJson(res, 200, { success: true, sites });
      }
      if (method === "POST") {
        const body = (await readBody(req)) as WorkflowCatalogCreateSiteRequest;
        const site = await workflowCatalogStore.createSite(body);
        return sendJson(res, 201, { success: true, site });
      }
    }

    const catalogSite = catalogSitePath(url);
    if (catalogSite) {
      const auth = await authorizeOrReturn(req, res);
      if (!auth) return;
      const { siteId, suffix } = catalogSite;
      if (method === "PATCH" && suffix === "") {
        const body = (await readBody(req)) as WorkflowCatalogUpdateSiteRequest;
        const site = await workflowCatalogStore.updateSite(siteId, body || {});
        return sendJson(res, 200, { success: true, site });
      }
      if (method === "GET" && suffix === "tools") {
        const tools = await workflowCatalogStore.listToolsBySite(siteId);
        return sendJson(res, 200, { success: true, tools });
      }
      return sendJson(res, 404, { success: false, error: "catalog site route not found" });
    }

    if (url.pathname === "/v1/workflow-catalog/tools" && method === "POST") {
      const auth = await authorizeOrReturn(req, res);
      if (!auth) return;
      const body = (await readBody(req)) as WorkflowCatalogCreateToolRequest;
      const tool = await workflowCatalogStore.createTool(body);
      return sendJson(res, 201, { success: true, tool });
    }

    const catalogTool = catalogToolPath(url);
    if (catalogTool) {
      const auth = await authorizeOrReturn(req, res);
      if (!auth) return;
      const { toolId, suffix } = catalogTool;
      if (method === "PATCH" && suffix === "") {
        const body = (await readBody(req)) as WorkflowCatalogUpdateToolRequest;
        const tool = await workflowCatalogStore.updateTool(toolId, body || {});
        return sendJson(res, 200, { success: true, tool });
      }
      if (method === "DELETE" && suffix === "") {
        await workflowCatalogStore.deleteTool(toolId);
        return sendJson(res, 200, { success: true });
      }
      if (method === "POST" && suffix === "verify") {
        const body = (await readBody(req)) as WorkflowCatalogVerifyToolRequest;
        const tool = await workflowCatalogStore.getTool(toolId);
        const dryRun = workflowCatalogStore.verifyToolDryRun(tool, body || {});
        let sampleRun: { runId: string; status: string } | undefined;

        const runSample = body?.dryRun !== true;
        if (runSample) {
          const created = await workflowRunManager.createRun(
            {
              workflowKey: tool.workflowKey,
              operation: tool.operation,
              mode: "sync",
              runtime: body?.runtime as WorkflowSessionRequest["runtime"],
              items: [
                {
                  operation: tool.operation,
                  prompt: tool.promptTemplate,
                  input: body?.sampleInput || {},
                },
              ],
              metadata: {
                source: "tool_verify",
                toolId: tool.id,
                toolKey: tool.key,
              },
            },
            { actorSubject: auth.subject },
          );
          const waited = await workflowRunManager.waitForRun(created.run.id, workflowSyncTimeoutMs());
          sampleRun = { runId: created.run.id, status: waited.run.status };
          if (waited.run.status === "completed") {
            await workflowCatalogStore.markToolVerified(toolId);
          }
        } else if (dryRun.valid) {
          await workflowCatalogStore.markToolVerified(toolId);
        }

        const latestTool = await workflowCatalogStore.getTool(toolId);
        return sendJson(res, 200, {
          success: true,
          result: {
            tool: latestTool,
            dryRun,
            sampleRun,
          },
        });
      }
      return sendJson(res, 404, { success: false, error: "catalog tool route not found" });
    }

    if (url.pathname === "/v1/workflow-sessions" && method === "POST") {
      const auth = await authorizeOrReturn(req, res);
      if (!auth) return;
      const body = (await readBody(req)) as WorkflowSessionRequest;
      const sessionType = body.sessionType || "update";

      let selectedTools = [] as Awaited<ReturnType<typeof workflowCatalogStore.listToolsBySite>>;
      if (body.siteId) {
        selectedTools = await workflowCatalogStore.listToolsBySite(body.siteId);
      }
      if (Array.isArray(body.toolIds) && body.toolIds.length > 0) {
        const explicit = new Set(body.toolIds.map((x) => String(x || "").trim()).filter(Boolean));
        selectedTools = selectedTools.length
          ? selectedTools.filter((tool) => explicit.has(tool.id))
          : (
              await Promise.all([...explicit].map((id) => workflowCatalogStore.getTool(id).catch(() => null)))
            ).filter((tool): tool is NonNullable<typeof tool> => Boolean(tool));
      }

      if (selectedTools.length === 0) {
        return sendJson(res, 400, { success: false, error: "No tools selected for workflow session." });
      }

      const items = workflowCatalogStore.buildRunItemsFromTools(selectedTools, body.items || [], sessionType);
      const workflowKey = (body.workflowKey || selectedTools[0].workflowKey || "").trim();
      if (!workflowKey) {
        return sendJson(res, 400, { success: false, error: "workflowKey is required." });
      }

      const runRequest: WorkflowRunRequest = {
        workflowKey,
        operation: body.operation || selectedTools[0].operation,
        mode: body.mode || "async",
        runtime: body.runtime,
        selection: body.selection,
        metadata: {
          ...(body.metadata || {}),
          source: "workflow_session",
          sessionType,
          siteId: body.siteId || "",
          toolIds: selectedTools.map((tool) => tool.id),
          toolKeys: selectedTools.map((tool) => tool.key),
        },
        items,
      };

      const created = await workflowRunManager.createRun(runRequest, {
        actorSubject: auth.subject,
      });

      const mode = (runRequest.mode || "async").toLowerCase();
      if (mode === "sync") {
        const waited = await workflowRunManager.waitForRun(created.run.id, workflowSyncTimeoutMs());
        const statusCode = waited.completed ? 200 : 202;
        return sendJson(res, statusCode, {
          success: true,
          mode: "sync",
          completed: waited.completed,
          session: waited.run,
          items: workflowRunManager.listItems(created.run.id),
          itemIds: created.itemIds,
        });
      }
      return sendJson(res, 202, {
        success: true,
        mode: "async",
        session: created.run,
        itemIds: created.itemIds,
      });
    }

    if (url.pathname === "/v1/workflow-runs" && method === "POST") {
      const auth = await authorizeOrReturn(req, res);
      if (!auth) return;
      const body = (await readBody(req)) as WorkflowRunRequest;
      const created = await workflowRunManager.createRun(body, {
        actorSubject: auth.subject,
      });
      const mode = (body.mode || "async").toLowerCase();
      if (mode === "sync") {
        const waited = await workflowRunManager.waitForRun(created.run.id, workflowSyncTimeoutMs());
        const statusCode = waited.completed ? 200 : 202;
        return sendJson(res, statusCode, {
          success: true,
          mode: "sync",
          completed: waited.completed,
          run: waited.run,
          items: workflowRunManager.listItems(created.run.id),
          itemIds: created.itemIds,
        });
      }
      return sendJson(res, 202, {
        success: true,
        mode: "async",
        run: created.run,
        itemIds: created.itemIds,
      });
    }

    const workflowRunPath = runPath(url);
    if (workflowRunPath) {
      try {
        await authorizeWorkflowRequest(req);
      } catch (error) {
        if (error instanceof WorkflowAuthError) {
          return sendJson(res, error.statusCode, { success: false, error: error.message, code: "workflow_auth_error" });
        }
        throw error;
      }

      const { runId, suffix } = workflowRunPath;
      try {
        if (method === "GET" && suffix === "") {
          return sendJson(res, 200, { success: true, run: workflowRunManager.getRun(runId) });
        }

        if (method === "GET" && suffix === "items") {
          return sendJson(res, 200, { success: true, items: workflowRunManager.listItems(runId) });
        }

        if (method === "GET" && suffix === "events") {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            Connection: "keep-alive",
            "Cache-Control": "no-cache",
          });

          for (const event of workflowRunManager.getEvents(runId)) {
            writeSse(res, event);
          }

          const unsubscribe = workflowRunManager.subscribe(runId, (event) => writeSse(res, event));
          req.on("close", () => {
            unsubscribe();
            res.end();
          });
          return;
        }

        if (method === "POST" && suffix === "cancel") {
          const run = workflowRunManager.cancelRun(runId);
          return sendJson(res, 200, { success: true, run });
        }

        if (method === "POST" && suffix === "retry") {
          const body = (await readBody(req)) as WorkflowRetryRequest;
          const run = await workflowRunManager.retryRun(runId, body || {});
          return sendJson(res, 200, { success: true, run, items: workflowRunManager.listItems(runId) });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("not found")) {
          return sendJson(res, 404, { success: false, error: message });
        }
        throw error;
      }

      return sendJson(res, 404, { success: false, error: "Workflow run route not found" });
    }

    const workflowSessionPath = sessionPath(url);
    if (workflowSessionPath) {
      const auth = await authorizeOrReturn(req, res);
      if (!auth) return;
      const { sessionId, suffix } = workflowSessionPath;
      try {
        if (method === "GET" && suffix === "") {
          return sendJson(res, 200, { success: true, session: workflowRunManager.getRun(sessionId) });
        }
        if (method === "GET" && suffix === "items") {
          return sendJson(res, 200, { success: true, items: workflowRunManager.listItems(sessionId) });
        }
        if (method === "GET" && suffix === "events") {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            Connection: "keep-alive",
            "Cache-Control": "no-cache",
          });

          for (const event of workflowRunManager.getEvents(sessionId)) {
            writeSse(res, event);
          }

          const unsubscribe = workflowRunManager.subscribe(sessionId, (event) => writeSse(res, event));
          req.on("close", () => {
            unsubscribe();
            res.end();
          });
          return;
        }
        if (method === "POST" && suffix === "cancel") {
          const session = workflowRunManager.cancelRun(sessionId);
          return sendJson(res, 200, { success: true, session });
        }
        if (method === "POST" && suffix === "retry") {
          const body = (await readBody(req)) as WorkflowRetryRequest;
          const session = await workflowRunManager.retryRun(sessionId, body || {});
          return sendJson(res, 200, { success: true, session, items: workflowRunManager.listItems(sessionId) });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("not found")) {
          return sendJson(res, 404, { success: false, error: message });
        }
        throw error;
      }
      return sendJson(res, 404, { success: false, error: "Workflow session route not found" });
    }

    if (method === "POST" && url.pathname === "/v1/options") {
      const body = (await readBody(req)) as { threadId: string; options: Partial<RuntimeOptions> };
      if (!body.threadId) return sendJson(res, 400, { error: "threadId is required" });
      const options = bus.setOptions(body.threadId, body.options || {});
      return sendJson(res, 200, { success: true, options });
    }

    if (method === "GET" && url.pathname.startsWith("/v1/events/")) {
      const threadId = decodeURIComponent(url.pathname.slice("/v1/events/".length));
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        Connection: "keep-alive",
        "Cache-Control": "no-cache",
      });

      for (const event of bus.getHistory(threadId)) {
        writeSse(res, event);
      }

      const unsubscribe = bus.subscribe(threadId, (event) => writeSse(res, event));
      req.on("close", () => {
        unsubscribe();
        res.end();
      });
      return;
    }

    if (method === "GET" && url.pathname === "/v1/providers/models") {
      const route = (url.searchParams.get("route") || "local_ollama") as RuntimeOptions["providerRoute"];
      const models = await listProviderModels(route);
      return sendJson(res, 200, { models });
    }

    if (method === "GET" && url.pathname.startsWith("/v1/recordings/")) {
      const rest = url.pathname.slice("/v1/recordings/".length);
      const [threadId, segmentId] = rest.split("/");
      if (!threadId || !segmentId) return sendJson(res, 400, { error: "threadId and segmentId required" });
      const segment = bus.getRecording(threadId, segmentId);
      if (!segment) return sendJson(res, 404, { error: "segment not found" });
      return sendJson(res, 200, { segment });
    }

    if (method === "POST" && url.pathname === "/v1/intervene") {
      const body = (await readBody(req)) as { threadId: string };
      await runtimeManager.intervene(body.threadId);
      return sendJson(res, 200, { success: true });
    }

    if (method === "POST" && url.pathname === "/v1/resume") {
      const body = (await readBody(req)) as { threadId: string };
      await runtimeManager.resume(body.threadId);
      return sendJson(res, 200, { success: true });
    }

    if (method === "POST" && url.pathname === "/v1/run") {
      const body = (await readBody(req)) as RunPayload;
      if (!body.threadId || !body.message) {
        return sendJson(res, 400, { success: false, error: "threadId and message are required" });
      }

      const options = bus.setOptions(body.threadId, body.options || {});
      // Log runtime execution selection once per run for easier diagnostics.
      // eslint-disable-next-line no-console
      console.log(
        `[anorha-agent-runtime] run start thread=${body.threadId} backend=${options.runtimeBackend} route=${options.providerRoute} model=${options.providerModel || ""} mode=${process.env.BROWSER_USE_MODE || "mcp"}`,
      );

      try {
        const result = await runtimeManager.execute({
          threadId: body.threadId,
          message: body.message,
          options,
          startUrl: body.startUrl,
          emit: (event) => bus.emit(event),
          emitRecording: (segment) => bus.appendRecording(segment),
        });

        bus.emit({
          eventName: "tool_result",
          threadId: body.threadId,
          toolName: `runtime.${options.runtimeBackend}`,
          toolResult: result.success,
          content: result.summary,
          toolResultData: result.data,
        });

        if (!result.success) {
          const report: FailureReport = {
            threadId: body.threadId,
            runtimeBackend: options.runtimeBackend,
            errorClass: "RuntimeExecutionError",
            errorMessage: result.error || "Unknown runtime failure",
            stepTrace: ["planning", "tool_call", "tool_result"],
            artifacts: {
              providerRoute: options.providerRoute,
              providerModel: options.providerModel,
              runtimeBackend: options.runtimeBackend,
            },
          };
          bus.emit({
            eventName: "error",
            threadId: body.threadId,
            error: report.errorMessage,
            report,
          });
        }

        bus.emit({
          eventName: "done",
          threadId: body.threadId,
          content: result.success ? "Execution complete." : "Execution ended with errors.",
        });

        return sendJson(res, 200, { success: result.success, summary: result.summary, error: result.error });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        bus.emit({ eventName: "error", threadId: body.threadId, error: message });
        bus.emit({ eventName: "done", threadId: body.threadId, content: "Execution failed." });
        return sendJson(res, 500, { success: false, error: message });
      }
    }

    sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    sendJson(res, 500, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

server.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(`[anorha-agent-runtime] listening on http://${HOST}:${PORT}`);
});
