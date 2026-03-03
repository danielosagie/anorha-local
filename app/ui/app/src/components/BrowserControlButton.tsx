import { forwardRef, useMemo, useState } from "react";

export type RuntimeBackendOption =
  | "playwright_attached"
  | "browser_use_ts"
  | "playwright_direct";

export interface BrowserRuntimeConfig {
  runtimeBackend: RuntimeBackendOption;
  runtimeCDPURL: string;
  runtimeTabPolicy: "pinned" | "ask" | "active";
  runtimeTabIndex?: number;
  runtimeTabMatch?: string;
  runtimeMaxSteps: number;
}

interface ButtonProps {
  isActive: boolean;
  onToggle: () => void;
  config: BrowserRuntimeConfig;
  onConfigChange: (next: Partial<BrowserRuntimeConfig>) => void;
}

export const BrowserControlButton = forwardRef<HTMLButtonElement, ButtonProps>(
  function BrowserControlButton({ isActive, onToggle, config, onConfigChange }, ref) {
    const [open, setOpen] = useState(false);

    const runtimeLabel = useMemo(() => {
      switch (config.runtimeBackend) {
        case "playwright_attached":
          return "Attached";
        case "playwright_direct":
          return "Direct";
        default:
          return "Browser-Use";
      }
    }, [config.runtimeBackend]);

    return (
      <div className="relative flex items-center gap-1">
        <button
          ref={ref}
          type="button"
          title={isActive ? "Disable Browser use" : "Enable Browser use"}
          aria-pressed={isActive}
          onClick={onToggle}
          className={`select-none flex items-center gap-1.5 rounded-full h-9 px-3 bg-white dark:bg-neutral-700 focus:outline-none focus:ring-2 focus:ring-blue-500 cursor-pointer transition-all whitespace-nowrap border ${
            isActive
              ? "text-[rgba(0,115,255,1)] dark:text-[rgba(70,155,255,1)] border-[rgba(0,115,255,0.35)] dark:border-[rgba(70,155,255,0.45)]"
              : "text-neutral-500 dark:text-neutral-400 border-transparent"
          }`}
        >
          <span className="text-xs font-medium">Browser use</span>
          <svg
            className="h-4 w-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M10.5 6H9a2 2 0 00-2 2v8a2 2 0 002 2h6a2 2 0 002-2v-1.5M13 11l6-6m0 0h-4m4 0v4"
            />
          </svg>
        </button>

        {isActive && (
          <button
            type="button"
            title="Browser runtime options"
            onClick={() => setOpen((v) => !v)}
            className="h-9 w-9 rounded-full bg-white dark:bg-neutral-700 border border-transparent text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4 mx-auto">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v12m6-6H6" />
            </svg>
          </button>
        )}

        {open && isActive && (
          <div className="absolute right-0 bottom-11 z-50 w-80 rounded-xl border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 p-3 shadow-xl">
            <div className="text-xs font-semibold text-neutral-700 dark:text-neutral-200 mb-2">
              Browser Runtime ({runtimeLabel})
            </div>

            <label className="block text-[11px] text-neutral-500 mb-1">Mode</label>
            <select
              className="w-full mb-2 h-8 rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-900 px-2 text-xs"
              value={config.runtimeBackend}
              onChange={(e) =>
                onConfigChange({ runtimeBackend: e.target.value as RuntimeBackendOption })
              }
            >
              <option value="playwright_attached">Attached Hybrid</option>
              <option value="browser_use_ts">Browser-Use</option>
              <option value="playwright_direct">Playwright Direct</option>
            </select>

            <label className="block text-[11px] text-neutral-500 mb-1">CDP URL</label>
            <input
              className="w-full mb-2 h-8 rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-900 px-2 text-xs"
              value={config.runtimeCDPURL}
              onChange={(e) => onConfigChange({ runtimeCDPURL: e.target.value })}
              placeholder="http://127.0.0.1:9222"
            />

            <label className="block text-[11px] text-neutral-500 mb-1">Tab policy</label>
            <select
              className="w-full mb-2 h-8 rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-900 px-2 text-xs"
              value={config.runtimeTabPolicy}
              onChange={(e) =>
                onConfigChange({
                  runtimeTabPolicy: e.target.value as "pinned" | "ask" | "active",
                })
              }
            >
              <option value="pinned">Pinned</option>
              <option value="ask">Ask</option>
              <option value="active">Active tab</option>
            </select>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-[11px] text-neutral-500 mb-1">Tab index</label>
                <input
                  className="w-full h-8 rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-900 px-2 text-xs"
                  type="number"
                  min={1}
                  value={config.runtimeTabIndex ?? ""}
                  onChange={(e) => {
                    const raw = e.target.value;
                    if (!raw) {
                      onConfigChange({ runtimeTabIndex: undefined });
                      return;
                    }
                    const n = Number(raw);
                    onConfigChange({
                      runtimeTabIndex: Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined,
                    });
                  }}
                />
              </div>
              <div>
                <label className="block text-[11px] text-neutral-500 mb-1">Max steps</label>
                <input
                  className="w-full h-8 rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-900 px-2 text-xs"
                  type="number"
                  min={1}
                  max={20}
                  value={config.runtimeMaxSteps}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    if (!Number.isFinite(n)) return;
                    onConfigChange({ runtimeMaxSteps: Math.max(1, Math.min(20, Math.floor(n))) });
                  }}
                />
              </div>
            </div>

            <label className="block text-[11px] text-neutral-500 mb-1 mt-2">Tab match (URL/title contains)</label>
            <input
              className="w-full h-8 rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-900 px-2 text-xs"
              value={config.runtimeTabMatch || ""}
              onChange={(e) => onConfigChange({ runtimeTabMatch: e.target.value })}
              placeholder="facebook.com/marketplace"
            />
          </div>
        )}
      </div>
    );
  },
);
