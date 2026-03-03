import { randomUUID } from "node:crypto";
import type {
  WorkflowCatalogCreateSiteRequest,
  WorkflowCatalogCreateToolRequest,
  WorkflowCatalogSite,
  WorkflowCatalogTool,
  WorkflowCatalogUpdateSiteRequest,
  WorkflowCatalogUpdateToolRequest,
  WorkflowCatalogVerifyToolRequest,
  WorkflowCatalogVerifyToolResponse,
  WorkflowOperation,
  WorkflowRuntimeOverrides,
  WorkflowStageName,
  WorkflowToolStatus,
} from "../types.js";

type CatalogTables = {
  sitesTable: string;
  toolsTable: string;
};

type SeedSite = {
  key: string;
  name: string;
  description: string;
  status: WorkflowCatalogSite["status"];
  domains: string[];
  workflowKey: string;
};

const DEFAULT_STAGE_PLAN: WorkflowStageName[] = [
  "navigate",
  "fill_data",
  "confirm",
  "complete",
  "verify",
];

const DEFAULT_TOOL_GROUPS = {
  listing_crud: "Listing CRUD",
  research: "Research",
  verification: "Verification",
};

const SEED_SITES: SeedSite[] = [
  {
    key: "facebook.marketplace",
    name: "Facebook Marketplace",
    description: "Primary production workflow pack for listing CRUD and research.",
    status: "active",
    domains: ["facebook.com", "m.facebook.com"],
    workflowKey: "facebook.marketplace.product",
  },
  {
    key: "ebay",
    name: "eBay",
    description: "Draft scaffold. Configure selectors, prompts, and verification before use.",
    status: "draft",
    domains: ["ebay.com"],
    workflowKey: "ebay.product",
  },
  {
    key: "shopify",
    name: "Shopify",
    description: "Draft scaffold. Configure selectors, prompts, and verification before use.",
    status: "draft",
    domains: ["admin.shopify.com"],
    workflowKey: "shopify.product",
  },
];

type PostgrestError = {
  message?: string;
  code?: string;
  details?: string;
};

export class WorkflowCatalogStore {
  private readonly sites = new Map<string, WorkflowCatalogSite>();
  private readonly tools = new Map<string, WorkflowCatalogTool>();
  private readonly supabaseUrl: string;
  private readonly supabaseKey: string;
  private readonly tables: CatalogTables;
  private loaded = false;
  private loadPromise: Promise<void> | null = null;

  constructor() {
    this.supabaseUrl = (process.env.SUPABASE_URL || "").trim().replace(/\/$/, "");
    this.supabaseKey = (
      process.env.SUPABASE_SERVICE_ROLE_KEY ||
      process.env.SUPABASE_SERVICE_KEY ||
      ""
    )
      .trim();
    const schema = (process.env.ANORHA_WORKFLOW_SUPABASE_SCHEMA || "public").trim();
    this.tables = {
      sitesTable: `${schema}.workflow_sites`,
      toolsTable: `${schema}.workflow_tools`,
    };
    this.seedDefaults();
  }

  async listSites(): Promise<WorkflowCatalogSite[]> {
    await this.ensureLoaded();
    return [...this.sites.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async createSite(input: WorkflowCatalogCreateSiteRequest): Promise<WorkflowCatalogSite> {
    await this.ensureLoaded();
    const now = new Date().toISOString();
    const site: WorkflowCatalogSite = {
      id: randomUUID(),
      key: String(input.key || "").trim(),
      name: String(input.name || "").trim(),
      description: String(input.description || "").trim() || undefined,
      status: input.status || "draft",
      domains: Array.isArray(input.domains)
        ? input.domains.map((x) => String(x || "").trim()).filter(Boolean)
        : [],
      createdAt: now,
      updatedAt: now,
    };
    if (!site.key) throw new Error("site key is required");
    if (!site.name) throw new Error("site name is required");

    await this.writeSite(site, "insert");
    this.sites.set(site.id, site);
    return site;
  }

  async updateSite(siteID: string, input: WorkflowCatalogUpdateSiteRequest): Promise<WorkflowCatalogSite> {
    await this.ensureLoaded();
    const existing = this.mustSite(siteID);
    const updated: WorkflowCatalogSite = {
      ...existing,
      name: input.name ? String(input.name).trim() : existing.name,
      description:
        input.description !== undefined
          ? String(input.description || "").trim() || undefined
          : existing.description,
      status: input.status || existing.status,
      domains: Array.isArray(input.domains)
        ? input.domains.map((x) => String(x || "").trim()).filter(Boolean)
        : existing.domains,
      updatedAt: new Date().toISOString(),
    };
    await this.writeSite(updated, "update");
    this.sites.set(updated.id, updated);
    return updated;
  }

  async listToolsBySite(siteID: string): Promise<WorkflowCatalogTool[]> {
    await this.ensureLoaded();
    this.mustSite(siteID);
    return [...this.tools.values()]
      .filter((tool) => tool.siteId === siteID)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async getTool(toolID: string): Promise<WorkflowCatalogTool> {
    await this.ensureLoaded();
    return this.mustTool(toolID);
  }

  async createTool(input: WorkflowCatalogCreateToolRequest): Promise<WorkflowCatalogTool> {
    await this.ensureLoaded();
    this.mustSite(input.siteId);
    const now = new Date().toISOString();
    const tool: WorkflowCatalogTool = {
      id: randomUUID(),
      siteId: input.siteId,
      key: String(input.key || "").trim(),
      name: String(input.name || "").trim(),
      description: String(input.description || "").trim() || undefined,
      group: String(input.group || "").trim() || "listing_crud",
      status: input.status || "draft",
      workflowKey: String(input.workflowKey || "").trim(),
      operation: input.operation,
      stagePlan: this.normalizeStagePlan(input.stagePlan),
      requiredFields: this.normalizeStringList(input.requiredFields),
      allowedFields: this.normalizeStringList(input.allowedFields),
      promptTemplate: String(input.promptTemplate || "").trim(),
      selectorHints: input.selectorHints,
      presetCode: String(input.presetCode || "").trim() || undefined,
      version: 1,
      verifiedAt: undefined,
      createdAt: now,
      updatedAt: now,
    };
    this.validateTool(tool);
    await this.writeTool(tool, "insert");
    this.tools.set(tool.id, tool);
    return tool;
  }

  async updateTool(toolID: string, input: WorkflowCatalogUpdateToolRequest): Promise<WorkflowCatalogTool> {
    await this.ensureLoaded();
    const existing = this.mustTool(toolID);
    const updated: WorkflowCatalogTool = {
      ...existing,
      name: input.name !== undefined ? String(input.name || "").trim() || existing.name : existing.name,
      description:
        input.description !== undefined
          ? String(input.description || "").trim() || undefined
          : existing.description,
      group: input.group !== undefined ? String(input.group || "").trim() || existing.group : existing.group,
      status: (input.status || existing.status) as WorkflowToolStatus,
      operation: input.operation || existing.operation,
      stagePlan: input.stagePlan ? this.normalizeStagePlan(input.stagePlan) : existing.stagePlan,
      requiredFields: input.requiredFields ? this.normalizeStringList(input.requiredFields) : existing.requiredFields,
      allowedFields: input.allowedFields ? this.normalizeStringList(input.allowedFields) : existing.allowedFields,
      promptTemplate:
        input.promptTemplate !== undefined
          ? String(input.promptTemplate || "").trim()
          : existing.promptTemplate,
      selectorHints: input.selectorHints !== undefined ? input.selectorHints : existing.selectorHints,
      presetCode:
        input.presetCode !== undefined
          ? String(input.presetCode || "").trim() || undefined
          : existing.presetCode,
      version: existing.version + 1,
      updatedAt: new Date().toISOString(),
    };
    this.validateTool(updated);
    await this.writeTool(updated, "update");
    this.tools.set(updated.id, updated);
    return updated;
  }

  async markToolVerified(toolID: string): Promise<WorkflowCatalogTool> {
    await this.ensureLoaded();
    const existing = this.mustTool(toolID);
    const updated: WorkflowCatalogTool = {
      ...existing,
      verifiedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: existing.version + 1,
      status: existing.status === "archived" ? "archived" : "active",
    };
    await this.writeTool(updated, "update");
    this.tools.set(updated.id, updated);
    return updated;
  }

  async deleteTool(toolID: string): Promise<void> {
    await this.ensureLoaded();
    const existing = this.mustTool(toolID);
    await this.deleteToolRemote(existing.id);
    this.tools.delete(existing.id);
  }

  buildRunItemsFromTools(
    tools: WorkflowCatalogTool[],
    requestedItems: Array<{ itemId?: string; externalItemId?: string; prompt?: string; input?: Record<string, unknown> }>,
    sessionType: "create" | "verify" | "update",
  ): Array<{
    itemId?: string;
    externalItemId?: string;
    operation: WorkflowOperation;
    prompt: string;
    input: Record<string, unknown>;
  }> {
    const baseItems = requestedItems.length > 0 ? requestedItems : [{ input: {} }];
    const output: Array<{
      itemId?: string;
      externalItemId?: string;
      operation: WorkflowOperation;
      prompt: string;
      input: Record<string, unknown>;
    }> = [];

    for (const tool of tools) {
      for (const item of baseItems) {
        const userPrompt = String(item.prompt || "").trim();
        const promptPrefix =
          sessionType === "verify"
            ? "Verify this workflow tool configuration and report missing fields."
            : sessionType === "update"
              ? "Update and harden this workflow tool for robustness."
              : "Use this workflow tool to execute the requested operation.";
        const prompt = [promptPrefix, `Tool: ${tool.name} (${tool.key})`, tool.promptTemplate, userPrompt]
          .filter(Boolean)
          .join("\n\n");
        output.push({
          itemId: item.itemId,
          externalItemId: item.externalItemId,
          operation: tool.operation,
          prompt,
          input: { ...(item.input || {}) },
        });
      }
    }
    return output;
  }

  verifyToolDryRun(
    tool: WorkflowCatalogTool,
    request: WorkflowCatalogVerifyToolRequest,
  ): WorkflowCatalogVerifyToolResponse["dryRun"] {
    const sample = request.sampleInput || {};
    const missing = tool.requiredFields.filter((field) => {
      const value = sample[field];
      return value === undefined || value === null || String(value).trim() === "";
    });
    const notes: string[] = [];
    if (!tool.promptTemplate.trim()) {
      notes.push("Prompt template is empty.");
    }
    if (!tool.workflowKey.trim()) {
      notes.push("Workflow key is empty.");
    }
    if (tool.stagePlan.length === 0) {
      notes.push("Stage plan is empty.");
    }
    return {
      valid: missing.length === 0 && notes.length === 0,
      missingFields: missing,
      notes,
    };
  }

  private normalizeStagePlan(stagePlan?: WorkflowStageName[]): WorkflowStageName[] {
    if (!Array.isArray(stagePlan) || stagePlan.length === 0) {
      return [...DEFAULT_STAGE_PLAN];
    }
    const allowed = new Set(DEFAULT_STAGE_PLAN);
    return stagePlan
      .map((x) => String(x || "").trim() as WorkflowStageName)
      .filter((x) => allowed.has(x));
  }

  private normalizeStringList(values?: string[]): string[] {
    if (!Array.isArray(values)) return [];
    return values.map((x) => String(x || "").trim()).filter(Boolean);
  }

  private validateTool(tool: WorkflowCatalogTool): void {
    if (!tool.siteId) throw new Error("tool siteId is required");
    if (!tool.key) throw new Error("tool key is required");
    if (!tool.name) throw new Error("tool name is required");
    if (!tool.workflowKey) throw new Error("tool workflowKey is required");
    if (!tool.promptTemplate) throw new Error("tool promptTemplate is required");
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    if (!this.loadPromise) {
      this.loadPromise = this.loadFromRemote().finally(() => {
        this.loaded = true;
      });
    }
    await this.loadPromise;
  }

  private async loadFromRemote(): Promise<void> {
    if (!this.hasSupabase()) {
      return;
    }
    try {
      const sites = await this.selectMany<WorkflowCatalogSite>(this.tables.sitesTable, "id,key,name,description,status,domains,created_at,updated_at");
      const tools = await this.selectMany<WorkflowCatalogTool>(
        this.tables.toolsTable,
        "id,site_id,key,name,description,group_key,status,workflow_key,operation,stage_plan,required_fields,allowed_fields,prompt_template,selector_hints,preset_code,version,verified_at,created_at,updated_at",
      );
      if (sites.length > 0) {
        this.sites.clear();
        for (const row of sites) {
          const normalized = this.fromSiteRow(row as unknown as Record<string, unknown>);
          this.sites.set(normalized.id, normalized);
        }
      }
      if (tools.length > 0) {
        this.tools.clear();
        for (const row of tools) {
          const normalized = this.fromToolRow(row as unknown as Record<string, unknown>);
          this.tools.set(normalized.id, normalized);
        }
      }
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn(`[workflow-catalog] failed to load from Supabase, using local seed cache: ${this.errorString(error)}`);
    }
  }

  private seedDefaults(): void {
    const now = new Date().toISOString();
    for (const seed of SEED_SITES) {
      const siteID = randomUUID();
      const site: WorkflowCatalogSite = {
        id: siteID,
        key: seed.key,
        name: seed.name,
        description: seed.description,
        status: seed.status,
        domains: [...seed.domains],
        createdAt: now,
        updatedAt: now,
      };
      this.sites.set(site.id, site);
      for (const tool of this.seedToolsForSite(site, seed.workflowKey, now)) {
        this.tools.set(tool.id, tool);
      }
    }
  }

  private seedToolsForSite(site: WorkflowCatalogSite, workflowKey: string, now: string): WorkflowCatalogTool[] {
    const status: WorkflowToolStatus = site.status === "active" ? "active" : "draft";
    const base = (
      key: string,
      name: string,
      group: string,
      operation: WorkflowOperation,
      promptTemplate: string,
      requiredFields: string[],
      allowedFields: string[],
    ): WorkflowCatalogTool => ({
      id: randomUUID(),
      siteId: site.id,
      key,
      name,
      description: `${name} tool for ${site.name}`,
      group,
      status,
      workflowKey,
      operation,
      stagePlan: [...DEFAULT_STAGE_PLAN],
      requiredFields,
      allowedFields,
      promptTemplate,
      selectorHints: undefined,
      presetCode: undefined,
      version: 1,
      verifiedAt: undefined,
      createdAt: now,
      updatedAt: now,
    });

    return [
      base(
        "create_item",
        "Create Item Tool",
        "listing_crud",
        "create",
        `Create a listing on ${site.name}. Fill required fields and confirm publish success.`,
        ["title", "price", "condition", "description", "location"],
        ["title", "price", "condition", "description", "location", "category", "photos"],
      ),
      base(
        "read_items",
        "Read All Items Tool",
        "listing_crud",
        "read",
        `Read listings from ${site.name} and extract structured inventory data.`,
        ["externalItemId"],
        ["externalItemId", "url"],
      ),
      base(
        "update_item",
        "Update Item Tool",
        "listing_crud",
        "update",
        `Update an existing listing on ${site.name} with provided fields and verify changes.`,
        ["externalItemId"],
        ["externalItemId", "title", "price", "condition", "description", "location", "photos", "status"],
      ),
      base(
        "delete_item",
        "Delete Item Tool",
        "listing_crud",
        "delete",
        `Delete or archive an existing listing on ${site.name} and confirm it no longer appears active.`,
        ["externalItemId"],
        ["externalItemId", "url", "reason"],
      ),
      base(
        "pricing_research",
        "Pricing Research Tool",
        "research",
        "read",
        `Research comparable listings on ${site.name} and suggest competitive pricing.`,
        [],
        ["title", "condition", "brand", "model", "location"],
      ),
      base(
        "market_scan",
        "Market Scan Tool",
        "research",
        "read",
        `Scan marketplace results on ${site.name} and summarize trends.`,
        [],
        ["query", "location", "category"],
      ),
      base(
        "verify_listing",
        "Verify Listing Tool",
        "verification",
        "read",
        `Verify listing completeness on ${site.name} and report missing data or blocked steps.`,
        ["externalItemId"],
        ["externalItemId", "url"],
      ),
    ];
  }

  private mustSite(siteID: string): WorkflowCatalogSite {
    const site = this.sites.get(String(siteID || "").trim());
    if (!site) {
      throw new Error(`site '${siteID}' not found`);
    }
    return site;
  }

  private mustTool(toolID: string): WorkflowCatalogTool {
    const tool = this.tools.get(String(toolID || "").trim());
    if (!tool) {
      throw new Error(`tool '${toolID}' not found`);
    }
    return tool;
  }

  private hasSupabase(): boolean {
    return Boolean(this.supabaseUrl && this.supabaseKey);
  }

  private async selectMany<T>(table: string, select: string): Promise<T[]> {
    const url = `${this.supabaseUrl}/rest/v1/${table}?select=${encodeURIComponent(select)}`;
    const resp = await fetch(url, {
      method: "GET",
      headers: this.supabaseHeaders(),
    });
    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`select failed ${resp.status}: ${body.slice(0, 300)}`);
    }
    const json = (await resp.json()) as T[];
    return Array.isArray(json) ? json : [];
  }

  private async writeSite(site: WorkflowCatalogSite, mode: "insert" | "update"): Promise<void> {
    if (!this.hasSupabase()) return;
    const row = this.toSiteRow(site);
    if (mode === "insert") {
      await this.insertRows(this.tables.sitesTable, [row]);
      return;
    }
    await this.patchRow(this.tables.sitesTable, `id=eq.${encodeURIComponent(site.id)}`, row);
  }

  private async writeTool(tool: WorkflowCatalogTool, mode: "insert" | "update"): Promise<void> {
    if (!this.hasSupabase()) return;
    const row = this.toToolRow(tool);
    if (mode === "insert") {
      await this.insertRows(this.tables.toolsTable, [row]);
      return;
    }
    await this.patchRow(this.tables.toolsTable, `id=eq.${encodeURIComponent(tool.id)}`, row);
  }

  private async deleteToolRemote(toolID: string): Promise<void> {
    if (!this.hasSupabase()) return;
    const url = `${this.supabaseUrl}/rest/v1/${this.tables.toolsTable}?id=eq.${encodeURIComponent(toolID)}`;
    const resp = await fetch(url, {
      method: "DELETE",
      headers: {
        ...this.supabaseHeaders(),
        Prefer: "return=minimal",
      },
    });
    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`delete tool failed ${resp.status}: ${body.slice(0, 300)}`);
    }
  }

  private async insertRows(table: string, rows: Record<string, unknown>[]): Promise<void> {
    const url = `${this.supabaseUrl}/rest/v1/${table}`;
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        ...this.supabaseHeaders(),
        Prefer: "return=representation,resolution=merge-duplicates",
      },
      body: JSON.stringify(rows),
    });
    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`insert failed ${resp.status}: ${body.slice(0, 500)}`);
    }
  }

  private async patchRow(table: string, filter: string, row: Record<string, unknown>): Promise<void> {
    const url = `${this.supabaseUrl}/rest/v1/${table}?${filter}`;
    const resp = await fetch(url, {
      method: "PATCH",
      headers: {
        ...this.supabaseHeaders(),
        Prefer: "return=representation",
      },
      body: JSON.stringify(row),
    });
    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`update failed ${resp.status}: ${body.slice(0, 500)}`);
    }
  }

  private supabaseHeaders(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      apikey: this.supabaseKey,
      Authorization: `Bearer ${this.supabaseKey}`,
    };
  }

  private toSiteRow(site: WorkflowCatalogSite): Record<string, unknown> {
    return {
      id: site.id,
      key: site.key,
      name: site.name,
      description: site.description || null,
      status: site.status,
      domains: site.domains,
      created_at: site.createdAt,
      updated_at: site.updatedAt,
    };
  }

  private toToolRow(tool: WorkflowCatalogTool): Record<string, unknown> {
    return {
      id: tool.id,
      site_id: tool.siteId,
      key: tool.key,
      name: tool.name,
      description: tool.description || null,
      group_key: tool.group,
      status: tool.status,
      workflow_key: tool.workflowKey,
      operation: tool.operation,
      stage_plan: tool.stagePlan,
      required_fields: tool.requiredFields,
      allowed_fields: tool.allowedFields,
      prompt_template: tool.promptTemplate,
      selector_hints: tool.selectorHints || null,
      preset_code: tool.presetCode || null,
      version: tool.version,
      verified_at: tool.verifiedAt || null,
      created_at: tool.createdAt,
      updated_at: tool.updatedAt,
    };
  }

  private fromSiteRow(row: Record<string, unknown>): WorkflowCatalogSite {
    return {
      id: String(row.id || ""),
      key: String(row.key || ""),
      name: String(row.name || ""),
      description: row.description ? String(row.description) : undefined,
      status: (String(row.status || "draft") as WorkflowCatalogSite["status"]),
      domains: Array.isArray(row.domains) ? row.domains.map((x) => String(x || "")) : [],
      createdAt: String(row.created_at || new Date().toISOString()),
      updatedAt: String(row.updated_at || new Date().toISOString()),
    };
  }

  private fromToolRow(row: Record<string, unknown>): WorkflowCatalogTool {
    return {
      id: String(row.id || ""),
      siteId: String(row.site_id || ""),
      key: String(row.key || ""),
      name: String(row.name || ""),
      description: row.description ? String(row.description) : undefined,
      group: String(row.group_key || "listing_crud"),
      status: String(row.status || "draft") as WorkflowToolStatus,
      workflowKey: String(row.workflow_key || ""),
      operation: String(row.operation || "read") as WorkflowOperation,
      stagePlan: Array.isArray(row.stage_plan)
        ? row.stage_plan.map((x) => String(x || "").trim() as WorkflowStageName).filter(Boolean)
        : [...DEFAULT_STAGE_PLAN],
      requiredFields: Array.isArray(row.required_fields)
        ? row.required_fields.map((x) => String(x || "").trim()).filter(Boolean)
        : [],
      allowedFields: Array.isArray(row.allowed_fields)
        ? row.allowed_fields.map((x) => String(x || "").trim()).filter(Boolean)
        : [],
      promptTemplate: String(row.prompt_template || ""),
      selectorHints:
        row.selector_hints && typeof row.selector_hints === "object"
          ? (row.selector_hints as Record<string, unknown>)
          : undefined,
      presetCode: row.preset_code ? String(row.preset_code) : undefined,
      version: Number(row.version || 1),
      verifiedAt: row.verified_at ? String(row.verified_at) : undefined,
      createdAt: String(row.created_at || new Date().toISOString()),
      updatedAt: String(row.updated_at || new Date().toISOString()),
    };
  }

  private errorString(error: unknown): string {
    if (error && typeof error === "object") {
      const maybe = error as PostgrestError;
      if (maybe.message) return maybe.message;
    }
    return error instanceof Error ? error.message : String(error);
  }
}

export function workflowToolGroups(): Record<string, string> {
  return { ...DEFAULT_TOOL_GROUPS };
}
