# Shared components and cluster overlays

Apply only within the explicitly selected [shared/vendored profile](shared-vendored-profile.md). Preserve other repository layouts.

Use root-level `infra/` and `apps/` for reusable bases. Keep environment-specific patches, values and resources under `clusters/<name>/`. Share a component even when its first consumer is a single cluster; adding a second cluster must not require copying its manifests or chart.

## Tree

```text
clusters/
  dev/
    kustomization.yaml
    flux-system/
    infra/
      flux-ks.yaml
      namespaces/
      crds/
      secrets/
      new-component/
        kustomization.yaml
        values.yaml
        specific-manifest.yaml
    apps/
      flux-ks.yaml
      frontend/
  prod/
    kustomization.yaml
    flux-system/
    infra/
      flux-ks.yaml
      namespaces/
      new-component/
        kustomization.yaml
        values.yaml
infra/
  new-component/
    kustomization.yaml
    kustomizeconfig.yaml
    hr-release.yaml
    values.yaml
    charts/
      my-chart/              # Unpacked, pinned upstream chart and dependencies
    chart-source.md          # Upstream URL, version, digest, retrieval instructions
  observability/
  cert-manager/
  postgresql/
apps/
  frontend/
  backend/
```

Only create resources that are needed. Add shared `deployment.yaml`, `service.yaml` or other manifests to the shared base's `resources` when Helm does not already own those objects. The example chart and values keys below are illustrative; resolve the real upstream chart before using them.

## Shared base

`infra/new-component/kustomization.yaml`:

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: new-component
resources:
  - hr-release.yaml
configMapGenerator:
  - name: values-new-component
    files:
      - values.yaml=values.yaml
configurations:
  - kustomizeconfig.yaml
```

`infra/new-component/kustomizeconfig.yaml`:

```yaml
nameReference:
  - kind: ConfigMap
    version: v1
    fieldSpecs:
      - path: spec/valuesFrom/name
        kind: HelmRelease
        group: helm.toolkit.fluxcd.io
```

Keep the default name hash for Helm values ConfigMaps. Kustomize must rewrite the HelmRelease reference to the generated ConfigMap name in the same build. Do not handwrite the resulting hash, commit rendered ConfigMaps or set `disableNameSuffixHash: true` to avoid configuring name references.

`infra/new-component/values.yaml`:

```yaml
replicaCount: 2
service:
  port: 8080
```

`infra/new-component/hr-release.yaml`:

```yaml
apiVersion: helm.toolkit.fluxcd.io/v2
kind: HelmRelease
metadata:
  name: new-release
  namespace: new-component
spec:
  interval: 10m0s
  chart:
    spec:
      chart: ./infra/new-component/charts/my-chart
      reconcileStrategy: ChartVersion
      sourceRef:
        kind: GitRepository
        name: flux-system
        namespace: flux-system
  install:
    remediation:
      retries: 3
  upgrade:
    remediation:
      retries: 3
  driftDetection:
    mode: enabled
  valuesFrom:
    - kind: ConfigMap
      name: values-new-component
      valuesKey: values.yaml
```

The chart path starts at the Git source root. Do not add the chart directory to kustomize `resources`: Helm templates are not Kubernetes manifests. Ensure source ignore rules include the chart and vendored dependency archives. The `flux-system` source reference crosses namespaces; if the controller disallows this, use an approved same-namespace GitRepository for the same content. Do not weaken controller isolation.

## Environment overlay

`clusters/dev/infra/new-component/kustomization.yaml`:

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: new-component
resources:
  - ../../../../infra/new-component
  - specific-manifest.yaml
configMapGenerator:
  - name: values-new-component-env
    files:
      - values.yaml=values.yaml
patches:
  - target:
      group: helm.toolkit.fluxcd.io
      version: v2
      kind: HelmRelease
      name: new-release
    patch: |-
      - op: add
        path: /spec/valuesFrom/-
        value:
          kind: ConfigMap
          name: values-new-component-env
          valuesKey: values.yaml
```

`clusters/dev/infra/new-component/values.yaml`:

```yaml
replicaCount: 1
```

`clusters/dev/infra/new-component/specific-manifest.yaml` (optional cluster-local resource):

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: dev-endpoint
data:
  url: https://dev-service.example.com
```

The inherited name-reference configuration covers both generated ConfigMaps. The release loads shared values first, then the environment file; `service.port` remains shared. Use distinct generator names: `behavior: merge` merges ConfigMap keys, not the YAML inside the `values.yaml` string, so it would replace the whole shared file. Preserve any Secret references and choose their position deliberately when extending a real release's `valuesFrom` list. Keep sensitive data out of both values files.

Create a prod overlay referencing the same base; its own values file and patches contain only prod differences. Native Kubernetes resource changes also belong in overlay `patches`; do not fork the shared manifests. Remove the optional manifest reference if no cluster-local resource is required. Apps use the same pattern with `apps` in place of `infra`.

## Flux registration

Append to `clusters/dev/infra/flux-ks.yaml`:

```yaml
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: new-component
  namespace: flux-system
spec:
  interval: 10m0s
  path: ./clusters/dev/infra/new-component
  prune: true
  wait: true
  sourceRef:
    kind: GitRepository
    name: flux-system
  dependsOn:
    - name: namespaces
```

`clusters/dev/kustomization.yaml`:

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - flux-system
  - infra/flux-ks.yaml
  - apps/flux-ks.yaml
```

Include `apps/flux-ks.yaml` only when it exists. Register prod separately with its prod overlay path. Never point a cluster's Flux Kustomization at the shared base when an overlay carries its settings. Do not also include component manifests directly in the cluster root: each object needs one reconciliation owner.

Ensure `namespaces` is a registered Flux Kustomization and includes the component namespace. Add `crds`, `secrets` or a controller dependency only when that component needs it. `dependsOn` entries refer to Flux Kustomization names, not directories or HelmRelease names. A CRD/controller-owning Kustomization must become Ready before its CR consumers; use appropriate readiness checks. Add SOPS `decryption` to the Flux Kustomization that applies encrypted resources.

## Verification

- Build the cluster root to check registration, and each component overlay separately; building the root does not render child Flux Kustomization paths.
- Confirm each generated values reference resolves to a ConfigMap in the HelmRelease namespace, and an edited values file changes both the ConfigMap hash and its reference.
- Render the vendored chart with shared and environment values in release order, following [helm-vendoring.md](helm-vendoring.md).
- For a shared change, build every consuming overlay and inspect the environment-specific differences. Preserve resource names, namespaces, release names and Flux inventory ownership during moves.

The transformer follows Flux's [generated values reference pattern](https://fluxcd.io/flux/guides/helmreleases/#refer-to-values-in-secret-generated-with-kustomize-and-sops), using ConfigMap for non-sensitive values. Merge order and namespace requirements are documented in [HelmRelease values references](https://fluxcd.io/flux/components/helm/helmreleases/#values-references).
