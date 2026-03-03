import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  cancelWorkflowSession,
  createWorkflowCatalogTool,
  createWorkflowSession,
  deleteWorkflowCatalogTool,
  getWorkflowAuthToken,
  getWorkflowSession,
  listWorkflowCatalogSites,
  listWorkflowCatalogSiteTools,
  listWorkflowSessionItems,
  retryWorkflowSessionItems,
  streamWorkflowSessionEvents,
  type WorkflowCatalogTool,
  type WorkflowOperation,
  type WorkflowRunEvent,
  type WorkflowRunItemView,
  type WorkflowSessionType,
  updateWorkflowCatalogTool,
  verifyWorkflowCatalogTool,
} from "@/api";

type ToolFormState = {
  id?: string;
  key: string;
  name: string;
  description: string;
  group: string;
  workflowKey: string;
  operation: WorkflowOperation;
  promptTemplate: string;
  requiredFields: string;
  allowedFields: string;
  presetCode: string;
};

const EMPTY_TOOL_FORM: ToolFormState = {
  key: "",
  name: "",
  description: "",
  group: "listing_crud",
  workflowKey: "",
  operation: "create",
  promptTemplate: "",
  requiredFields: "",
  allowedFields: "",
  presetCode: "",
};

function listFromCsv(value: string): string[] {
  return value
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function toCsv(values: string[] | undefined): string {
  return Array.isArray(values) ? values.join(", ") : "";
}

export default function WorkflowStudio() {
  const queryClient = useQueryClient();
  const [workflowToken, setWorkflowToken] = useState<string>(getWorkflowAuthToken());
  const [selectedSiteId, setSelectedSiteId] = useState<string>("");
  const [expandedSites, setExpandedSites] = useState<Record<string, boolean>>({});
  const [selectedToolIds, setSelectedToolIds] = useState<string[]>([]);
  const [toolForm, setToolForm] = useState<ToolFormState>(EMPTY_TOOL_FORM);
  const [sessionType, setSessionType] = useState<WorkflowSessionType>("create");
  const [sessionOperation, setSessionOperation] = useState<WorkflowOperation>("create");
  const [sessionItemsText, setSessionItemsText] = useState<string>('{"title":"","price":"","condition":"","description":"","location":""}');
  const [activeSessionId, setActiveSessionId] = useState<string>("");
  const [sessionEvents, setSessionEvents] = useState<WorkflowRunEvent[]>([]);
  const [sessionSummary, setSessionSummary] = useState<string>("");

  const sitesQuery = useQuery({
    queryKey: ["workflow-catalog-sites", workflowToken],
    queryFn: () => listWorkflowCatalogSites(workflowToken),
  });

  const selectedSite = useMemo(() => {
    return sitesQuery.data?.sites.find((site) => site.id === selectedSiteId) || null;
  }, [sitesQuery.data?.sites, selectedSiteId]);

  const toolsQuery = useQuery({
    queryKey: ["workflow-catalog-tools", selectedSiteId, workflowToken],
    queryFn: () => listWorkflowCatalogSiteTools(selectedSiteId, workflowToken),
    enabled: Boolean(selectedSiteId),
  });

  const sessionQuery = useQuery({
    queryKey: ["workflow-session", activeSessionId, workflowToken],
    queryFn: () => getWorkflowSession(activeSessionId, workflowToken),
    enabled: Boolean(activeSessionId),
    refetchInterval: 3000,
  });

  const sessionItemsQuery = useQuery({
    queryKey: ["workflow-session-items", activeSessionId, workflowToken],
    queryFn: () => listWorkflowSessionItems(activeSessionId, workflowToken),
    enabled: Boolean(activeSessionId),
    refetchInterval: 3000,
  });

  useEffect(() => {
    const sites = sitesQuery.data?.sites || [];
    if (!selectedSiteId && sites.length > 0) {
      setSelectedSiteId(sites[0].id);
    }
  }, [sitesQuery.data?.sites, selectedSiteId]);

  useEffect(() => {
    if (!activeSessionId) return;
    let cancelled = false;
    (async () => {
      try {
        for await (const event of streamWorkflowSessionEvents(activeSessionId, workflowToken)) {
          if (cancelled) return;
          setSessionEvents((prev) => [...prev.slice(-149), event]);
        }
      } catch (error) {
        if (!cancelled) {
          const message = error instanceof Error ? error.message : String(error);
          setSessionSummary(message);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeSessionId, workflowToken]);

  const saveToolMutation = useMutation({
    mutationFn: async () => {
      if (!selectedSiteId) throw new Error("Select a site first.");
      const payload = {
        siteId: selectedSiteId,
        key: toolForm.key.trim(),
        name: toolForm.name.trim(),
        description: toolForm.description.trim() || undefined,
        group: toolForm.group.trim() || "listing_crud",
        workflowKey: toolForm.workflowKey.trim(),
        operation: toolForm.operation,
        promptTemplate: toolForm.promptTemplate.trim(),
        requiredFields: listFromCsv(toolForm.requiredFields),
        allowedFields: listFromCsv(toolForm.allowedFields),
        presetCode: toolForm.presetCode.trim() || undefined,
      };

      if (toolForm.id) {
        return await updateWorkflowCatalogTool(toolForm.id, payload, workflowToken);
      }
      return await createWorkflowCatalogTool(payload, workflowToken);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["workflow-catalog-tools", selectedSiteId, workflowToken] });
      setSessionSummary("Tool saved.");
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : String(error);
      setSessionSummary(message);
    },
  });

  const deleteToolMutation = useMutation({
    mutationFn: async (toolID: string) => await deleteWorkflowCatalogTool(toolID, workflowToken),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["workflow-catalog-tools", selectedSiteId, workflowToken] });
      setSelectedToolIds((prev) => prev.filter((id) => id !== toolForm.id));
      if (toolForm.id) {
        setToolForm(EMPTY_TOOL_FORM);
      }
      setSessionSummary("Tool deleted.");
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : String(error);
      setSessionSummary(message);
    },
  });

  const verifyToolMutation = useMutation({
    mutationFn: async (toolID: string) => {
      const sampleInput = parseJsonValue(sessionItemsText);
      return await verifyWorkflowCatalogTool(
        toolID,
        {
          dryRun: false,
          sampleInput,
        },
        workflowToken,
      );
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["workflow-catalog-tools", selectedSiteId, workflowToken] });
      const sample = data.result.sampleRun;
      if (sample?.runId) {
        setActiveSessionId(sample.runId);
        setSessionSummary(`Verification queued as session ${sample.runId}.`);
      } else {
        setSessionSummary("Dry-run verification complete.");
      }
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : String(error);
      setSessionSummary(message);
    },
  });

  const createSessionMutation = useMutation({
    mutationFn: async () => {
      if (!selectedSite) throw new Error("Select a site first.");
      if (selectedToolIds.length === 0) throw new Error("Select at least one tool.");
      const sampleInput = parseJsonValue(sessionItemsText);
      return await createWorkflowSession(
        {
          workflowKey: toolForm.workflowKey.trim() || "facebook.marketplace.product",
          operation: sessionOperation,
          mode: "async",
          sessionType,
          siteId: selectedSite.id,
          toolIds: selectedToolIds,
          items: [
            {
              operation: sessionOperation,
              input: sampleInput,
            },
          ],
          metadata: {
            uiSource: "workflow_studio",
          },
        },
        workflowToken,
      );
    },
    onSuccess: (data) => {
      setSessionEvents([]);
      setActiveSessionId(data.session.id);
      setSessionSummary(`Session queued: ${data.session.id}`);
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : String(error);
      setSessionSummary(message);
    },
  });

  const groupedTools = useMemo(() => {
    const tools = toolsQuery.data?.tools || [];
    const groups: Record<string, WorkflowCatalogTool[]> = {};
    for (const tool of tools) {
      if (!groups[tool.group]) groups[tool.group] = [];
      groups[tool.group].push(tool);
    }
    return groups;
  }, [toolsQuery.data?.tools]);

  const session = sessionQuery.data?.session;
  const sessionItems = sessionItemsQuery.data?.items || [];

  return (
    <div className="h-full w-full min-h-0 overflow-hidden bg-white dark:bg-neutral-900 text-neutral-900 dark:text-neutral-100">
      <div className="flex h-full min-h-0">
        <div className="w-[280px] border-r border-neutral-200 dark:border-neutral-800 p-3 overflow-y-auto">
          <div className="mb-3">
            <div className="text-xs uppercase tracking-wide text-neutral-500">Workflow Auth Token</div>
            <div className="mt-1 flex gap-2">
              <input
                type="password"
                value={workflowToken}
                onChange={(e) => setWorkflowToken(e.target.value)}
                className="w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-transparent px-2 py-1 text-xs"
                placeholder="Bearer token (optional in dev)"
              />
              <button
                type="button"
                className="rounded-md bg-neutral-900 px-2 py-1 text-xs text-white dark:bg-neutral-200 dark:text-black"
                onClick={() => {
                  localStorage.setItem("anorha.workflow.token", workflowToken.trim());
                  setSessionSummary("Workflow token saved locally.");
                }}
              >
                Save
              </button>
            </div>
          </div>

          <div className="text-xs uppercase tracking-wide text-neutral-500 mb-2">Sites</div>
          <div className="space-y-2">
            {(sitesQuery.data?.sites || []).map((site) => {
              const expanded = expandedSites[site.id] ?? true;
              const active = selectedSiteId === site.id;
              return (
                <div
                  key={site.id}
                  className={`rounded-lg border p-2 ${active ? "border-blue-500 bg-blue-50 dark:bg-blue-950/30" : "border-neutral-200 dark:border-neutral-800"}`}
                >
                  <button
                    type="button"
                    className="w-full text-left"
                    onClick={() => {
                      setSelectedSiteId(site.id);
                      setExpandedSites((prev) => ({ ...prev, [site.id]: !expanded }));
                    }}
                  >
                    <div className="flex items-center justify-between">
                      <div className="font-medium text-sm">{site.name}</div>
                      <span
                        className={`text-[10px] rounded px-1.5 py-0.5 ${
                          site.status === "active"
                            ? "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-200"
                            : "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200"
                        }`}
                      >
                        {site.status}
                      </span>
                    </div>
                    <div className="mt-1 text-xs text-neutral-500">{site.key}</div>
                  </button>
                  {expanded && (
                    <div className="mt-2 text-xs text-neutral-500">
                      {(site.domains || []).join(", ") || "No domains configured"}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        <div className="w-[360px] border-r border-neutral-200 dark:border-neutral-800 p-3 overflow-y-auto">
          <div className="text-xs uppercase tracking-wide text-neutral-500 mb-2">Tools by Group</div>
          {!selectedSiteId && <div className="text-sm text-neutral-500">Select a site</div>}
          {selectedSiteId &&
            Object.entries(groupedTools).map(([group, tools]) => (
              <div key={group} className="mb-4">
                <div className="text-[11px] uppercase tracking-wide text-neutral-500 mb-1">{group}</div>
                <div className="space-y-1">
                  {tools.map((tool) => {
                    const checked = selectedToolIds.includes(tool.id);
                    return (
                      <div
                        key={tool.id}
                        className={`rounded-md border px-2 py-1.5 ${toolForm.id === tool.id ? "border-blue-500 bg-blue-50 dark:bg-blue-950/30" : "border-neutral-200 dark:border-neutral-800"}`}
                      >
                        <div className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(e) => {
                              setSelectedToolIds((prev) =>
                                e.target.checked
                                  ? [...new Set([...prev, tool.id])]
                                  : prev.filter((id) => id !== tool.id),
                              );
                            }}
                          />
                          <button
                            type="button"
                            className="flex-1 text-left"
                            onClick={() => {
                              setToolForm({
                                id: tool.id,
                                key: tool.key,
                                name: tool.name,
                                description: tool.description || "",
                                group: tool.group,
                                workflowKey: tool.workflowKey,
                                operation: tool.operation,
                                promptTemplate: tool.promptTemplate,
                                requiredFields: toCsv(tool.requiredFields),
                                allowedFields: toCsv(tool.allowedFields),
                                presetCode: tool.presetCode || "",
                              });
                            }}
                          >
                            <div className="text-sm font-medium">{tool.name}</div>
                            <div className="text-[11px] text-neutral-500">
                              {tool.operation} • v{tool.version} • {tool.status}
                            </div>
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
        </div>

        <div className="flex-1 min-w-0 p-3 overflow-y-auto">
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            <div className="rounded-lg border border-neutral-200 dark:border-neutral-800 p-3">
              <div className="flex items-center justify-between mb-2">
                <div className="font-semibold">Tool Editor</div>
                <button
                  type="button"
                  className="text-xs rounded bg-neutral-100 dark:bg-neutral-800 px-2 py-1"
                  onClick={() => setToolForm({ ...EMPTY_TOOL_FORM, workflowKey: selectedSite?.key === "facebook.marketplace" ? "facebook.marketplace.product" : "" })}
                >
                  New
                </button>
              </div>
              <div className="space-y-2">
                <LabeledInput label="Key" value={toolForm.key} onChange={(value) => setToolForm((prev) => ({ ...prev, key: value }))} />
                <LabeledInput label="Name" value={toolForm.name} onChange={(value) => setToolForm((prev) => ({ ...prev, name: value }))} />
                <LabeledInput
                  label="Description"
                  value={toolForm.description}
                  onChange={(value) => setToolForm((prev) => ({ ...prev, description: value }))}
                />
                <LabeledInput
                  label="Group"
                  value={toolForm.group}
                  onChange={(value) => setToolForm((prev) => ({ ...prev, group: value }))}
                />
                <LabeledInput
                  label="Workflow Key"
                  value={toolForm.workflowKey}
                  onChange={(value) => setToolForm((prev) => ({ ...prev, workflowKey: value }))}
                />
                <div>
                  <label className="text-xs text-neutral-500">Operation</label>
                  <select
                    value={toolForm.operation}
                    onChange={(e) => setToolForm((prev) => ({ ...prev, operation: e.target.value as WorkflowOperation }))}
                    className="mt-1 w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-transparent px-2 py-1 text-sm"
                  >
                    <option value="create">create</option>
                    <option value="read">read</option>
                    <option value="update">update</option>
                    <option value="delete">delete</option>
                  </select>
                </div>
                <LabeledInput
                  label="Required Fields (comma separated)"
                  value={toolForm.requiredFields}
                  onChange={(value) => setToolForm((prev) => ({ ...prev, requiredFields: value }))}
                />
                <LabeledInput
                  label="Allowed Fields (comma separated)"
                  value={toolForm.allowedFields}
                  onChange={(value) => setToolForm((prev) => ({ ...prev, allowedFields: value }))}
                />
                <LabeledArea
                  label="Prompt Template"
                  value={toolForm.promptTemplate}
                  onChange={(value) => setToolForm((prev) => ({ ...prev, promptTemplate: value }))}
                />
                <LabeledArea
                  label="Preset Playwright Code (optional)"
                  value={toolForm.presetCode}
                  onChange={(value) => setToolForm((prev) => ({ ...prev, presetCode: value }))}
                />
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  className="rounded-md bg-blue-600 text-white px-3 py-1.5 text-sm"
                  onClick={() => saveToolMutation.mutate()}
                  disabled={saveToolMutation.isPending || !selectedSiteId}
                >
                  {saveToolMutation.isPending ? "Saving..." : "Save Tool"}
                </button>
                {toolForm.id && (
                  <>
                    <button
                      type="button"
                      className="rounded-md bg-emerald-600 text-white px-3 py-1.5 text-sm"
                      onClick={() => verifyToolMutation.mutate(toolForm.id!)}
                      disabled={verifyToolMutation.isPending}
                    >
                      {verifyToolMutation.isPending ? "Verifying..." : "Verify Tool"}
                    </button>
                    <button
                      type="button"
                      className="rounded-md bg-red-600 text-white px-3 py-1.5 text-sm"
                      onClick={() => deleteToolMutation.mutate(toolForm.id!)}
                      disabled={deleteToolMutation.isPending}
                    >
                      Delete Tool
                    </button>
                  </>
                )}
              </div>
            </div>

            <div className="rounded-lg border border-neutral-200 dark:border-neutral-800 p-3">
              <div className="font-semibold mb-2">Work Session Queue</div>
              <div className="space-y-2">
                <div>
                  <label className="text-xs text-neutral-500">Session Type</label>
                  <select
                    value={sessionType}
                    onChange={(e) => setSessionType(e.target.value as WorkflowSessionType)}
                    className="mt-1 w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-transparent px-2 py-1 text-sm"
                  >
                    <option value="create">create</option>
                    <option value="verify">verify</option>
                    <option value="update">update</option>
                  </select>
                </div>
                <div>
                  <label className="text-xs text-neutral-500">Operation</label>
                  <select
                    value={sessionOperation}
                    onChange={(e) => setSessionOperation(e.target.value as WorkflowOperation)}
                    className="mt-1 w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-transparent px-2 py-1 text-sm"
                  >
                    <option value="create">create</option>
                    <option value="read">read</option>
                    <option value="update">update</option>
                    <option value="delete">delete</option>
                  </select>
                </div>
                <LabeledArea
                  label="Sample Item JSON"
                  value={sessionItemsText}
                  onChange={setSessionItemsText}
                />
                <button
                  type="button"
                  className="rounded-md bg-neutral-900 text-white dark:bg-neutral-100 dark:text-black px-3 py-1.5 text-sm"
                  onClick={() => createSessionMutation.mutate()}
                  disabled={createSessionMutation.isPending || selectedToolIds.length === 0}
                >
                  {createSessionMutation.isPending ? "Queueing..." : `Queue Session (${selectedToolIds.length} tools)`}
                </button>

                {activeSessionId && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button
                      type="button"
                      className="rounded-md bg-amber-600 text-white px-2 py-1 text-xs"
                      onClick={async () => {
                        await retryWorkflowSessionItems(activeSessionId, undefined, workflowToken);
                        setSessionSummary("Retry requested.");
                      }}
                    >
                      Retry Failed
                    </button>
                    <button
                      type="button"
                      className="rounded-md bg-red-700 text-white px-2 py-1 text-xs"
                      onClick={async () => {
                        await cancelWorkflowSession(activeSessionId, workflowToken);
                        setSessionSummary("Cancel requested.");
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                )}
              </div>

              <div className="mt-4">
                <div className="text-xs uppercase tracking-wide text-neutral-500 mb-1">Session Status</div>
                <div className="rounded-md bg-neutral-50 dark:bg-neutral-800/60 p-2 text-xs">
                  {session ? (
                    <div>
                      <div>ID: {session.id}</div>
                      <div>Status: {session.status}</div>
                      <div>
                        Progress: {session.totals.succeeded + session.totals.failed + session.totals.canceled}/
                        {session.totals.total}
                      </div>
                    </div>
                  ) : (
                    <div>No session selected.</div>
                  )}
                </div>
              </div>

              <div className="mt-3">
                <div className="text-xs uppercase tracking-wide text-neutral-500 mb-1">Items</div>
                <div className="max-h-36 overflow-y-auto space-y-1">
                  {sessionItems.map((item) => (
                    <SessionItemRow key={item.id} item={item} />
                  ))}
                </div>
              </div>

              <div className="mt-3">
                <div className="text-xs uppercase tracking-wide text-neutral-500 mb-1">Live Events</div>
                <div className="max-h-40 overflow-y-auto rounded-md border border-neutral-200 dark:border-neutral-800 p-2 space-y-1">
                  {sessionEvents.slice(-30).map((event, idx) => (
                    <div key={`${idx}-${event.eventName}`} className="text-xs">
                      <span className="font-semibold">{event.eventName}</span>
                      {" "}
                      {"summary" in event && event.summary ? event.summary : ""}
                      {"stage" in event ? `stage=${event.stage} status=${event.status}` : ""}
                      {"error" in event && event.error ? `error=${event.error}` : ""}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {sessionSummary && (
            <div className="mt-4 rounded-md bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 p-3 text-sm">
              {sessionSummary}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function SessionItemRow({ item }: { item: WorkflowRunItemView }) {
  const statusColor =
    item.status === "succeeded"
      ? "text-emerald-700 dark:text-emerald-300"
      : item.status === "failed"
        ? "text-red-700 dark:text-red-300"
        : item.status === "running"
          ? "text-blue-700 dark:text-blue-300"
          : "text-neutral-600 dark:text-neutral-300";
  return (
    <div className="rounded border border-neutral-200 dark:border-neutral-800 px-2 py-1">
      <div className="flex items-center justify-between">
        <span className="text-xs">#{item.index}</span>
        <span className={`text-xs font-semibold ${statusColor}`}>{item.status}</span>
      </div>
      <div className="text-xs text-neutral-500">{item.currentStage || "pending"} • {item.operation}</div>
      {item.error && <div className="text-xs text-red-600 dark:text-red-300">{item.error}</div>}
      {item.missingFields.length > 0 && (
        <div className="text-[11px] text-amber-700 dark:text-amber-200">
          missing: {item.missingFields.join(", ")}
        </div>
      )}
    </div>
  );
}

function LabeledInput(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div>
      <label className="text-xs text-neutral-500">{props.label}</label>
      <input
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        className="mt-1 w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-transparent px-2 py-1 text-sm"
      />
    </div>
  );
}

function LabeledArea(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div>
      <label className="text-xs text-neutral-500">{props.label}</label>
      <textarea
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        rows={5}
        className="mt-1 w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-transparent px-2 py-1 text-sm font-mono"
      />
    </div>
  );
}

function parseJsonValue(input: string): Record<string, unknown> {
  const trimmed = input.trim();
  if (!trimmed) return {};
  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}
