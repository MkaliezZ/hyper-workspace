# Product document extraction helper

Development component for P02/P04/P07, C02/C04/C07, A04/A08/A10 and E02/E04/E05/E07/E09 subsets. It does not expose PDF/Office import in the product yet. Next integration must preserve source permissions, versions, invalidation and private visibility rather than bypassing the existing Files service.

The helper is independent of DSH/Hermes and uses no model, source credentials or network calls. The TypeScript business core remains responsible for authorization, data ownership and extraction admission. Python 3.14.6 is already used by the pinned runtime/container combination; its extraction environment is separate from Hermes.

Pinned direct packages: pypdf 6.21.4, python-docx 1.2.0, openpyxl 3.1.5, python-pptx 1.0.2 and defusedxml 0.7.1. `requirements.lock` fixes all ten transitive packages with distribution hashes. Installation must retain `--require-hashes`; no floating installation or runtime download. The lock was resolved from PyPI on 2026-10-30 and locally installed on Python 3.14.6/macOS; Linux compatibility is checked in CI. These new pins are not yet an approved production parser combination.

Direct dependency license metadata checked against PyPI: pypdf BSD-3-Clause; python-docx/openpyxl/python-pptx MIT; defusedxml PSFL. Libraries remain unmodified distributions with their own license files; retain notices when packaging. No Office renderer or proprietary service is introduced.

```bash
python3 -m venv .runtime/documents
.runtime/documents/bin/python -m pip install --require-hashes -r runtime/documents/requirements.lock --index-url https://pypi.org/simple
.runtime/documents/bin/python -m unittest discover -s runtime/documents -p test_extract.py -v
# Reads bytes from stdin and writes one JSON object; format is a host-controlled argument.
.runtime/documents/bin/python runtime/documents/extract.py pdf < selected-test.pdf
```

Output contains `parserVersion`, `format`, `text`, `sections[{locator,text}]` and `warnings`. Expected format failures return exit 2 and a fixed/controlled error message, without parser trace or original bytes. It accepts at most 8 MiB input, 18000 extracted characters including locators, 2000 text sections; longer documents fail explicitly, never silently truncate. The CLI sets a 15-second CPU limit and Linux 1-GiB address-space limit. A parent launcher still needs wall-clock timeout, bounded stdout/stderr, a minimal environment, no shell, concurrency limits and cancellation. Do not invoke it directly from production requests before that launcher exists.

- PDF: maximum 50 pages, bounded decoded page streams, exact page locators; encrypted files rejected, empty/scanned pages reported without pretending OCR occurred. [pypdf extraction documentation](https://pypdf.readthedocs.io/en/stable/user/extract-text.html) describes extraction memory requirements and scanned-image limits. The size check itself requires decoding, so the process memory/time boundary is also needed.
- DOCX: paragraphs and nested tables in body order, with block/row/column locators and merged-cell deduplication. Tracked insertions/deletions rejected until accepted in the source editor. Headers, footers, comments and image text excluded with a warning. [Document API](https://python-docx.readthedocs.io/en/latest/api/document.html), [table limitations](https://python-docx.readthedocs.io/en/latest/user/tables.html).
- XLSX: readonly, maximum ten sheets and bounded actual cell enumeration; visible sheets only, exact cell locators. Formula expressions remain labelled uncomputed rather than using stale cached results as current facts. No external links are loaded. Hidden rows/columns are not filtered separately. [Readonly mode](https://openpyxl.readthedocs.io/en/stable/optimized.html), [XML security and defusedxml](https://openpyxl.readthedocs.io/en/stable/).
- PPTX: up to 50 slides, nested groups and table cell text, with slide/shape/cell locators. No notes, charts, SmartArt, image OCR or audio/video transcription; shape order is not a promise of visual reading order. [Text model](https://python-pptx.readthedocs.io/en/latest/user/text.html), [tables](https://python-pptx.readthedocs.io/en/latest/user/table.html).
- OOXML preflight bounds package count, decompressed size, per-member size and compression ratio; rejects duplicate/unsafe paths, encrypted/symlink entries, DTD/entities/unsupported XML encoding and macro payloads. It does not extract archive members to disk or execute document code.

Local evidence: eight behavioral tests generate synthetic files in memory, check actual extraction/locators/order/formula handling, unreadable/encrypted states, invalid packages, limits, and the subprocess JSON/error boundary. No real company documents, model quality, original E01–E10 or product-level PDF/Office acceptance is claimed. Existing product limits remain unchanged until integration and its own tests land.

Next: implement bounded TypeScript launcher; register exact MIME/extension pairs in StorageProvider; save parser version/warnings/locators with the source copy and bind them into `sourceVersion`; invalidate readings/vectors on parser/source changes; expose explicit extraction limitations in preview and AI context; add real source/container tests. Do not mark formats available solely from these helper tests.
