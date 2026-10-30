"""Start one pinned Hermes process in the Run's own profile; no native tools."""
import json
import os
from pathlib import Path
import sys
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[2]
LOCK = json.loads(Path(__file__).with_name("lock.json").read_text())
receipt = json.loads((ROOT / ".runtime/hermes-install.json").read_text())
if receipt["commit"] != LOCK["commit"] or receipt["archiveSha256"] != LOCK["archiveSha256"]:
    raise RuntimeError("Hermes installation does not match the pinned source.")
if sys.version_info[:3] != tuple(map(int, LOCK["python"].split("."))):
    raise RuntimeError("Unexpected Hermes Python runtime.")
home = Path(os.environ["HERMES_HOME"])
if not home.is_absolute():
    raise RuntimeError("An isolated absolute HERMES_HOME is required.")
endpoint, model = os.environ["HYPER_MODEL_ENDPOINT"], os.environ["HYPER_MODEL_NAME"]
url = urlsplit(endpoint)
if url.scheme not in {"http", "https"} or not url.netloc or url.username or url.password or url.query or url.fragment:
    raise RuntimeError("Invalid model endpoint.")
if os.environ.get("HYPER_MODEL_PROVIDER") == "anthropic":
    raise RuntimeError("This Hermes build has not validated the Anthropic runtime extra; choose a Chat Completions connection.")
max_tokens = int(os.environ.get("HYPER_MODEL_MAX_TOKENS", "4096"))
run_seconds = int(os.environ.get("HYPER_RUN_SECONDS", "180"))
if not 64 <= max_tokens <= 4096 or not 5 <= run_seconds <= 180:
    raise RuntimeError("Invalid execution limits.")
config = {
    "model": {"default": model, "provider": "custom:hyper", "context_length": 65536},
    "providers": {"hyper": {"base_url": endpoint, "api_mode": "chat_completions", "key_env": "HYPER_MODEL_API_KEY",
                             "context_length": 65536, "extra_body": {"max_tokens": max_tokens}}},
    "platform_toolsets": {"cli": []}, "toolsets": [],
    "agent": {"max_turns": 2, "run_budget_seconds": min(120, run_seconds), "coding_context": "off", "system_prompt": os.environ["HYPER_MODEL_POLICY"]},
    "memory": {"memory_enabled": False, "user_profile_enabled": False},
    "onboarding": {"profile_build": "off", "run": False},
    "security": {"allow_lazy_installs": False},
    "auxiliary": {"title_generation": {"enabled": False, "model_upgrade_enabled": False}},
    "telemetry": {"shared_metrics": {"enabled": False, "send": False}},
}
home.mkdir(parents=True, exist_ok=True, mode=0o700)
path = home / "config.yaml"
path.write_text(json.dumps(config), encoding="utf-8")
path.chmod(0o600)
os.environ["HERMES_DISABLE_LAZY_INSTALLS"] = "1"
os.environ["HERMES_IGNORE_RULES"] = "1"
from tui_gateway.entry import main

main()
