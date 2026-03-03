import type {
  RuntimeAdapter,
  RuntimeExecutionRequest,
  RuntimeExecutionResult,
} from "../types.js";
import {
  HybridPlannerClient,
  type HybridPlannerAction,
} from "./hybrid-planner-client.js";

interface TaggedElement {
  id: string;
  selector: string;
  tag: string;
  role: string;
  text: string;
  placeholder: string;
  ariaLabel: string;
}

interface PageSnapshot {
  url: string;
  title: string;
  textSnippet: string;
  elements: TaggedElement[];
}

interface StepOutcome {
  success: boolean;
  status: "success" | "failed" | "paused";
  error?: string;
  evidence?: string;
  data?: Record<string, unknown>;
}

interface ThreadState {
  pinnedTab?: {
    index: number;
    url: string;
    title: string;
    selectedAt: number;
  };
  paused?: {
    reason: string;
    step: number;
    question?: string;
  };
  history: Array<Record<string, unknown>>;
  lastStep: number;
  presetTaskKey?: string;
  presetActions?: HybridPlannerAction[];
  presetScript?: string;
}

export class PlaywrightAttachedRuntimeAdapter implements RuntimeAdapter {
  readonly name = "playwright_attached" as const;
  private readonly threadStates = new Map<string, ThreadState>();

  async execute(request: RuntimeExecutionRequest): Promise<RuntimeExecutionResult> {
    if (this.isResetRequest(request.message || "")) {
      this.threadStates.delete(request.threadId);
      request.emit({
        eventName: "tool_result",
        threadId: request.threadId,
        toolName: "runtime.state_reset",
        toolResult: true,
        content: "Attached runtime state reset for this chat thread.",
      });
      return {
        success: true,
        summary: "Attached runtime state reset.",
        data: { reset: true },
      };
    }

    const playwright = await this.loadPlaywright();
    if (!playwright) {
      throw new Error(
        "Playwright is not installed for attached-browser mode. Run `npm install playwright` in app/agent-runtime.",
      );
    }

    const planner = HybridPlannerClient.fromOptions(request.options);
    const plannerPrecondition = planner.validatePreconditions();
    if (plannerPrecondition) {
      throw new Error(`attached_precondition_failed: ${plannerPrecondition}`);
    }

    const cdpURL = this.cdpURL(request);
    request.emit({
      eventName: "tool_call",
      threadId: request.threadId,
      toolName: "runtime.playwright_attached",
      content: `Attaching to existing Chrome via CDP at ${cdpURL}`,
    });

    let browser: any;
    try {
      browser = await playwright.chromium.connectOverCDP(cdpURL);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`attached_precondition_failed: ${msg}`);
    }

    const state = this.getThreadState(request.threadId);
    const taskKey = this.taskKey(request.message || "");
    const continueRun = this.isContinueRequest(request.message || "") && !!state.paused;
    if (!continueRun) {
      state.history = [];
      state.lastStep = 0;
      state.paused = undefined;
    }

    try {
      const context = browser.contexts()[0] || (await browser.newContext());
      const pages = context.pages();
      await this.emitTabQuestion(request, pages, state);
      let page = await this.selectPageForRequest(request, pages, state);
      if (!page) {
        page = await context.newPage();
      }
      await page.bringToFront();

      request.emit({
        eventName: "control_state",
        threadId: request.threadId,
        controlled: true,
        runtime: this.name,
      });

      if (request.options.controlBorderEnabled) {
        await this.injectControlBorder(page);
      }

      const initialURL = this.extractURL(request.startUrl || request.message || "");
      if (initialURL) {
        await this.emitStepResult(request, 0, {
          success: true,
          status: "success",
          evidence: `Navigating to ${initialURL}`,
          data: { action: "navigate", url: initialURL },
        });
        await page.goto(initialURL, { waitUntil: "domcontentloaded", timeout: 30000 });
      }

      const maxSteps = this.maxSteps(request);
      let startStep = continueRun ? Math.max(1, state.lastStep + 1) : 1;
      if (!continueRun) {
        startStep = await this.replayPresetSteps(request, page, state, taskKey, startStep);
      }
      const finalStep = startStep + maxSteps - 1;

      for (let step = startStep; step <= finalStep; step++) {
        const snapshot = await this.capturePageSnapshot(page);
        const loginReason = this.detectLoginWall(snapshot);
        if (loginReason) {
          state.paused = {
            reason: loginReason,
            step,
            question: "Login wall detected. Please sign in and reply 'continue'.",
          };
          state.lastStep = step;
          await this.emitStepResult(request, step, {
            success: true,
            status: "paused",
            evidence: "Paused at login wall awaiting authentication.",
            data: { reason: loginReason, kind: "login_required" },
          });
          request.emit({
            eventName: "tool_result",
            threadId: request.threadId,
            toolName: "runtime.login_required",
            toolResult: true,
            content:
              "Login wall detected. Complete sign-in in the attached browser tab, then send 'continue' to resume.",
            toolResultData: {
              reason: loginReason,
              url: snapshot.url,
              step,
            },
          });
          this.emitPlaywrightPreset(request, state, taskKey);
          return {
            success: true,
            summary: `Paused for login at ${snapshot.url}`,
            data: { paused: true, reason: loginReason, url: snapshot.url, step },
          };
        }

        const action = await planner.nextAction({
          task: request.message,
          step,
          maxSteps: finalStep,
          page: snapshot,
          history: state.history,
        });

        request.emit({
          eventName: "tool_call",
          threadId: request.threadId,
          toolName: "runtime.step",
          content: `Step ${step}/${finalStep}: ${this.describeAction(action)}`,
        });

        const outcome = await this.executeAction(page, action);
        state.lastStep = step;
        state.history.push({
          step,
          action,
          status: outcome.status,
          success: outcome.success,
          error: outcome.error,
          evidence: outcome.evidence,
        });

        await this.emitStepResult(request, step, {
          ...outcome,
          data: {
            action: action.action,
            ...(outcome.data || {}),
          },
        });

        if (action.action === "ask_user") {
          state.paused = {
            reason: action.reason || "user_input_required",
            step,
            question: action.question || "Need user clarification.",
          };
          request.emit({
            eventName: "tool_result",
            threadId: request.threadId,
            toolName: "runtime.context_question",
            toolResult: true,
            content: action.question || "Need additional context to proceed.",
            toolResultData: {
              question: action.question || "Need additional context to proceed.",
              assumption: action.reason || "Paused for user input.",
              step,
            },
          });
          this.emitPlaywrightPreset(request, state, taskKey);
          return {
            success: true,
            summary: action.question || "Paused awaiting user input.",
            data: { paused: true, question: action.question, step },
          };
        }

        if (action.action === "finish") {
          this.emitPlaywrightPreset(request, state, taskKey);
          state.paused = undefined;
          state.history = [];
          state.lastStep = 0;
          const finalAnswer = (action.answer || outcome.evidence || "Task completed.").trim();
          return {
            success: true,
            summary: finalAnswer,
            data: {
              attached: true,
              url: page.url(),
              title: await page.title(),
              finalAnswer,
            },
          };
        }
      }

      state.paused = {
        reason: "max_steps_reached",
        step: finalStep,
        question: "Reached max steps. Reply 'continue' to keep going or refine your instruction.",
      };
      this.emitPlaywrightPreset(request, state, taskKey);
      return {
        success: true,
        summary: `Reached max steps (${finalStep}). Reply 'continue' to proceed.`,
        data: { paused: true, reason: "max_steps_reached", step: finalStep },
      };
    } finally {
      request.emit({
        eventName: "control_state",
        threadId: request.threadId,
        controlled: false,
        runtime: this.name,
      });
      await browser.close();
    }
  }

  private getThreadState(threadId: string): ThreadState {
    const existing = this.threadStates.get(threadId);
    if (existing) return existing;
    const created: ThreadState = {
      history: [],
      lastStep: 0,
    };
    this.threadStates.set(threadId, created);
    return created;
  }

  private async emitStepResult(request: RuntimeExecutionRequest, step: number, outcome: StepOutcome): Promise<void> {
    request.emit({
      eventName: "tool_result",
      threadId: request.threadId,
      toolName: "runtime.step",
      toolResult: outcome.success,
      content: `Step ${step}: ${outcome.status}${outcome.evidence ? ` - ${outcome.evidence}` : ""}${outcome.error ? ` (${outcome.error})` : ""}`,
      toolResultData: {
        step,
        status: outcome.status,
        success: outcome.success,
        error: outcome.error,
        evidence: outcome.evidence,
        ...(outcome.data || {}),
      },
    });
  }

  private async replayPresetSteps(
    request: RuntimeExecutionRequest,
    page: any,
    state: ThreadState,
    taskKey: string,
    startStep: number,
  ): Promise<number> {
    if (!taskKey || !state.presetTaskKey || !this.isTaskKeyReusable(taskKey, state.presetTaskKey)) {
      return startStep;
    }
    const presetActions = Array.isArray(state.presetActions) ? state.presetActions : [];
    if (presetActions.length === 0) {
      return startStep;
    }

    request.emit({
      eventName: "tool_call",
      threadId: request.threadId,
      toolName: "runtime.playwright_preset",
      content: `Replaying ${presetActions.length} preset Playwright steps for similar task.`,
    });

    let step = startStep;
    for (const action of presetActions) {
      const outcome = await this.executeAction(page, action);
      state.lastStep = step;
      state.history.push({
        step,
        action,
        status: outcome.status,
        success: outcome.success,
        error: outcome.error,
        evidence: outcome.evidence,
        preset: true,
      });
      await this.emitStepResult(request, step, {
        ...outcome,
        data: {
          action: action.action,
          preset: true,
          ...(outcome.data || {}),
        },
      });
      if (!outcome.success) {
        request.emit({
          eventName: "tool_result",
          threadId: request.threadId,
          toolName: "runtime.playwright_preset",
          toolResult: false,
          content: "Preset replay hit a failure. Falling back to planner gap-fill from current page state.",
          toolResultData: {
            failedStep: step,
            failedAction: action.action,
            error: outcome.error || "",
          },
        });
        step += 1;
        break;
      }
      step += 1;
    }
    return step;
  }

  private emitPlaywrightPreset(
    request: RuntimeExecutionRequest,
    state: ThreadState,
    taskKey: string,
  ): void {
    const successfulActions = state.history
      .filter((entry) => entry.success === true)
      .map((entry) => this.historyAction(entry))
      .filter((action): action is HybridPlannerAction => Boolean(action))
      .filter((action) => action.action !== "finish" && action.action !== "ask_user");

    if (successfulActions.length === 0) {
      return;
    }

    const code = this.buildPresetCode(request.message || "", successfulActions, state.history);
    state.presetTaskKey = taskKey;
    state.presetActions = successfulActions.slice(0, 30);
    state.presetScript = code;

    request.emit({
      eventName: "tool_result",
      threadId: request.threadId,
      toolName: "runtime.playwright_preset",
      toolResult: true,
      content:
        "Generated reusable Playwright preset from successful steps. Next similar task will replay this first, then planner fills gaps.",
      toolResultData: {
        taskKey,
        reusableSteps: state.presetActions.length,
        language: "typescript",
        code,
      },
    });
  }

  private historyAction(entry: Record<string, unknown>): HybridPlannerAction | null {
    const action = entry.action;
    if (!action || typeof action !== "object") return null;
    const candidate = action as HybridPlannerAction;
    if (!candidate.action) return null;
    return candidate;
  }

  private buildPresetCode(
    task: string,
    actions: HybridPlannerAction[],
    history: Array<Record<string, unknown>>,
  ): string {
    const lines: string[] = [];
    lines.push(`// Auto-generated from attached runtime history`);
    lines.push(`// Task: ${task}`);
    lines.push(`import { chromium } from "playwright";`);
    lines.push(``);
    lines.push(`(async () => {`);
    lines.push(`  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");`);
    lines.push(`  const context = browser.contexts()[0] || await browser.newContext();`);
    lines.push(`  const page = context.pages()[0] || await context.newPage();`);
    lines.push(``);
    for (const action of actions) {
      switch (action.action) {
        case "navigate":
          if (action.url) {
            lines.push(`  await page.goto(${JSON.stringify(action.url)}, { waitUntil: "domcontentloaded" });`);
          }
          break;
        case "click":
          if (action.selector) {
            lines.push(`  await page.locator(${JSON.stringify(action.selector)}).first().click({ force: true });`);
          }
          break;
        case "type":
          if (action.selector) {
            lines.push(`  await page.locator(${JSON.stringify(action.selector)}).first().fill(${JSON.stringify(action.text || "")});`);
          }
          break;
        case "press":
          lines.push(`  await page.keyboard.press(${JSON.stringify(action.key || "Enter")});`);
          break;
        case "scroll":
          lines.push(`  await page.mouse.wheel(0, ${Number(action.deltaY || 700)});`);
          break;
        case "wait":
          lines.push(`  await page.waitForTimeout(${Number(action.waitMs || 1000)});`);
          break;
        case "extract":
          lines.push(`  const extracted = await page.evaluate(() => document.body?.innerText || "");`);
          lines.push(`  console.log(extracted.slice(0, 1500));`);
          break;
      }
    }

    const failedActions = history.filter((entry) => entry.success === false);
    if (failedActions.length > 0) {
      lines.push(``);
      lines.push(`  // Planner gap-fill TODOs from failed steps:`);
      for (const failed of failedActions.slice(0, 5)) {
        const action = this.historyAction(failed);
        const step = Number(failed.step || 0);
        const err = String(failed.error || "");
        lines.push(`  // Step ${step}: ${action?.action || "unknown"} failed -> ${err}`);
      }
    }

    lines.push(``);
    lines.push(`  await browser.close();`);
    lines.push(`})();`);
    return lines.join("\n");
  }

  private async executeAction(page: any, action: HybridPlannerAction): Promise<StepOutcome> {
    try {
      switch (action.action) {
        case "navigate": {
          const target = action.url || (action.query ? `https://www.google.com/search?q=${encodeURIComponent(action.query)}` : "");
          if (!target) {
            return { success: false, status: "failed", error: "navigate action missing url/query" };
          }
          await page.goto(target, { waitUntil: "domcontentloaded", timeout: 30000 });
          return {
            success: true,
            status: "success",
            evidence: `Navigated to ${target}`,
            data: { url: page.url(), title: await page.title() },
          };
        }
        case "click": {
          const selector = this.selectorForAction(action);
          if (!selector) {
            return { success: false, status: "failed", error: "click action missing selector/elementId" };
          }
          await this.tryClick(page, selector);
          return {
            success: true,
            status: "success",
            evidence: `Clicked ${selector}`,
            data: { url: page.url(), title: await page.title() },
          };
        }
        case "type": {
          const selector = this.selectorForAction(action);
          if (!selector) {
            return { success: false, status: "failed", error: "type action missing selector/elementId" };
          }
          const text = action.text || "";
          const locator = page.locator(selector).first();
          try {
            await locator.fill(text, { timeout: 3500 });
          } catch {
            try {
              await locator.click({ timeout: 1500, force: true });
              await locator.fill(text, { timeout: 2500 });
            } catch {
              await page.evaluate(
                ({ sel, val }: { sel: string; val: string }) => {
                  const el = document.querySelector(sel) as
                    | HTMLInputElement
                    | HTMLTextAreaElement
                    | null;
                  if (!el) {
                    throw new Error(`element not found: ${sel}`);
                  }
                  el.focus();
                  el.value = val;
                  el.dispatchEvent(new Event("input", { bubbles: true }));
                  el.dispatchEvent(new Event("change", { bubbles: true }));
                },
                { sel: selector, val: text },
              );
            }
          }
          return {
            success: true,
            status: "success",
            evidence: `Typed into ${selector}`,
            data: { selector },
          };
        }
        case "press": {
          const key = action.key || "Enter";
          await page.keyboard.press(key);
          return {
            success: true,
            status: "success",
            evidence: `Pressed ${key}`,
            data: { key },
          };
        }
        case "scroll": {
          const deltaY = Number.isFinite(action.deltaY as number) ? Number(action.deltaY) : 700;
          await page.mouse.wheel(0, deltaY);
          await page.waitForTimeout(300);
          return {
            success: true,
            status: "success",
            evidence: `Scrolled by ${deltaY}px`,
            data: { deltaY },
          };
        }
        case "extract": {
          const text = await page.evaluate(() => (document.body?.innerText || "").slice(0, 5000));
          const snippet = text.slice(0, 800);
          return {
            success: true,
            status: "success",
            evidence: snippet || "Extracted page text.",
            data: { extractedText: text },
          };
        }
        case "wait": {
          const waitMs = Number.isFinite(action.waitMs as number)
            ? Math.max(100, Math.min(10000, Number(action.waitMs)))
            : 1000;
          await page.waitForTimeout(waitMs);
          return {
            success: true,
            status: "success",
            evidence: `Waited ${waitMs}ms`,
            data: { waitMs },
          };
        }
        case "ask_user":
          return {
            success: true,
            status: "paused",
            evidence: action.question || "Awaiting user context.",
            data: { question: action.question || "Need more context." },
          };
        case "finish":
          return {
            success: true,
            status: "success",
            evidence: action.answer || "Task complete.",
            data: { answer: action.answer || "Task complete." },
          };
      }
    } catch (error) {
      return {
        success: false,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async tryClick(page: any, selector: string): Promise<void> {
    try {
      await page.locator(selector).first().click({ timeout: 2500 });
      await Promise.race([
        page.waitForLoadState("domcontentloaded", { timeout: 1800 }).catch(() => undefined),
        page.waitForTimeout(220),
      ]);
    } catch {
      // Overlay-heavy sites like Facebook often intercept pointer events.
      // Force click once before giving up to reduce latency on repeated retries.
      await page.waitForTimeout(120);
      await page.locator(selector).first().click({ timeout: 1500, force: true });
      await page.waitForTimeout(180);
    }
  }

  private selectorForAction(action: HybridPlannerAction): string {
    if (action.selector && action.selector.trim()) return action.selector.trim();
    if (action.elementId && action.elementId.trim()) {
      return `[data-anorha-ai-id="${action.elementId.trim()}"]`;
    }
    return "";
  }

  private async capturePageSnapshot(page: any): Promise<PageSnapshot> {
    const payload = (await page.evaluate(() => {
      const selector =
        "a,button,input,textarea,select,[role='button'],[role='link'],[onclick],[contenteditable='true']";
      const nodes = Array.from(document.querySelectorAll(selector)).slice(0, 60);
      const elements = nodes
        .map((node, idx) => {
          const el = node as any;
          const rect = el.getBoundingClientRect();
          if (rect.width < 2 || rect.height < 2) return null;
          const style = window.getComputedStyle(el);
          if (style.visibility === "hidden" || style.display === "none") return null;

          let id = el.getAttribute("data-anorha-ai-id") || "";
          if (!id) {
            id = `ai-${Date.now()}-${idx}`;
            el.setAttribute("data-anorha-ai-id", id);
          }

          return {
            id,
            selector: `[data-anorha-ai-id=\"${id}\"]`,
            tag: el.tagName.toLowerCase(),
            role: el.getAttribute("role") || "",
            text: (el.innerText || "").trim().slice(0, 180),
            placeholder: el.placeholder || "",
            ariaLabel: el.getAttribute("aria-label") || "",
          };
        })
        .filter(Boolean);

      return {
        url: window.location.href,
        title: document.title || "",
        textSnippet: (document.body?.innerText || "").slice(0, 4000),
        elements,
      };
    })) as PageSnapshot;

    return payload;
  }

  private detectLoginWall(snapshot: PageSnapshot): string {
    const haystack = `${snapshot.url}\n${snapshot.title}\n${snapshot.textSnippet}`.toLowerCase();
    if (
      /\b(sign\s?in|log\s?in|login|authenticate|verification code|2fa|one-time code|captcha|password)\b/.test(
        haystack,
      )
    ) {
      return "login_wall_detected";
    }
    return "";
  }

  private maxSteps(request: RuntimeExecutionRequest): number {
    const raw = Number(request.options.runtimeMaxSteps || 0);
    if (Number.isFinite(raw) && raw > 0) {
      return Math.max(1, Math.min(20, Math.trunc(raw)));
    }
    return 8;
  }

  private cdpURL(request: RuntimeExecutionRequest): string {
    const fromReq = (request.options.runtimeCDPURL || "").trim();
    if (fromReq) return fromReq;
    return (process.env.ANORHA_CHROME_CDP_URL || process.env.CHROME_CDP_URL || "http://127.0.0.1:9222").trim();
  }

  private async selectPageForRequest(
    request: RuntimeExecutionRequest,
    pages: any[],
    state: ThreadState,
  ): Promise<any | null> {
    if (!Array.isArray(pages) || pages.length === 0) return null;

    const message = request.message || "";
    const explicitIndex =
      (Number.isFinite(request.options.runtimeTabIndex as number) && (request.options.runtimeTabIndex as number) > 0
        ? Number(request.options.runtimeTabIndex)
        : null) ??
      this.extractRequestedTabIndex(message);
    if (explicitIndex !== null) {
      const byIndex = pages[explicitIndex - 1];
      if (byIndex) {
        await this.emitChosenTab(request, byIndex, explicitIndex, "selected by index");
        await this.pinTab(state, byIndex, explicitIndex);
        return byIndex;
      }
    }

    const policy = this.tabPolicy(request);
    if (policy === "pinned" && state.pinnedTab) {
      const pinnedByIndex = pages[state.pinnedTab.index - 1];
      if (pinnedByIndex) {
        await this.emitChosenTab(request, pinnedByIndex, state.pinnedTab.index, "pinned tab");
        return pinnedByIndex;
      }
      const pinnedByUrl = pages.find((p) => this.pageURL(p) === state.pinnedTab?.url);
      if (pinnedByUrl) {
        const idx = pages.indexOf(pinnedByUrl) + 1;
        await this.emitChosenTab(request, pinnedByUrl, idx, "pinned tab url match");
        await this.pinTab(state, pinnedByUrl, idx);
        return pinnedByUrl;
      }
    }

    const matcher =
      this.extractRequestedTabMatcher(message) ||
      (request.options.runtimeTabMatch || "").trim() ||
      this.envTabMatcher();
    if (matcher) {
      const lowered = matcher.toLowerCase();
      let matched: any | undefined;
      for (const p of pages) {
        const url = this.pageURL(p).toLowerCase();
        const title = (await this.pageTitle(p)).toLowerCase();
        if (url.includes(lowered) || title.includes(lowered)) {
          matched = p;
          break;
        }
      }
      if (matched) {
        const i = pages.indexOf(matched) + 1;
        await this.emitChosenTab(request, matched, i, `matched '${matcher}'`);
        await this.pinTab(state, matched, i);
        return matched;
      }
    }

    const nonBlank = pages.filter((p) => {
      const u = this.pageURL(p);
      return u && u !== "about:blank";
    });
    const fallback = nonBlank[nonBlank.length - 1] || pages[pages.length - 1] || pages[0] || null;
    if (fallback) {
      const i = pages.indexOf(fallback) + 1;
      await this.emitChosenTab(request, fallback, i, "default selection");
      await this.pinTab(state, fallback, i);
    }
    return fallback;
  }

  private async pinTab(state: ThreadState, page: any, index: number): Promise<void> {
    state.pinnedTab = {
      index,
      url: this.pageURL(page),
      title: await this.pageTitle(page),
      selectedAt: Date.now(),
    };
  }

  private async emitTabQuestion(request: RuntimeExecutionRequest, pages: any[], state: ThreadState): Promise<void> {
    if (!Array.isArray(pages) || pages.length <= 1) return;

    const hasExplicit =
      (request.options.runtimeTabIndex || 0) > 0 ||
      !!this.extractRequestedTabIndex(request.message || "") ||
      !!(request.options.runtimeTabMatch || "").trim() ||
      !!this.extractRequestedTabMatcher(request.message || "") ||
      !!state.pinnedTab;
    if (hasExplicit) return;

    const options = await Promise.all(
      pages.slice(0, 20).map(async (p, i) => ({
        index: i + 1,
        title: (await this.pageTitle(p)) || `Tab ${i + 1}`,
        url: this.pageURL(p),
      })),
    );

    request.emit({
      eventName: "tool_result",
      threadId: request.threadId,
      toolName: "runtime.context_question",
      toolResult: true,
      content:
        "Which Chrome tab should I control? Reply with 'tab N' (example: 'tab 2') or set a URL/title matcher.",
      toolResultData: {
        question: "Which Chrome tab/window should be controlled?",
        options,
        assumption: "Proceeding with default non-blank latest tab if no reply.",
      },
    });
  }

  private async emitChosenTab(
    request: RuntimeExecutionRequest,
    page: any,
    index: number,
    reason: string,
  ): Promise<void> {
    request.emit({
      eventName: "tool_result",
      threadId: request.threadId,
      toolName: "runtime.tab_selected",
      toolResult: true,
      content: `Using tab ${index}: ${this.pageURL(page)} [${reason}]`,
      toolResultData: {
        index,
        reason,
        title: await this.pageTitle(page),
        url: this.pageURL(page),
      },
    });
  }

  private pageURL(page: any): string {
    try {
      if (typeof page?.url === "function") return page.url() || "about:blank";
      return "about:blank";
    } catch {
      return "about:blank";
    }
  }

  private async pageTitle(page: any): Promise<string> {
    try {
      if (typeof page?.title !== "function") return "";
      const maybe = await page.title();
      return typeof maybe === "string" ? maybe : "";
    } catch {
      return "";
    }
  }

  private tabPolicy(request: RuntimeExecutionRequest): "pinned" | "ask" | "active" {
    const fromReq = (request.options.runtimeTabPolicy || "").trim().toLowerCase();
    if (fromReq === "ask" || fromReq === "active" || fromReq === "pinned") {
      return fromReq;
    }
    return "pinned";
  }

  private extractRequestedTabIndex(message: string): number | null {
    const m = /\b(?:tab|window)\s*#?\s*(\d{1,2})\b/i.exec(message || "");
    if (!m) return null;
    const n = Number(m[1]);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  private extractRequestedTabMatcher(message: string): string {
    const m = /\b(?:tab|window)\s+(?:url|title)\s+contains\s+["']?([^"'\n]+)["']?/i.exec(message || "");
    return m?.[1]?.trim() || "";
  }

  private envTabMatcher(): string {
    return (process.env.ANORHA_CHROME_TAB_MATCH || "").trim();
  }

  private extractURL(input: string): string {
    const match = /(https?:\/\/[^\s"'<>]+)/i.exec(input || "");
    return match?.[1] || "";
  }

  private async loadPlaywright(): Promise<any | null> {
    try {
      return await import("playwright");
    } catch {
      return null;
    }
  }

  private isContinueRequest(message: string): boolean {
    return /\bcontinue\b/i.test(message || "");
  }

  private isResetRequest(message: string): boolean {
    const value = (message || "").toLowerCase();
    return /(reset|clear).*(tab|session|browser|state)/.test(value);
  }

  private taskKey(message: string): string {
    return (message || "")
      .toLowerCase()
      .replace(/\b(please|could you|can you|find|open|search)\b/g, " ")
      .replace(/https?:\/\/[^\s]+/g, " ")
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 180);
  }

  private isTaskKeyReusable(currentTaskKey: string, presetTaskKey: string): boolean {
    if (!currentTaskKey || !presetTaskKey) return false;
    if (currentTaskKey === presetTaskKey) return true;
    if (currentTaskKey.includes(presetTaskKey) || presetTaskKey.includes(currentTaskKey)) return true;
    const currentTokens = new Set(currentTaskKey.split(" ").filter(Boolean));
    const presetTokens = new Set(presetTaskKey.split(" ").filter(Boolean));
    if (currentTokens.size === 0 || presetTokens.size === 0) return false;
    let overlap = 0;
    for (const token of currentTokens) {
      if (presetTokens.has(token)) overlap += 1;
    }
    const ratio = overlap / Math.min(currentTokens.size, presetTokens.size);
    return ratio >= 0.6;
  }

  private describeAction(action: HybridPlannerAction): string {
    switch (action.action) {
      case "navigate":
        return `navigate to ${action.url || action.query || "target"}`;
      case "click":
        return `click ${action.selector || action.elementId || "element"}`;
      case "type":
        return `type into ${action.selector || action.elementId || "input"}`;
      case "press":
        return `press ${action.key || "Enter"}`;
      case "scroll":
        return `scroll ${action.deltaY || 700}px`;
      case "extract":
        return "extract page content";
      case "wait":
        return `wait ${action.waitMs || 1000}ms`;
      case "ask_user":
        return "ask user for context";
      case "finish":
        return "finish task";
    }
  }

  private async injectControlBorder(page: any): Promise<void> {
    await page.addInitScript(() => {
      const apply = () => {
        const id = "anorha-agent-control-border";
        if (document.getElementById(id)) return;
        const border = document.createElement("div");
        border.id = id;
        border.style.position = "fixed";
        border.style.inset = "0";
        border.style.pointerEvents = "none";
        border.style.border = "5px solid #16a34a";
        border.style.boxSizing = "border-box";
        border.style.zIndex = "2147483647";
        document.documentElement.appendChild(border);
      };
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", apply, { once: true });
      } else {
        apply();
      }
    });
  }
}
