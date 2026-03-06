import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  resolveBundledInnerMcpCommand,
  resolveInnerBrowserUseFallbackCommand,
} from "./browser-use-launcher.js";

function main(): void {
  const bundledRuntimeDir = (process.env.BROWSER_USE_BUNDLED_RUNTIME_DIR || "").trim();
  const innerCommand =
    resolveBundledInnerMcpCommand(bundledRuntimeDir || undefined) || resolveInnerBrowserUseFallbackCommand();
  const pythonWrapper = resolvePythonWrapperPath(bundledRuntimeDir);
  const pythonExecutable = resolvePythonExecutable(bundledRuntimeDir);
  const command = pythonWrapper && pythonExecutable
    ? `${shellQuote(pythonExecutable)} ${shellQuote(pythonWrapper)}`
    : innerCommand;

  const child = spawn(command, {
    shell: true,
    stdio: "inherit",
    env: buildChildEnv(bundledRuntimeDir, innerCommand),
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });

  child.on("error", (error) => {
    console.error(`[anorha-browser-use-wrapper] spawn failed: ${error.message}`);
    process.exit(1);
  });
}

function buildChildEnv(bundledRuntimeDir: string, innerCommand: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  env.BROWSER_USE_MCP_INNER_CMD = innerCommand;
  if (bundledRuntimeDir && existsSync(bundledRuntimeDir)) {
    const binDir = process.platform === "win32"
      ? path.join(bundledRuntimeDir, "Scripts")
      : path.join(bundledRuntimeDir, "bin");
    if (existsSync(binDir)) {
      env.PATH = `${binDir}${path.delimiter}${env.PATH || ""}`;
    }
    const pythonLib = path.join(bundledRuntimeDir, "python");
    if (existsSync(pythonLib)) {
      env.ANORHA_BROWSER_USE_PYTHON_DIR = pythonLib;
    }
  }
  return env;
}

function resolvePythonWrapperPath(bundledRuntimeDir: string): string | null {
  const candidates = bundledRuntimeDir
    ? [path.join(bundledRuntimeDir, "python", "browser_use_mcp_wrapper.py")]
    : [];
  const localCandidate = path.resolve(process.cwd(), "app", "browser-use-runtime", "python", "browser_use_mcp_wrapper.py");
  candidates.push(localCandidate);
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function resolvePythonExecutable(bundledRuntimeDir: string): string | null {
  const candidates = bundledRuntimeDir
    ? process.platform === "win32"
      ? [path.join(bundledRuntimeDir, "Scripts", "python.exe"), path.join(bundledRuntimeDir, "python.exe")]
      : [path.join(bundledRuntimeDir, "bin", "python3"), path.join(bundledRuntimeDir, "bin", "python")]
    : [];

  if (process.platform === "win32") {
    candidates.push("python");
  } else {
    candidates.push("python3", "python");
  }

  for (const candidate of candidates) {
    if (!candidate) continue;
    if (candidate === "python" || candidate === "python3") {
      return candidate;
    }
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9._/:=-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

main();
