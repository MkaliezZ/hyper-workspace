# Optional public source build context

This default context contains no archive. Compose builds download the locked Hermes source with bounded retries and SHA-256 verification.

`python3 runtime/hermes/bootstrap_cache.py --prepare-build` creates `.runtime/hermes-build-source` with exactly three verified public archives: the locked Hermes source and the Linux amd64 uv/Python tools selected by that source's `pm/lock.json`. Without arguments it performs an offline preflight. CI uses this explicit context; other native platforms can use the default download path.

The Dockerfile mounts the context read-only. The installer seeds only PM's hash-addressed download cache; PM rehashes, probes the native tools and creates its own installation receipts. No installed-state receipts or upstream pins are invented. Do not put credentials, Run directories or company data here. This is a public build input, not a secret.

For a direct Docker build, also pass `--build-context hermes_source=runtime/hermes/build-context`. See [deployment](../../../docs/DEPLOYMENT.md).
