"""Fetch only the locked public source archive; caches never bypass its digest."""
import hashlib
import json
from pathlib import Path
import shutil
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
LOCK = json.loads(Path(__file__).with_name("lock.json").read_text())
ARCHIVE = ROOT / ".runtime" / "hermes-source.tar.gz"


def digest(path):
    with path.open("rb") as file:
        return hashlib.file_digest(file, "sha256").hexdigest()


def ensure_archive(path=ARCHIVE, lock=LOCK, local=None):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        if digest(path) != lock["archiveSha256"]:
            raise RuntimeError("Cached Hermes archive digest mismatch.")
        return path
    temporary = path.with_suffix(".download")
    if local:
        local = Path(local)
        if digest(local) != lock["archiveSha256"]:
            raise RuntimeError("Supplied Hermes archive digest mismatch.")
        shutil.copyfile(local, temporary)
        temporary.replace(path)
        return path
    for attempt in range(6):
        try:
            request = urllib.request.Request(lock["archiveUrl"], headers={"User-Agent": "Hyper Workspace runtime installer/0.1"})
            with urllib.request.urlopen(request, timeout=30) as response, temporary.open("wb") as file:
                size = 0
                while chunk := response.read(1024 * 1024):
                    size += len(chunk)
                    if size > 128 * 1024 * 1024:
                        raise RuntimeError("Hermes archive exceeds the bounded download size.")
                    file.write(chunk)
            if digest(temporary) != lock["archiveSha256"]:
                raise RuntimeError("Hermes archive digest mismatch.")
            temporary.replace(path)
            return path
        except (urllib.error.URLError, TimeoutError, ConnectionError) as error:
            temporary.unlink(missing_ok=True)
            if isinstance(error, urllib.error.HTTPError) and error.code not in (429, 500, 502, 503, 504):
                raise RuntimeError("Hermes archive download was rejected (HTTP " + str(error.code) + ").") from None
            if attempt == 5:
                raise RuntimeError("Pinned Hermes archive is temporarily unavailable after bounded retries.") from None
            delay = min(30, 2 ** (attempt + 1))
            if isinstance(error, urllib.error.HTTPError):
                retry = error.headers.get("Retry-After", "")
                if retry.isdigit():
                    if int(retry) > 60:
                        raise RuntimeError("Archive source requests a later retry; keep the pin and retry after its cooldown.") from None
                    delay = max(delay, int(retry))
            print("Pinned source download temporarily unavailable; retrying after " + str(delay) + " seconds.", flush=True)
            time.sleep(delay)
        except Exception:
            temporary.unlink(missing_ok=True)
            raise
    raise RuntimeError("Archive download did not complete.")


if __name__ == "__main__":
    ensure_archive()
    print("Pinned Hermes source archive verified.")
