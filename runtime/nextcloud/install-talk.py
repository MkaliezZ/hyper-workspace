"""Prepare the pinned official Talk app for the isolated CI Nextcloud container."""
import hashlib
import json
from pathlib import Path
import tarfile
import urllib.request
import xml.etree.ElementTree as ET

root = Path(__file__).resolve().parents[2]
lock = json.loads((Path(__file__).parent / "talk.lock.json").read_text())
output = root / ".runtime" / "nextcloud"
output.mkdir(parents=True, exist_ok=True)
archive = output / ("spreed-" + lock["version"] + ".tar.gz")
if not archive.exists():
    temporary = archive.with_suffix(".partial")
    try:
        request = urllib.request.Request(lock["archive"], headers={"User-Agent": "Hyper-Workspace-CI"})
        with urllib.request.urlopen(request, timeout=60) as response, temporary.open("wb") as target:
            total = 0
            while chunk := response.read(1024 * 1024):
                total += len(chunk)
                if total > lock["size"]:
                    raise RuntimeError("Talk archive exceeds pinned size")
                target.write(chunk)
        temporary.replace(archive)
    finally:
        temporary.unlink(missing_ok=True)
if archive.stat().st_size != lock["size"] or hashlib.file_digest(archive.open("rb"), "sha256").hexdigest() != lock["sha256"]:
    raise RuntimeError("Talk archive integrity check failed")
with tarfile.open(archive) as bundle:
    info = ET.fromstring(bundle.extractfile("spreed/appinfo/info.xml").read())
    version = info.findtext("version")
    dependency = info.find("dependencies/nextcloud")
    if version != lock["version"] or dependency.get("min-version") != str(lock["serverMajor"]) or dependency.get("max-version") != str(lock["serverMajor"]):
        raise RuntimeError("Talk version or Nextcloud compatibility mismatch")
    if not (output / "spreed").exists():
        bundle.extractall(output, filter="data")

prepared_info = ET.parse(output / "spreed" / "appinfo" / "info.xml").getroot()
if prepared_info.findtext("version") != lock["version"]:
    raise RuntimeError("Prepared Talk cache has a different version; clear this tool-owned cache before retrying")

print("Prepared verified Nextcloud Talk " + version)
