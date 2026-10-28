#!/usr/bin/env python3
"""Read-only, offline validation of the packaged AI IM baseline."""
import hashlib
import json
from pathlib import Path
import re
import sys
from urllib.parse import unquote

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parent
MANIFEST = "MANIFEST.sha256.json"
IGNORED_NAMES = {".DS_Store"}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def safe_path(relative):
    path = Path(relative)
    require(not path.is_absolute() and ".." not in path.parts, "Unsafe manifest path: " + relative)
    resolved = (ROOT / path).resolve()
    require(resolved.is_relative_to(ROOT), "Path escapes package: " + relative)
    return resolved


def payload_files():
    paths = []
    for path in ROOT.rglob("*"):
        if path.name in IGNORED_NAMES or "__pycache__" in path.parts:
            continue
        require(not path.is_symlink(), "Symlink not allowed in snapshot: " + str(path))
        if path.is_file() and path.name != MANIFEST:
            paths.append(path.relative_to(ROOT).as_posix())
    return sorted(paths)


def check_spec():
    spec = json.loads((ROOT / "AI-IM基线/product-baseline.v1.json").read_text(encoding="utf-8"))
    require(spec["version"] == "1.0.0", "Unexpected baseline version")
    require(spec["status"] == "fixed_design_baseline", "Unexpected baseline status")
    require(spec["implementation_status"] == "not_implemented", "Snapshot implementation state changed")
    require(spec["source_bindings"] == [], "Snapshot must not contain live company bindings")
    expected = {
        "policies": {"P%02d" % n for n in range(1, 9)},
        "capabilities": {"C%02d" % n for n in range(0, 8)},
        "assets": {"A%02d" % n for n in range(1, 11)},
        "evaluations": {"E%02d" % n for n in range(1, 11)},
    }
    refs = {"policy_ids": "policies", "capability_ids": "capabilities",
            "asset_ids": "assets", "evaluation_ids": "evaluations"}
    groups = {}
    for name, ids in expected.items():
        rows = spec[name]
        groups[name] = {row["id"]: row for row in rows}
        require(len(groups[name]) == len(rows), "Duplicate IDs in " + name)
        require(set(groups[name]) == ids, "Unexpected IDs in " + name)
    for name, rows in groups.items():
        for ident, row in rows.items():
            for field, target in refs.items():
                if field in row:
                    require(set(row[field]) <= set(groups[target]), "Broken reference: " + ident + "." + field)
    for pid, policy in groups["policies"].items():
        for cid in policy["capability_ids"]:
            require(pid in groups["capabilities"][cid]["policy_ids"], "Policy/capability mapping mismatch")
    for cid, capability in groups["capabilities"].items():
        for aid in capability["asset_ids"]:
            require(cid in groups["assets"][aid]["capability_ids"], "Capability/asset mapping mismatch")
    require({asset["category"] for asset in spec["assets"]} == set(spec["asset_categories"]),
            "Asset categories mismatch")
    contract = spec["engine_contract"]
    require(contract["default_engine"] == "dsh" and contract["required_compatible_engine"] == "hermes",
            "Engine selection changed")
    require({item["engine"] for item in spec["runtime_adapter_plan"]} == {"dsh", "hermes"},
            "Missing adapter plan")
    for evaluation in spec["evaluations"]:
        require(evaluation["execution_status"] == "not_run", "Fabricated/changed runtime result")
        require(set(evaluation["engines"]) == {"dsh", "hermes"}, "Missing dual-engine evaluation")
    for document in ["三层定义-v1.0.md", "技术选型与模块契约-v1.0.md"]:
        text = (ROOT / "AI-IM基线" / document).read_text(encoding="utf-8")
        for name in ["policies", "capabilities", "assets"]:
            require(all(ident in text for ident in expected[name]), "Missing traceability IDs in " + document)
    return {name: len(rows) for name, rows in groups.items()}


def check_local_links():
    checked = 0
    for document in ROOT.rglob("*.md"):
        text = document.read_text(encoding="utf-8")
        for raw in re.findall(r"\]\(([^)]+)\)", text):
            if re.match(r"[a-zA-Z][a-zA-Z0-9+.-]*:|#", raw):
                continue
            link = unquote(raw.strip("<>").split("#", 1)[0])
            if not link:
                continue
            path = Path(link)
            require(not path.is_absolute(), "Absolute local link in " + str(document.relative_to(ROOT)))
            resolved = (document.parent / path).resolve()
            require(resolved.is_relative_to(ROOT), "Local link leaves package: " + raw)
            require(resolved.exists(), "Missing local link: " + raw)
            checked += 1
    return checked


def check():
    manifest = json.loads((ROOT / MANIFEST).read_text(encoding="utf-8"))
    require(manifest["baseline_version"] == "1.0.0", "Manifest version mismatch")
    require(manifest["hash_algorithm"] == "sha256", "Unexpected hash algorithm")
    entries = manifest["files"]
    listed = [entry["path"] for entry in entries]
    require(len(listed) == len(set(listed)), "Duplicate manifest paths")
    require(sorted(listed) == payload_files(), "Missing or unexpected payload files")
    for entry in entries:
        path = safe_path(entry["path"])
        raw = path.read_bytes()
        require(len(raw) == entry["bytes"], "Size mismatch: " + entry["path"])
        require(hashlib.sha256(raw).hexdigest() == entry["sha256"], "SHA-256 mismatch: " + entry["path"])
        if path.suffix in {".md", ".json", ".py"}:
            require(not raw.startswith(b"\xef\xbb\xbf"), "Unexpected UTF-8 BOM: " + entry["path"])
            raw.decode("utf-8")
            require(b"\r" not in raw, "Unexpected line ending: " + entry["path"])
    snapshot = json.loads((ROOT / "SOURCE_SNAPSHOT.json").read_text(encoding="utf-8"))
    require(len(snapshot["files"]) == 6, "Missing original baseline/history snapshot")
    for relative, digest in snapshot["files"].items():
        require(hashlib.sha256(safe_path(relative).read_bytes()).hexdigest() == digest,
                "Original source snapshot changed: " + relative)
    counts = check_spec()
    local_links = check_local_links()
    return {
        "status": "PASS", "baseline_version": "1.0.0",
        "payload_files": len(entries), "manifest_files": 1,
        "byte_exact_source_files": len(snapshot["files"]),
        "spec_counts": counts, "local_links_checked": local_links,
        "network_used": False, "application_or_engine_tests_run": False,
    }


if __name__ == "__main__":
    try:
        print(json.dumps(check(), ensure_ascii=False, indent=2))
    except Exception as exc:
        print("FAIL: " + str(exc), file=sys.stderr)
        sys.exit(1)

