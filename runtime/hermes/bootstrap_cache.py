"""Prepare verified public build inputs; PM still verifies and installs its tools."""
import hashlib
import io
import json
import os
from pathlib import Path
import re
import sys
import tarfile
from urllib.parse import urlparse

from download import ensure_archive


def verified_bytes(path, expected):
    path = Path(path)
    if path.is_symlink() or not path.is_file() or path.stat().st_size > 128 * 1024 * 1024:
        raise RuntimeError("Expected a bounded regular public archive")
    data = path.read_bytes()
    if hashlib.sha256(data).hexdigest() != expected:
        raise RuntimeError("Public archive integrity mismatch")
    return data


def seed_pinned_archive(archive, store, spec):
    digest = spec["sha256"]
    name = Path(urlparse(spec["url"]).path).name
    if not re.fullmatch(r"[a-f0-9]{64}", digest) or name in ("", ".", ".."):
        raise RuntimeError("Invalid pinned archive identity")
    data = verified_bytes(archive, digest)
    store = Path(store)
    entry = store / ("fetch-" + digest)
    for directory in (store, entry):
        if directory.is_symlink():
            raise RuntimeError("Public cache cannot use symbolic links")
        directory.mkdir(parents=True, exist_ok=True)
    target = entry / name
    if any(p.name != name or p.is_symlink() or not p.is_file() for p in entry.iterdir()):
        raise RuntimeError("Unexpected existing public cache entry")
    if target.exists() or target.is_symlink():
        verified_bytes(target, digest)
        return target
    with target.open("xb") as output:
        output.write(data)
    return target


def prepare_build(root):
    lock = json.loads(Path(__file__).with_name("lock.json").read_text())
    source = ensure_archive(root / ".runtime/hermes-source.tar.gz", lock)
    source_data = verified_bytes(source, lock["archiveSha256"])
    with tarfile.open(fileobj=io.BytesIO(source_data)) as bundle:
        metadata = bundle.extractfile("hermes-agent-" + lock["commit"] + "/pm/lock.json")
        packages = json.load(metadata)["packages"]
    expected = {"hermes-source.tar.gz": (source_data, lock["archiveSha256"])}
    for name in ("uv", "python"):
        spec = packages[name]["artifacts"]["linux-x64"]
        archive = ensure_archive(root / (".runtime/hermes-" + name + "-linux.tar.gz"), {
            "archiveUrl": spec["url"], "archiveSha256": spec["sha256"],
        })
        expected[Path(urlparse(spec["url"]).path).name] = (verified_bytes(archive, spec["sha256"]), spec["sha256"])
    output = root / ".runtime/hermes-build-source"
    if output.is_symlink():
        raise RuntimeError("Build context cannot be a symbolic link")
    output.mkdir(mode=0o700, parents=True, exist_ok=True)
    if hasattr(os, "getuid") and output.stat().st_uid != os.getuid():
        raise RuntimeError("Build context must belong to this operator")
    if any(p.name not in expected or p.is_symlink() or not p.is_file() for p in output.iterdir()):
        raise RuntimeError("Build context contains unrelated files")
    for name, (data, digest) in expected.items():
        destination = output / name
        if destination.exists():
            verified_bytes(destination, digest)
        else:
            with destination.open("xb") as target:
                target.write(data)
    print("Prepared three verified public Hermes build archives; no installed-state receipts created.")


def main():
    if len(sys.argv) == 1:
        print(json.dumps({"mode": "preflight", "requestsSent": 0,
                          "execute": "--prepare-build creates an explicit three-archive Linux amd64 build context"}))
        return
    if sys.argv[1:] != ["--prepare-build"]:
        raise RuntimeError("Invalid arguments")
    prepare_build(Path(__file__).resolve().parents[2])


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print("Public Hermes build preparation failed; no pins or installed-state receipts were changed.", file=sys.stderr)
        sys.exit(1)
