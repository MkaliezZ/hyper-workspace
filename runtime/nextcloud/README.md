# Pinned Nextcloud integration test runtime

Nextcloud 33.0.10 is pinned by Docker image digest in `scripts/ci/nextcloud-setup.sh`. Talk 23.0.12 is pinned by release archive size, SHA-256 and declared server compatibility in `talk.lock.json`.

`python3 runtime/nextcloud/install-talk.py` downloads and verifies the official app under ignored `.runtime/nextcloud/`. The CI setup script copies that app into its isolated source container, enables it through `occ`, and checks the installed version. It does not patch Nextcloud tables or product data. Upstream licenses remain in the downloaded distribution; Hyper Workspace's MIT license does not relicense them.

Only synthetic accounts and test rooms are created in CI. These scripts are not a production deployment guide. See [product identity](../../docs/NEXTCLOUD-IDENTITY.md) and [communication scope](../../docs/NEXTCLOUD-TALK.md).
