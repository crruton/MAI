# werf, registry and proxy failures

Read only when the target actually uses werf, Buildah, a container registry or a package proxy.


| Symptom | Cause | Fix location |
|---|---|---|
| `newuidmap`, `unshare`, `operation not permitted`, `fuse: device not found` in a werf/buildah build | Runner node or pod lacks Buildah prerequisites (user namespaces, rootless overlay or `/dev/fuse`, AppArmor/seccomp) | Runner: report to the platform with the job and runner name. Never switch the job to `docker:dind` or ask for `privileged` |
| `Could not resolve host: <package-proxy>`, connect timeout to the mirror | Job network cannot reach the configured proxy (DNS, routing or VPN) | Repo: select a verified network-capable runner, repair connectivity through its owner, or use the approved public default |
| 404 from `<package-proxy>/<eco>/...` for one package | Upstream not enabled in the package proxy, or the package is new and not cached yet | Retry history first; persistent: report to the platform, keep the job on the mirror |
| `unauthorized`/`401` from `<registry>` | Registry credential variables absent on this ref (protected) or robot account expired | Human: report the variable name and ref; never move credentials into YAML |
| `giterminism: ... env ... not allowed` from werf | `werf.yaml` reads a variable not listed in `werf-giterminism.yaml` | Repo: add it to `allowEnvVariables` |
| `werf converge` timeout or rollback | Workload not ready (probe, image pull, quota) | Diagnose the release with `k8s-pod-triage`; the job is only the messenger |
| Cache restore `no matching files` / `Failed to extract cache` every time | Key changes every run, path outside `$CI_PROJECT_DIR`, or protected/unprotected cache separation | Repo: fix key/path; protected/unprotected separation is expected where enabled |
| Pipeline not created: `include:component` or `include:project` errors | Legacy shared include, version or input mismatch | Repo: fix the pin or inputs to restore the pipeline; replacing shared includes with in-repo jobs is a separate MR |
