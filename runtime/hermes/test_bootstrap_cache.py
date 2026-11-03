import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from bootstrap_cache import seed_pinned_archive


class BootstrapCacheTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.data = b"synthetic pinned public tool archive"
        self.archive = self.root / "archive.tar.gz"
        self.archive.write_bytes(self.data)
        self.digest = hashlib.sha256(self.data).hexdigest()
        self.spec = {"sha256": self.digest, "url": "https://example.invalid/tool.tar.gz"}
        self.store = self.root / "store"

    def test_verified_bytes_are_reusable_without_creating_install_receipts(self):
        target = seed_pinned_archive(self.archive, self.store, self.spec)
        before = target.stat().st_mtime_ns
        self.assertEqual(target.read_bytes(), self.data)
        self.assertEqual(seed_pinned_archive(self.archive, self.store, self.spec), target)
        self.assertEqual(target.stat().st_mtime_ns, before)
        self.assertFalse(list(self.store.rglob("*.json")))

    def test_corrupt_input_never_creates_a_cache(self):
        self.archive.write_bytes(b"tampered")
        with self.assertRaisesRegex(RuntimeError, "integrity"):
            seed_pinned_archive(self.archive, self.store, self.spec)
        self.assertFalse(self.store.exists())

    def test_symbolic_input_cannot_be_used_as_public_archive(self):
        link = self.root / "link.tar.gz"
        link.symlink_to(self.archive)
        with self.assertRaisesRegex(RuntimeError, "regular public archive"):
            seed_pinned_archive(link, self.store, self.spec)
        self.assertFalse(self.store.exists())

    def test_existing_poisoned_cache_is_not_replaced(self):
        target = seed_pinned_archive(self.archive, self.store, self.spec)
        target.write_bytes(b"existing unknown bytes")
        with self.assertRaisesRegex(RuntimeError, "integrity"):
            seed_pinned_archive(self.archive, self.store, self.spec)
        self.assertEqual(target.read_bytes(), b"existing unknown bytes")

    def test_unrelated_cache_files_are_preserved_and_refused(self):
        target = seed_pinned_archive(self.archive, self.store, self.spec)
        unrelated = target.parent / "unrelated-file"
        unrelated.write_bytes(b"must not be removed")
        with self.assertRaisesRegex(RuntimeError, "Unexpected"):
            seed_pinned_archive(self.archive, self.store, self.spec)
        self.assertEqual(unrelated.read_bytes(), b"must not be removed")

    def test_cli_defaults_offline_and_does_not_echo_invalid_private_arguments(self):
        script = str(Path(__file__).with_name("bootstrap_cache.py"))
        sentinel = "private-sentinel-must-not-be-echoed"
        env = dict(os.environ, HERMES_BOOTSTRAP_DIR=sentinel)
        result = subprocess.run([sys.executable, script], env=env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(json.loads(result.stdout)["requestsSent"], 0)
        rejected = subprocess.run([sys.executable, script, sentinel], env=env, capture_output=True, text=True)
        self.assertNotEqual(rejected.returncode, 0)
        self.assertNotIn(sentinel, rejected.stdout + rejected.stderr)


if __name__ == "__main__":
    unittest.main()
