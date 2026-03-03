import type { ProviderRoute } from "./types.js";

async function jsonOrNull(response: Response): Promise<any> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error("request timeout")), timeoutMs);
    }),
  ]).finally(() => {
    clearTimeout(timeout);
    controller.abort();
  }) as Promise<T>;
}

export async function listProviderModels(route: ProviderRoute): Promise<string[]> {
  try {
    if (route === "local_ollama" || route === "ollama_cloud") {
      const base = (route === "ollama_cloud"
        ? process.env.OLLAMA_CLOUD_BASE_URL || process.env.OLLAMA_BASE_URL
        : process.env.OLLAMA_BASE_URL) || "http://127.0.0.1:11434";
      const res = await withTimeout(fetch(`${base.replace(/\/$/, "")}/api/tags`), 8000);
      if (!res.ok) throw new Error(`ollama tags failed: ${res.status}`);
      const body = await jsonOrNull(res);
      return Array.from(new Set((body?.models || []).map((x: any) => String(x?.name || "").trim()).filter(Boolean)));
    }

    if (route === "openrouter") {
      const apiKey = process.env.OPENROUTER_API_KEY;
      if (!apiKey) return [];
      const res = await withTimeout(
        fetch("https://openrouter.ai/api/v1/models", {
          headers: { Authorization: `Bearer ${apiKey}` },
        }),
        9000,
      );
      if (!res.ok) throw new Error(`openrouter models failed: ${res.status}`);
      const body = await jsonOrNull(res);
      return Array.from(new Set((body?.data || []).map((x: any) => String(x?.id || "").trim()).filter(Boolean)));
    }

    const apiKey = process.env.MOONSHOT_API_KEY;
    const base = process.env.MOONSHOT_BASE_URL || "https://api.moonshot.cn/v1";
    if (!apiKey) return [];
    const res = await withTimeout(
      fetch(`${base.replace(/\/$/, "")}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      }),
      9000,
    );
    if (!res.ok) throw new Error(`kimi models failed: ${res.status}`);
    const body = await jsonOrNull(res);
    return Array.from(new Set((body?.data || []).map((x: any) => String(x?.id || "").trim()).filter(Boolean)));
  } catch {
    return Array.from(
      new Set(
        [
          process.env.OLLAMA_MODEL,
          process.env.OLLAMA_CLOUD_MODEL,
          process.env.ANORHA_AGENT_MODEL,
          "gpt-oss:20b",
          "llama3.2-vision:11b",
          "moonshot-v1-8k-vision-preview",
        ]
          .filter((x): x is string => Boolean(x))
          .map((x) => x.trim())
          .filter(Boolean),
      ),
    );
  }
}
