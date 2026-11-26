# Flux resource examples

Consult the relevant resource section when authoring a Kustomization or
HelmRelease. Check fields against the installed CRD. Paths, source names,
dependencies and values strategy are examples, not project defaults. The
HelmRelease example uses the opt-in shared/vendored profile; retain remote
sources when the target repository uses them.

## Flux Kustomization

```yaml
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: apps
  namespace: flux-system
spec:
  interval: 10m0s
  retryInterval: 2m
  timeout: 5m
  path: ./clusters/<name>/apps/<app>
  prune: true
  wait: true
  sourceRef:
    kind: GitRepository
    name: flux-system
  dependsOn:
    - name: infrastructure
  postBuild:
    substitute:
      CLUSTER_NAME: <name>
    substituteFrom:
      - kind: ConfigMap
        name: cluster-vars
```

Field families (verify support and types against the target CRD before use): `interval`, `retryInterval`, `timeout`, `path`, `prune`, `wait`, `sourceRef{kind,name,namespace}`, `dependsOn[{name,namespace,readyExpr}]`, `healthChecks[{apiVersion,kind,name,namespace}]`, `healthCheckExprs`, `postBuild{substitute,substituteFrom}`, `targetNamespace`, `serviceAccountName`, `patches`, `images`, `components`, `decryption`, `force`, `deletionPolicy`, `suspend`, `kubeConfig`, `commonMetadata`, `namePrefix`/`nameSuffix`.

Decisions:
- `prune: true` deletes objects removed from the reconciler's inventory. A file move alone preserves objects when rendered identity and ownership remain unchanged; changing name, namespace or owning Kustomization can cause deletion. Inspect inventory and `flux diff` for unintended removals, especially PVCs and Namespaces.
- `wait: true` waits for all applied resources; use `healthChecks` instead when only some matter. When `wait` is true, `healthChecks` are ignored; the example uses all-resource health checking.
- `dependsOn` orders reconciliation across Kustomizations (CRDs before the resources using them). It waits for Ready of the dependency.
- `timeout` must exceed the slowest rollout; `interval` is drift-correction frequency, not deploy latency.
- `postBuild.substitute` replaces `${VAR}` in manifests; `${VAR:-default}` supplies defaults. `substituteFrom` reads a ConfigMap or Secret (reference only, keep keys non-sensitive in ConfigMaps). A literal `${VAR}` that must survive (shell scripts in ConfigMaps) is escaped as `$${VAR}`.
- Dedicated `serviceAccountName` for tenant apps limits blast radius.

## HelmRelease v2

The chart is committed at `apps/api/charts/api/`; the path is relative to the Git source artifact root, not the overlay. Check that the source artifact includes the chart and its dependency archives. This example requires cross-namespace source references to be allowed; otherwise use an approved same-namespace GitRepository pointing to the same Git content.

```yaml
apiVersion: helm.toolkit.fluxcd.io/v2
kind: HelmRelease
metadata:
  name: api
  namespace: apps
spec:
  interval: 10m
  timeout: 5m
  releaseName: api
  chart:
    spec:
      chart: ./apps/api/charts/api
      reconcileStrategy: ChartVersion
      sourceRef:
        kind: GitRepository
        name: flux-system
        namespace: flux-system
  install:
    remediation: {retries: 3}
  upgrade:
    remediation: {retries: 3, remediateLastFailure: true}
  rollback:
    cleanupOnFail: true
  dependsOn:
    - name: postgres
  driftDetection:
    mode: enabled
  valuesFrom:
    - kind: ConfigMap
      name: api-values
      valuesKey: values.yaml
      optional: false
```

Field families (verify against the target CRD): `chart{metadata,spec{chart,version,sourceRef,interval,reconcileStrategy,valuesFiles,ignoreMissingValuesFiles,verify}}`, `chartRef{apiVersion,kind,name,namespace}` (OCIRepository/HelmChart; use instead of `chart`), `values`, `valuesFrom[{kind,name,valuesKey,targetPath,optional}]` (kind `ConfigMap` or `Secret`), `install`, `upgrade`, `rollback`, `uninstall`, `test`, `driftDetection`, `dependsOn`, `postRenderers`, `targetNamespace`, `storageNamespace`, `releaseName`, `maxHistory`, `serviceAccountName`, `waitStrategy`, `healthCheckExprs`, `suspend`.

- For the selected shared/vendored profile, keep non-sensitive values in separate files consumed through `configMapGenerator` and `valuesFrom`. Later entries override earlier; existing inline `spec.values` override those entries, so account for them when migrating to files. Other layouts retain their established values representation.
- ConfigMaps and the HelmRelease must share a namespace and kustomize build. Register `spec/valuesFrom/name` in `kustomizeconfig.yaml` so the generated hash is reflected in the release reference. Do not disable the hash or hardcode a generated name.
- For Git sources, `chart.spec.version` is ignored; `Chart.yaml.version` controls packaging with `ChartVersion`. Unrelated commits must not change chart artifacts or pod templates. Bump `Chart.yaml.version` whenever chart templates, defaults, schemas, CRDs or bundled dependencies change; preserve the upstream version for unmodified charts and document local revisions in `chart-source.md`. Values supplied through external `valuesFrom` do not need a chart version bump. Do not use `Revision` against a shared GitRepository: every commit gets a new chart version containing its SHA, which can roll workloads through chart-version labels. Switching existing releases to `ChartVersion` may cause one final rollout as the SHA is removed; preview it explicitly.
- Sensitive values come only from SOPS/External Secrets via Secret references; never put them in ConfigMaps. Preserve existing Secret references and merge order when patching `valuesFrom`.
- Render the exact vendored chart with the same effective values before merging; validate resources with `kubeconform` and `kube-linter`. Detailed upstream and rendering checks: [references/helm-vendoring.md](helm-vendoring.md).
