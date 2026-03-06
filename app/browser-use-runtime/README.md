Bundled Browser-Use runtime assets for packaged `anorha-local` builds.

Expected packaged layout:
- `manifest.json`
- `requirements.lock.txt`
- `python/browser_use_mcp_wrapper.py`
- optional embedded Python runtime under `bin/` or `Scripts/`
- optional bundled browser binaries in sibling `browser-use-browsers/`

The desktop build copies this directory into:
- macOS: `Ollama.app/Contents/Resources/browser-use-runtime`
- Windows: `{app}\browser-use-runtime`

If an embedded runtime is present, `app/agent-runtime` will prefer it over any
global `uvx` or `browser-use` installation.

Current runtime behavior:
- dev mode uses the app-owned Browser-Use wrapper by default
- the selected planner model is passed through from `ANORHA_BROWSER_USE_MODEL`
- for OpenAI-compatible Ollama routing, the wrapper also exports `BROWSER_USE_LLM_MODEL` and `OPENAI_MODEL`
- planner startup failures are expected to fail fast instead of silently opening blank tabs
- Browser-Use is pinned in `requirements.lock.txt` and mirrored in `manifest.json`

To make packaged installs work on any macOS or Windows machine with a single command, this directory still needs real bundled assets:
- embedded Python runtime
- pinned `browser-use` installation
- pinned dependency set matching `requirements.lock.txt`
- optional bundled browsers in sibling `browser-use-browsers/`

Without those assets, the packaging layout is ready but the Browser-Use runtime is not yet fully self-contained for offline end-user installs.
