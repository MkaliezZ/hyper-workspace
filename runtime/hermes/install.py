"""Install the immutable Hermes source with its own PM into task-owned paths."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
LOCK = json.loads(Path(__file__).with_name("lock.json").read_text())
RUNTIME = ROOT / ".runtime"
RECEIPT = RUNTIME / "hermes-install.json"


def digest(path):
    with path.open("rb") as file:
        return hashlib.file_digest(file, "sha256").hexdigest()


def main():
    expected = tuple(map(int, LOCK["python"].split(".")))
    if sys.version_info[:3] != expected:
        raise RuntimeError("Run this installer with Python " + LOCK["python"])
    RUNTIME.mkdir(exist_ok=True)
    source = RUNTIME / "hermes-source" / ("hermes-agent-" + LOCK["commit"])
    destination = RUNTIME / "hermes-runtime-env"
    python = destination / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    if RECEIPT.exists():
        receipt = json.loads(RECEIPT.read_text())
        if (receipt.get("commit") == LOCK["commit"] and python.is_file()
                and source.is_dir() and receipt.get("sourceLockSha256") == digest(source / "uv.lock")):
            print("Hermes runtime is already installed at the pinned commit.")
            return
        raise RuntimeError("Existing Hermes installation differs from the lock; inspect it before rebuilding.")
    archive = RUNTIME / ("hermes-" + LOCK["commit"] + ".tar.gz")
    if not archive.exists():
        temporary = archive.with_suffix(".download")
        with urllib.request.urlopen(LOCK["archiveUrl"], timeout=30) as response, temporary.open("wb") as file:
            shutil.copyfileobj(response, file)
        if digest(temporary) != LOCK["archiveSha256"]:
            temporary.unlink()
            raise RuntimeError("Hermes archive digest mismatch.")
        temporary.replace(archive)
    if digest(archive) != LOCK["archiveSha256"]:
        raise RuntimeError("Cached Hermes archive digest mismatch.")
    if not source.exists():
        source.parent.mkdir(exist_ok=True)
        with tarfile.open(archive) as package:
            package.extractall(source.parent, filter="data")
    if destination.exists():
        raise RuntimeError("An unregistered runtime directory exists; inspect it before proceeding.")
    environment = {
        **os.environ,
        "HERMES_HOME": str(RUNTIME / "hermes-build-home"),
        "HERMES_RUNTIME_DIR": str(RUNTIME / "hermes-tools"),
    }
    # Upstream PM owns dependency changes and validates the frozen upstream lock.
    subprocess.run([
        sys.executable, "-m", "pm.build_env", "--source", str(source), "--out", str(destination),
        "--python", sys.executable, "--explicit",
    ], cwd=source, env=environment, check=True)
    subprocess.run([str(python), "-c", "import tui_gateway.entry; print('Hermes imports ready.')"],
                   cwd=source, env=environment, check=True)
    receipt = {
        "commit": LOCK["commit"], "archiveSha256": LOCK["archiveSha256"], "pythonVersion": LOCK["python"],
        "python": python.relative_to(ROOT).as_posix(), "source": source.relative_to(ROOT).as_posix(),
        "sourceLockSha256": digest(source / "uv.lock"),
    }
    temporary = RECEIPT.with_suffix(".tmp")
    temporary.write_text(json.dumps(receipt, indent=2) + "\n")
    temporary.chmod(0o600)
    temporary.replace(RECEIPT)
    print("Installed Hermes " + LOCK["commit"])


if __name__ == "__main__":
    main()
