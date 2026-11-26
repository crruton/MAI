# Validation notes

## Pre-merge evidence

For a new chart or a change to runtime/deployment behavior, inspect the actual Kubernetes version, CNI, ingress hostNetwork and load-balancer protocol, registry reachability from nodes, capacity, StorageClass/PVC retention, secret source and rollout ownership. Reuse verified repository/profile facts. Ask early about unknown choices that affect the implementation: external versus in-chart dependencies, capacity changes, credentials ownership, release behavior and an authorized first-runtime-test target. Explain the consequence of each question; do not ask the user to repeat observable cluster facts.

Before recommending merge, render the real environment and image injection; validate schemas and policy scope, exercise changed entrypoints with the real UID/read-only filesystem/volume layout, and check runtime image pulls from the target network. Use an authorized disposable/staging target for startup, storage initialization and changed network paths when available. Inspect migrations and existing state before any execution. A test pod is a cluster mutation even when its command only prints a version.

A local container smoke test is useful but does not prove CSI behavior, CNI enforcement or ingress. For network changes, follow [network policy checks](networkpolicy.md), including cross-node allowed and denied cases. For stateful upgrades, compare live pod images/revisions with the proposed controller template; an unready old pod may block replacement even after the template is corrected.

Do not defer a check that can safely run before merge to the first main deployment. If a required runtime check has no authorized pre-merge target, state the gap and agree the first-deploy verification and recovery plan before recommending merge. Do not substitute production mutation or a green lint result for that evidence. Keep unfinished required work distinct from completed work awaiting owner review.

After deployment, verify actual pod image IDs, readiness, TLS through the real ingress/LB path and the agreed bounded user journey. Report untested behavior explicitly; Ready pods and HTTP health checks do not establish model inference, background job completion or data recovery.

## Command set

```bash
helm lint . --strict -f values-prod.yaml
helm template rel . -n <ns> -f values-prod.yaml | kubeconform -strict -ignore-missing-schemas -summary -kubernetes-version 1.30.0
helm template rel . -n <ns> -f values-prod.yaml | kube-linter lint -
```

Set `-kubernetes-version` to the cluster's minor. `--strict` makes lint warnings fail. kube-linter config for repo-wide exceptions lives in `.kube-linter.yaml`; list checks with `kube-linter checks list`.

## Runtime registry reachability

Check image pulls from the target cluster separately from CI/build network access. Inspect all rendered containers and init containers, including dependency subcharts. Preserve the digest when replacing an unreachable corporate mirror with its public upstream; otherwise adopt and scan an explicitly selected replacement artifact. Use approved registry credentials for private images. A successful runner pull or local render does not prove cluster reachability. For example.com/TW deployments, the corporate mirror is office/VPN-only and unavailable to TW. Use the `ci-pipeline-author` corporate profile when installed; otherwise confirm reachable upstream/Harbor endpoints with the infrastructure owner.

## Dependency lock and render artifacts

When `Chart.yaml` declares dependencies, generate and commit `Chart.lock`, including when all subcharts are local. For a chart whose dependencies already exist under `charts/`, use `helm dependency update <chart-dir> --skip-refresh` to avoid refreshing unrelated configured repositories. Inspect the diff: retain the project-owned subchart sources and do not replace them with external charts.

Render with the actual deployment tool and validate the exact output artifact. werf can write `Cannot automatically download chart dependencies without Chart.lock or requirements.lock.` to stdout when the lock is absent, making redirected output invalid Kubernetes YAML even though rendering exits successfully. Generate the lock and rerender; do not strip arbitrary output lines or suppress schema errors.

## Validator commands inside CI images

Check each pinned image's entrypoint and executable location, then run the validation command inside that image with the runner's working directory and entrypoint behavior. A locally installed CLI does not verify the container command. The Alpine images for kubeconform v0.8.0 and kube-linter v0.8.3 place their binaries at `/kubeconform` and `/kube-linter`, outside `PATH`. When overriding the entrypoint for GitLab shell scripts, call those absolute paths. Recheck paths when changing images; do not add the checkout directory to `PATH` as a workaround.

## Frequent kube-linter findings

| Check | Fix |
|---|---|
| `no-read-only-root-fs` | `readOnlyRootFilesystem: true` plus `emptyDir` for writable paths |
| `run-as-non-root` | pod `runAsNonRoot: true` and numeric `runAsUser` |
| `unset-cpu-requirements`, `unset-memory-requirements` | set requests; memory limit; CPU limit per policy (check may need config if CPU limits are omitted by policy) |
| `no-anti-affinity` | `podAntiAffinity` or topologySpreadConstraints when replicas > 1 |
| `pdb-unhealthy-pod-eviction-policy` | Review `AlwaysAllow` against supported API version and intended unhealthy-pod eviction behavior |
| `latest-tag` | pin image tag or digest |
| `drop-net-raw-capability` | `capabilities.drop: ["ALL"]` |
| `no-liveness-probe`, `no-readiness-probe` | Use workload-appropriate probes; liveness must not restart healthy processes for dependency failures; explain legitimate Job/worker exceptions |
| `default-service-account` | dedicated ServiceAccount when the app needs API access; else `automountServiceAccountToken: false` |
| `dangling-service` | Service selector must match pod labels |

## Schema testing

```bash
helm lint . --set replicaCount=0            # must fail (minimum: 1)
helm template r . --set image.pullPolicy=Foo # must fail (enum)
```

## Chart consumed by Flux

HelmRelease `spec.chart.spec` points at a chart in a GitRepository (`sourceRef.kind: GitRepository`, `chart: ./charts/<name>`) or `chartRef` at an OCIRepository. Environment values go into `spec.values` or `valuesFrom` (see `flux-kustomization`). Bump `Chart.yaml` `version` when templates change, otherwise Flux with `reconcileStrategy: ChartVersion` will not roll out the change.
