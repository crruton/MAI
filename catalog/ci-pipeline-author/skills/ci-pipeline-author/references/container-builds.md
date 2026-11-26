# Container build checks in CI

Use when changing Dockerfiles, build context or image jobs. Preserve the selected builder and verify its supported frontend, platforms, target and exporter.

- Reject credentials in Dockerfile `ARG`/`ENV`, credential-bearing URLs and copied files. Use the builder's ephemeral secret/SSH mechanism; read [build secrets](build-secrets.md) for mounts, cache behavior and leakage checks.
- Keep maintained, compatible bases with explicit versions; do not use `latest` or omitted tags for release inputs. Pin tested digests for immutable identity and keep an update process. Slim, Alpine, distroless and scratch have different ABI, runtime-library and shell constraints; compare the final image, not just base size.
- Use named build/runtime stages and copy only required artifacts and runtime dependencies. BuildKit may skip an unrelated test stage; execute required tests explicitly. Check the exact target the publish job exports.
- Check the effective `.dockerignore` against the actual context. Keep lockfiles and packaging inputs, omit credentials and irrelevant generated files, and copy stable dependency inputs before source to retain useful cache boundaries.
- Combine related download/install/cleanup in one `RUN`; use failure-propagating chaining and remove unnecessary package caches in that layer. Later deletion does not remove earlier-layer bytes. Keep build-only tools out of the final stage; do not collapse unrelated steps merely to minimize layer count. Cache mounts are disposable acceleration, not the sole location of runtime artifacts.
- Run as the supported non-root user, verify mounted-path ownership, and avoid blanket permission changes. Use exec-form `ENTRYPOINT`/`CMD`; setup wrappers must fail on errors and end with `exec "$@"`. Check signals, child reaping and stop grace; an optional init does not implement application draining.
- Verify workload-appropriate health probes in the final image, including executable availability and timing. A successful build does not prove runtime ABI, permissions or readiness.
- Run Hadolint and supported `docker buildx build --check` against the actual context/target. KICS Dockerfile checks and applicable Semgrep rules can supplement them; record versions, skips and parser errors. Lint cannot replace a final-target build, scoped image scan and bounded runtime smoke check.
- Preserve the tested artifact digest through publication and deployment; do not rebuild a tag and call it the same artifact. Report unavailable build/runtime checks and distinguish warnings from enforced gates.

Sources: [Docker build practices](https://docs.docker.com/build/building/best-practices/), [multi-stage builds](https://docs.docker.com/build/building/multi-stage/), [build checks](https://docs.docker.com/build/checks/), [Dockerfile runtime instructions](https://docs.docker.com/reference/dockerfile/).
