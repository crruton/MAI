# Runtime configuration and reload mechanisms

## Configuration ownership

Keep non-sensitive application configuration in ConfigMaps and credentials in Secrets. Reference them through volumes, `envFrom`, `valueFrom` or chart-supported existing ConfigMap/Secret settings instead of embedding runtime configuration in workload manifests or plaintext Helm values. Keep Secret delivery through the existing SOPS/External Secrets workflow; never read or decrypt real Secret values for validation.

Distinguish Helm input from application input:

- Helm values ConfigMaps/Secrets feed `HelmRelease.spec.valuesFrom`. Keep generated values ConfigMap hashes and Kustomize name-reference rewriting. Flux reconciles changes to these inputs independently of `ChartVersion`; use the Flux watch label when immediate reconciliation of stable-name values references is needed. Do not attach Reloader to HelmRelease objects or assume these input ConfigMaps are mounted by pods.
- Runtime ConfigMaps/Secrets are consumed by pods. Prefer chart-supported existing-resource references and stable names when Reloader owns restarts for in-place updates. If Kustomize hash names are retained, the changed pod reference already triggers a rollout: configure name rewriting and avoid a second reload trigger for that same change. Do not disable hash suffixes globally to accommodate one runtime ConfigMap.

## Select the reload owner

Preserve working native live reload, chart checksums or hashed resource references.
Identify which input changes require a restart before choosing another controller.
Read the Reloader branch only when the project already uses it or explicitly
selects it for this task; Flux alone does not require installing Reloader.

## Reloader wiring

For the selected Reloader mechanism, use it for configuration-driven rolling updates. Check the installed controller version, namespace watch scope, workload support and RBAC without reading Secret data. If absent, declare a pinned, validated GitOps component with explicit watch scope as part of an authorized implementation; annotations alone do not provide a working controller. Reloader needs its own access to watched resources, including Secrets; report that scope when adding it.

Put opt-in annotations on the consuming Deployment, StatefulSet or DaemonSet's `metadata.annotations`, not only on its pod template, HelmRelease or ConfigMap. Use chart-supported workload annotations or a focused post-renderer rather than patching vendored templates. Prefer explicit resource names so changing an unrelated object cannot restart a workload:

```yaml
metadata:
  annotations:
    configmap.reloader.stakater.com/reload: "api-config"
    secret.reloader.stakater.com/reload: "api-credentials"
```

Use `reloader.stakater.com/auto: "true"` only when all ConfigMaps/Secrets referenced by that workload should trigger a reload. Do not enable cluster-wide auto-reload-all. Confirm annotation keys and chart values against the exact controller/chart release: configuration differs between Reloader versions.

Choose a GitOps-compatible reload strategy supported by the pinned release (annotation-based reloads where supported). Check how Flux/Helm drift detection handles the controller-owned pod-template fields; avoid correction loops and do not disable drift detection globally. Preserve reload annotations through Helm upgrades. For operator-managed workloads, use the operator's supported annotation mechanism and verify it preserves Reloader changes rather than repeatedly overwriting them.

Avoid duplicate restart mechanisms for the same input: native live reload, chart checksum-triggered rollout, hashed resource references and Reloader can overlap. Keep a working native live-reload path where restarting would be unnecessary or disruptive, and scope Reloader to inputs that require a restart. Do not add Git SHA, timestamps or random annotations to force reloads. Plan the workload's rolling-update availability, especially for single-replica stateful workloads and GPU components.

## Validation

Render exact pinned charts with effective values and inspect runtime resource references and workload annotations. Confirm a config-only edit changes the intended ConfigMap/Secret reference or data without changing unrelated pod templates or chart versions. Validate synthetic Secret fixtures only; never fetch real Secret data. Local rendering verifies wiring, not controller behavior.

When runtime changes are authorized, verify that changing one watched input reloads only its consumers and an unrelated input does not. Do not mutate live configuration or rotate credentials solely to test reloads without authorization. Report runtime evidence separately from local checks.

## References

- [Flux HelmChart reconciliation strategy](https://fluxcd.io/flux/components/source/helmcharts/#reconcile-strategy)
- [Flux HelmRelease values references](https://fluxcd.io/flux/components/helm/helmreleases/#values-references)
- [Stakater Reloader annotations and reload strategies](https://github.com/stakater/Reloader)
