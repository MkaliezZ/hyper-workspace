# Optional public source build context

This default context contains no archive. Compose builds download the locked Hermes source with bounded retries and SHA-256 verification.

CI overrides the `hermes_source` named context with a directory containing only the verified public `hermes-source.tar.gz`. The Dockerfile mounts it read-only and verifies the digest again. Do not put credentials, Run directories or company data here. This is a public build input, not a secret.

For a direct Docker build, also pass `--build-context hermes_source=runtime/hermes/build-context`. See [deployment](../../../docs/DEPLOYMENT.md).
