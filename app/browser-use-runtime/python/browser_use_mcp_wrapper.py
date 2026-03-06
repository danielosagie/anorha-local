import json
import os
import shutil
import subprocess
import sys
from pathlib import Path


def _stderr(message: str) -> None:
    sys.stderr.write(message.rstrip() + "\n")
    sys.stderr.flush()


def _env(name: str) -> str:
    return os.environ.get(name, "").strip()


def _find_local_browser_use_repo() -> str | None:
    current = Path(__file__).resolve()
    for parent in current.parents:
        candidate = parent / "browser-use" / "browser_use" / "mcp" / "server.py"
        if candidate.exists():
            return str(candidate.parent.parent.parent)
    return None


def _resolve_inner_command() -> list[str] | None:
    explicit = _env("BROWSER_USE_MCP_INNER_CMD") or _env("BROWSER_USE_MCP_EMBEDDED_CMD")
    if explicit:
        return [explicit]

    on_path = shutil.which("browser-use")
    if on_path:
        return [f'"{on_path}" --mcp']

    return None


def _failure_payload(code: str, message: str, planner_provider: str, planner_model: str) -> dict:
    return {
        "kind": "planner_status",
        "plannerInitOk": False,
        "plannerInitError": message,
        "failureCode": code,
        "plannerProvider": planner_provider,
        "plannerModel": planner_model,
    }


def _emit_planner_payload(payload: dict) -> None:
    _stderr(f"ANORHA_BROWSER_USE_PLANNER {json.dumps(payload, separators=(',', ':'))}")


def _validate_environment() -> tuple[bool, dict]:
    transport = _env("ANORHA_BROWSER_USE_TRANSPORT") or "openai_compat"
    planner_model = _env("OPENAI_MODEL") or _env("ANORHA_BROWSER_USE_MODEL") or _env("BROWSER_USE_LLM_MODEL")
    planner_provider = _env("ANORHA_BROWSER_USE_PLANNER_PROVIDER") or transport
    runtime_source = _env("BROWSER_USE_RUNTIME_SOURCE") or "dev-external"
    browser_dir = _env("BROWSER_USE_BUNDLED_BROWSER_DIR")

    if not planner_model:
      payload = _failure_payload("planner_init_failed", "planner model is empty", planner_provider, planner_model)
      _emit_planner_payload(payload)
      return False, payload

    if transport == "openai_compat":
        if not _env("OPENAI_BASE_URL"):
            payload = _failure_payload(
                "planner_init_failed",
                "openai_compat transport requires OPENAI_BASE_URL",
                planner_provider,
                planner_model,
            )
            _emit_planner_payload(payload)
            return False, payload
        if not _env("OPENAI_API_KEY"):
            payload = _failure_payload(
                "provider_auth_failed",
                "openai_compat transport requires OPENAI_API_KEY",
                planner_provider,
                planner_model,
            )
            _emit_planner_payload(payload)
            return False, payload
    elif transport == "ollama_native":
        if not _env("ANORHA_BROWSER_USE_OLLAMA_HOST"):
            payload = _failure_payload(
                "planner_init_failed",
                "ollama_native transport requires ANORHA_BROWSER_USE_OLLAMA_HOST",
                planner_provider,
                planner_model,
            )
            _emit_planner_payload(payload)
            return False, payload
    else:
        payload = _failure_payload(
            "planner_init_failed",
            f"unsupported browser-use transport '{transport}'",
            planner_provider,
            planner_model,
        )
        _emit_planner_payload(payload)
        return False, payload

    if runtime_source.startswith("bundled") and browser_dir and not Path(browser_dir).exists():
        payload = _failure_payload(
            "planner_init_failed",
            f"bundled browser directory not found: {browser_dir}",
            planner_provider,
            planner_model,
        )
        _emit_planner_payload(payload)
        return False, payload

    payload = {
        "kind": "planner_status",
        "plannerInitOk": True,
        "plannerInitError": "",
        "plannerProvider": planner_provider,
        "plannerModel": planner_model,
    }
    _emit_planner_payload(payload)
    return True, payload


def _prepare_environment() -> None:
    planner_model = _env("OPENAI_MODEL") or _env("ANORHA_BROWSER_USE_MODEL")
    if planner_model:
        os.environ["OPENAI_MODEL"] = planner_model
        os.environ["BROWSER_USE_LLM_MODEL"] = planner_model

    if _env("BROWSER_USE_BUNDLED_BROWSER_DIR"):
        os.environ["PLAYWRIGHT_BROWSERS_PATH"] = _env("BROWSER_USE_BUNDLED_BROWSER_DIR")

    local_repo = _find_local_browser_use_repo()
    if local_repo:
        existing = _env("PYTHONPATH")
        os.environ["PYTHONPATH"] = local_repo if not existing else f"{local_repo}{os.pathsep}{existing}"


def main() -> int:
    _prepare_environment()
    ok, payload = _validate_environment()
    if not ok:
        return 1

    if _env("ANORHA_BROWSER_USE_TRANSPORT") == "ollama_native":
        payload = _failure_payload(
            "planner_init_failed",
            "ollama_native transport is not supported by the upstream browser-use MCP launcher path",
            payload.get("plannerProvider", "ollama"),
            payload.get("plannerModel", ""),
        )
        _emit_planner_payload(payload)
        return 1

    cmd = _resolve_inner_command()
    if not cmd:
        payload = _failure_payload(
            "planner_init_failed",
            "browser-use executable not found in bundled runtime or PATH",
            payload.get("plannerProvider", "openai_compat"),
            payload.get("plannerModel", ""),
        )
        _emit_planner_payload(payload)
        return 1

    proc = subprocess.Popen(cmd[0], shell=True)
    return proc.wait()


if __name__ == "__main__":
    raise SystemExit(main())
