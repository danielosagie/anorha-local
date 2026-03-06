import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { ProviderRoute, RuntimeExecutionRequest } from "./types.js";

export type BrowserUseTransport = "openai_compat" | "ollama_native";
export type BrowserUseStructuredOutputMode = "strict" | "relaxed";
export type BrowserUseRuntimeSource = "dev-external" | "bundled-macos" | "bundled-windows";

export interface BrowserUseHealth {
  runtimeBundleFound: boolean;
  browserBundleFound: boolean;
  mcpBootOk: boolean;
  providerConfigOk: boolean;
}

export interface BrowserUseLLMSelection {
  route: ProviderRoute;
  model: string;
  transport: BrowserUseTransport;
  structuredOutputMode: BrowserUseStructuredOutputMode;
  flashMode: boolean;
  useThinking: boolean;
  runtimeSource: BrowserUseRuntimeSource;
  bundledRuntimeDir?: string;
  bundledBrowserDir?: string;
  health: BrowserUseHealth;
  env: Record<string, string>;
}

export interface BrowserUseLaunchSpec {
  command: string;
  runtimeSource: BrowserUseRuntimeSource;
  bundledRuntimeDir?: string;
  bundledBrowserDir?: string;
  health: BrowserUseHealth;
}

interface BrowserUseRuntimeManifest {
  version?: string;
  browserUseVersion?: string;
  playwrightVersion?: string;
  python?: {
    macos?: string[];
    windows?: string[];
  };
  browserUseMcpCommand?: {
    macos?: string;
    windows?: string;
  };
  browserPaths?: {
    macos?: string;
    windows?: string;
  };
}

export function resolveBrowserUseSelection(request: RuntimeExecutionRequest): BrowserUseLLMSelection {
  const route = request.options.providerRoute;
  const model = resolveRequestedModel(request);
  const runtimeSource = detectRuntimeSource();
  const bundledRuntimeDir = detectBundledRuntimeDir(runtimeSource);
  const bundledBrowserDir = detectBundledBrowserDir(runtimeSource);
  const transport = resolveTransport(route);
  const smallFastModel = isSmallFastModel(model);
  const strictSchemaSafe = resolveStrictSchemaSafe(route);
  const reasoningSafe = resolveReasoningSafe(route);
  const structuredOutputMode = strictSchemaSafe ? "strict" : "relaxed";
  const flashMode = forceBooleanOverride("BROWSER_USE_FORCE_FLASH_MODE", smallFastModel || route === "local_ollama");
  const useThinking = forceBooleanOverride("BROWSER_USE_FORCE_THINKING", reasoningSafe && !flashMode);
  const providerConfigOk = validateProviderConfig(route);
  const env = buildProviderEnv({
    route,
    model,
    transport,
    structuredOutputMode,
    flashMode,
    useThinking,
    bundledRuntimeDir,
    bundledBrowserDir,
    request,
  });

  return {
    route,
    model,
    transport,
    structuredOutputMode,
    flashMode,
    useThinking,
    runtimeSource,
    bundledRuntimeDir,
    bundledBrowserDir,
    health: {
      runtimeBundleFound: Boolean(bundledRuntimeDir),
      browserBundleFound: Boolean(bundledBrowserDir),
      mcpBootOk: false,
      providerConfigOk,
    },
    env,
  };
}

export function resolveBrowserUseLaunchSpec(selection: BrowserUseLLMSelection): BrowserUseLaunchSpec {
  const explicit = (process.env.BROWSER_USE_MCP_CMD || "").trim();
  if (explicit) {
    return {
      command: explicit,
      runtimeSource: selection.runtimeSource,
      bundledRuntimeDir: selection.bundledRuntimeDir,
      bundledBrowserDir: selection.bundledBrowserDir,
      health: selection.health,
    };
  }

  const wrapperPath = resolveWrapperEntrypoint();
  const command = `${shellQuote(process.execPath)} ${shellQuote(wrapperPath)}`;
  return {
    command,
    runtimeSource: selection.runtimeSource,
    bundledRuntimeDir: selection.bundledRuntimeDir,
    bundledBrowserDir: selection.bundledBrowserDir,
    health: selection.health,
  };
}

export function resolveBundledInnerMcpCommand(runtimeDir?: string): string | null {
  const bundled = runtimeDir || detectBundledRuntimeDir(detectRuntimeSource());
  if (!bundled) {
    return null;
  }

  const manifest = loadRuntimeManifest(bundled);
  const byManifest = process.platform === "win32"
    ? manifest?.browserUseMcpCommand?.windows
    : manifest?.browserUseMcpCommand?.macos;
  if (byManifest) {
    const target = path.resolve(bundled, byManifest);
    if (existsSync(target)) {
      return shellCommandForExecutable(target);
    }
  }

  const candidates = process.platform === "win32"
    ? [
        path.join(bundled, "Scripts", "browser-use.exe"),
        path.join(bundled, "Scripts", "browser-use.cmd"),
        path.join(bundled, "Scripts", "python.exe"),
      ]
    : [
        path.join(bundled, "bin", "browser-use"),
        path.join(bundled, "bin", "python3"),
        path.join(bundled, "bin", "python"),
      ];

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    if (path.basename(candidate).startsWith("python")) {
      const wrapperScript = path.join(bundled, "python", "browser_use_mcp_wrapper.py");
      if (existsSync(wrapperScript)) {
        return `${shellQuote(candidate)} ${shellQuote(wrapperScript)}`;
      }
      continue;
    }
    return `${shellQuote(candidate)} --mcp`;
  }

  return null;
}

export function resolveInnerBrowserUseFallbackCommand(): string {
  const explicit = (process.env.BROWSER_USE_MCP_INNER_CMD || process.env.ANORHA_BROWSER_USE_INNER_CMD || "").trim();
  if (explicit) {
    return explicit;
  }
  const legacy = (process.env.BROWSER_USE_CMD || "").trim();
  if (legacy && /\b--mcp\b/.test(legacy)) {
    return legacy;
  }
  return "uvx --from browser-use browser-use --mcp";
}

function resolveRequestedModel(request: RuntimeExecutionRequest): string {
  const forced = (process.env.BROWSER_USE_FORCE_MODEL || "").trim();
  if (forced) return forced;
  const requested = (request.options.providerModel || "").trim();
  if (requested) return requested;
  switch (request.options.providerRoute) {
    case "ollama_cloud":
      return (process.env.OLLAMA_CLOUD_MODEL || process.env.OLLAMA_MODEL || "").trim();
    case "openrouter":
      return (process.env.OPENROUTER_MODEL || "").trim();
    case "kimi":
      return (process.env.ANORHA_AGENT_MODEL || "").trim();
    default:
      return (process.env.OLLAMA_MODEL || "").trim();
  }
}

function resolveTransport(route: ProviderRoute): BrowserUseTransport {
  const forced = (process.env.BROWSER_USE_LLM_TRANSPORT || "auto").trim().toLowerCase();
  if (forced === "ollama_native") return "ollama_native";
  if (forced === "openai_compat") return "openai_compat";

  if (route === "local_ollama") {
    const nativeEnabled = forceBooleanOverride("BROWSER_USE_ENABLE_NATIVE_OLLAMA", false);
    return nativeEnabled ? "ollama_native" : "openai_compat";
  }

  return "openai_compat";
}

function resolveStrictSchemaSafe(route: ProviderRoute): boolean {
  return forceBooleanOverride("BROWSER_USE_FORCE_STRICT_SCHEMA", route !== "local_ollama");
}

function resolveReasoningSafe(route: ProviderRoute): boolean {
  if (route === "local_ollama") {
    return false;
  }
  return true;
}

function buildProviderEnv(input: {
  route: ProviderRoute;
  model: string;
  transport: BrowserUseTransport;
  structuredOutputMode: BrowserUseStructuredOutputMode;
  flashMode: boolean;
  useThinking: boolean;
  bundledRuntimeDir?: string;
  bundledBrowserDir?: string;
  request: RuntimeExecutionRequest;
}): Record<string, string> {
  const {
    route,
    model,
    transport,
    structuredOutputMode,
    flashMode,
    useThinking,
    bundledRuntimeDir,
    bundledBrowserDir,
    request,
  } = input;

  const env: Record<string, string> = {
    ANORHA_BROWSER_USE_PROVIDER_ROUTE: route,
    ANORHA_BROWSER_USE_MODEL: model,
    ANORHA_BROWSER_USE_PLANNER_MODEL: model,
    ANORHA_BROWSER_USE_TRANSPORT: transport,
    ANORHA_BROWSER_USE_STRUCTURED_OUTPUT: structuredOutputMode,
    ANORHA_BROWSER_USE_FLASH_MODE: flashMode ? "1" : "0",
    ANORHA_BROWSER_USE_USE_THINKING: useThinking ? "1" : "0",
    ANORHA_BROWSER_USE_HEADLESS: request.options.headless ? "1" : "0",
  };

  if (bundledRuntimeDir) {
    env.BROWSER_USE_BUNDLED_RUNTIME_DIR = bundledRuntimeDir;
  }
  if (bundledBrowserDir) {
    env.BROWSER_USE_BUNDLED_BROWSER_DIR = bundledBrowserDir;
    env.PLAYWRIGHT_BROWSERS_PATH = bundledBrowserDir;
  }

  const browserName = (process.env.BROWSER_USE_MCP_BROWSER || "").trim();
  const profileName = (process.env.BROWSER_USE_MCP_PROFILE || "").trim();
  const sessionName = (process.env.BROWSER_USE_MCP_SESSION || request.threadId || "").trim();
  if (browserName) env.BROWSER_USE_BROWSER = browserName;
  if (profileName) env.BROWSER_USE_PROFILE = profileName;
  if (sessionName) env.BROWSER_USE_SESSION = sessionName;

  if (transport === "ollama_native") {
    const host = (process.env.BROWSER_USE_OLLAMA_HOST || process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434")
      .trim()
      .replace(/\/v1\/?$/, "")
      .replace(/\/$/, "");
    env.ANORHA_BROWSER_USE_PLANNER_PROVIDER = "ollama";
    env.ANORHA_BROWSER_USE_OLLAMA_HOST = host;
    env.ANORHA_BROWSER_USE_OLLAMA_MODEL = model;
    return env;
  }

  env.ANORHA_BROWSER_USE_PLANNER_PROVIDER = "openai_compat";
  env.BROWSER_USE_LLM_MODEL = model;
  switch (route) {
    case "local_ollama":
      env.OPENAI_BASE_URL = (process.env.BROWSER_USE_LOCAL_OPENAI_BASE_URL || "http://127.0.0.1:11434/v1").trim();
      env.OPENAI_API_KEY = (process.env.BROWSER_USE_LOCAL_OPENAI_API_KEY || "ollama").trim();
      break;
    case "ollama_cloud": {
      const hostBase = (process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434").trim().replace(/\/$/, "");
      env.OPENAI_BASE_URL = (process.env.OLLAMA_CLOUD_BASE_URL || `${hostBase}/v1`).trim();
      env.OPENAI_API_KEY = (process.env.OLLAMA_CLOUD_API_KEY || "ollama").trim();
      break;
    }
    case "openrouter":
      env.OPENAI_BASE_URL = (process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1").trim();
      env.OPENAI_API_KEY = (process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY || "").trim();
      break;
    case "kimi":
      env.OPENAI_BASE_URL = (process.env.MOONSHOT_BASE_URL || "https://api.moonshot.cn/v1").trim();
      env.OPENAI_API_KEY = (process.env.MOONSHOT_API_KEY || process.env.OPENAI_API_KEY || "").trim();
      break;
  }
  if (model) {
    env.OPENAI_MODEL = model;
  }
  return env;
}

function validateProviderConfig(route: ProviderRoute): boolean {
  if (route === "local_ollama" || route === "ollama_cloud") {
    return true;
  }
  if (route === "openrouter") {
    return Boolean((process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY || "").trim());
  }
  if (route === "kimi") {
    return Boolean((process.env.MOONSHOT_API_KEY || process.env.OPENAI_API_KEY || "").trim());
  }
  return true;
}

function detectRuntimeSource(): BrowserUseRuntimeSource {
  const explicit = (process.env.BROWSER_USE_RUNTIME_SOURCE || "").trim();
  if (explicit === "bundled-macos" || explicit === "bundled-windows" || explicit === "dev-external") {
    return explicit;
  }
  if (process.platform === "win32" && detectBundledRuntimeDir("bundled-windows")) {
    return "bundled-windows";
  }
  if (process.platform === "darwin" && detectBundledRuntimeDir("bundled-macos")) {
    return "bundled-macos";
  }
  return process.platform === "win32" ? "bundled-windows" : process.platform === "darwin" ? "bundled-macos" : "dev-external";
}

function detectBundledRuntimeDir(source: BrowserUseRuntimeSource): string | undefined {
  const explicit = (process.env.BROWSER_USE_BUNDLED_RUNTIME_DIR || "").trim();
  if (explicit && existsSync(explicit)) {
    return explicit;
  }
  const resourcesDir = resolveResourcesDir();
  if (!resourcesDir) {
    return undefined;
  }
  const candidate = path.join(resourcesDir, "browser-use-runtime");
  if (existsSync(candidate)) {
    return candidate;
  }
  if (source === "dev-external") {
    return undefined;
  }
  return undefined;
}

function detectBundledBrowserDir(source: BrowserUseRuntimeSource): string | undefined {
  const explicit = (process.env.BROWSER_USE_BUNDLED_BROWSER_DIR || "").trim();
  if (explicit && existsSync(explicit)) {
    return explicit;
  }
  const resourcesDir = resolveResourcesDir();
  if (!resourcesDir) {
    return undefined;
  }
  const candidate = path.join(resourcesDir, "browser-use-browsers");
  if (existsSync(candidate)) {
    return candidate;
  }
  if (source === "dev-external") {
    return undefined;
  }
  return undefined;
}

function resolveResourcesDir(): string | undefined {
  const explicit = (process.env.ANORHA_APP_RESOURCES_DIR || "").trim();
  if (explicit && existsSync(explicit)) {
    return explicit;
  }
  return undefined;
}

function resolveWrapperEntrypoint(): string {
  const currentDir = path.dirname(new URL(import.meta.url).pathname);
  const distPath = path.resolve(currentDir, "browser-use-mcp-wrapper.js");
  if (existsSync(distPath)) {
    return distPath;
  }
  return path.resolve(process.cwd(), "app", "agent-runtime", "dist", "browser-use-mcp-wrapper.js");
}

function loadRuntimeManifest(runtimeDir: string): BrowserUseRuntimeManifest | null {
  try {
    const manifestPath = path.join(runtimeDir, "manifest.json");
    if (!existsSync(manifestPath)) return null;
    return JSON.parse(readFileSync(manifestPath, "utf8")) as BrowserUseRuntimeManifest;
  } catch {
    return null;
  }
}

function shellCommandForExecutable(executablePath: string): string {
  if (/\.(?:cmd|bat)$/i.test(executablePath)) {
    return shellQuote(executablePath);
  }
  return shellQuote(executablePath);
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9._/:=-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function forceBooleanOverride(key: string, fallback: boolean): boolean {
  const raw = (process.env[key] || "").trim().toLowerCase();
  if (!raw) return fallback;
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function isSmallFastModel(model: string): boolean {
  const normalized = model.toLowerCase();
  return (
    normalized.includes(":0.5b") ||
    normalized.includes(":0.8b") ||
    normalized.includes(":1b") ||
    normalized.includes("mini") ||
    normalized.includes("nano")
  );
}
