import hashlib
import io
import tempfile
from pathlib import Path
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from download import ensure_archive


class ArchiveDownloadTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "source.tar.gz"
        self.body = b"synthetic locked source archive"
        self.lock = {"archiveUrl": "https://example.invalid/pinned", "archiveSha256": hashlib.sha256(self.body).hexdigest()}

    def test_rate_limit_retries_without_changing_the_pin(self):
        error = HTTPError(self.lock["archiveUrl"], 429, "limited", {"Retry-After": "3"}, None)
        with patch("download.urllib.request.urlopen", side_effect=[error, io.BytesIO(self.body)]) as request, patch("download.time.sleep") as sleep:
            self.assertEqual(ensure_archive(self.path, self.lock).read_bytes(), self.body)
            self.assertEqual(request.call_count, 2)
            sleep.assert_called_once_with(3)

    def test_bad_download_and_cache_fail_without_accepting_new_content(self):
        with patch("download.urllib.request.urlopen", return_value=io.BytesIO(b"wrong")) as request:
            with self.assertRaisesRegex(RuntimeError, "digest mismatch"):
                ensure_archive(self.path, self.lock)
            self.assertEqual(request.call_count, 1)
        self.assertFalse(self.path.exists())
        self.path.write_bytes(b"poisoned cache")
        with patch("download.urllib.request.urlopen") as request:
            with self.assertRaisesRegex(RuntimeError, "digest mismatch"):
                ensure_archive(self.path, self.lock)
            request.assert_not_called()

    def test_local_build_archive_is_verified_and_does_not_need_network(self):
        source = self.path.with_name("mounted-source.tar.gz")
        source.write_bytes(self.body)
        with patch("download.urllib.request.urlopen") as request:
            ensure_archive(self.path, self.lock, source)
            request.assert_not_called()
        self.assertEqual(self.path.read_bytes(), self.body)


if __name__ == "__main__":
    unittest.main()
