---
name: helm-chart-author
description: Write values for existing Helm releases or author and validate charts. Use for Helm values, templates, migration hooks, schemas, or kube-linter and kubeconform findings.
version: 1.0.0
owner: crruton
---

# Helm chart author

Establish the owning repository, target environment, execution context, change owner and authorized workflow from project instructions and configuration. Reuse known facts; ask only for missing information that changes the action.

Output: a reviewed values/chart diff with rendered manifests and validation results.

## Execution boundary

Inspect hooks, jobs, resource removals and PVC retention before proposing rollout or rollback. Helm rollback can execute hooks and cannot reverse lost data.

Before implementation, resolve missing environment decisions and plan pre-merge runtime evidence using [pre-merge checks](references/checks.md#pre-merge-evidence). Read existing configuration first; ask targeted questions only for unknowns that affect the chart. Static validation is necessary but does not establish runtime readiness.

## Existing release

Use this path when the application already has a release or chart. For a new application deployment, follow **New chart** below.

1. Locate the release owner: app CI/werf, Helm configuration, an Argo CD Application or a Flux HelmRelease. Preserve its environment file names, source and pinned chart version.
2. Inspect that version's defaults, schema and templates before writing values. Names such as `replicas` vs `replicaCount` or `image.name` vs `image.repository` are chart-specific; unknown values may be silently ignored.
3. Render with the real namespace, release name and environment values. Check the resulting workload, image identity, ports/probes, ingress/TLS hosts, resources and secret references.
4. Fix configuration in the app's values. A missing feature or template defect belongs in the chart repository; publish/adopt a reviewed chart version through the existing release process.
5. For migration hooks, inspect the rendered Job, independent resources, retry/deadline settings and Secret names. A release rollback does not undo a database migration; verify migration compatibility and recovery separately.

Use `helm lint`, `helm template` and manifest validation against the exact chart version; for werf use its render command, and for Flux inspect the HelmRelease source/values. Redact Secret output. Read [validation checks](references/checks.md) for relevant checks.

For Argo CD bootstrap, CRD ownership conflicts or repository-generation failures, read [Argo CD bootstrap checks](references/argocd-bootstrap.md).

## New chart

For a new application deployment, author a project-owned chart in the application repository using the [starter](templates/) and [validation reference](references/checks.md). Adapt it to the actual workload; the starter is a reference, not a guarantee for every workload. Preserve the existing deployment layout when adding a chart to a repository.

```bash
cp -r <skill-dir>/templates charts/<name>
```

## New chart: layout

```
charts/<name>/
  Chart.yaml              apiVersion v2, name, version (chart), appVersion (app)
  values.yaml             every knob with a safe default, commented
  values.schema.json      types, enums, required keys
  templates/
    _helpers.tpl          name, fullname, labels, selectorLabels
    deployment.yaml       (+ PDB)
    service.yaml
    networkpolicy.yaml
    NOTES.txt             optional
```

One chart, one workload. Multi-component apps use subcharts or separate charts, not a growing `if` forest. When declaring dependencies, including local subcharts, generate and commit `Chart.lock`; see [dependency and CI validation](references/checks.md).

## What goes in values and what stays hardcoded

In values (differs per environment or per deploy): image repository/tag, replicas, resources, env vars, ingress hosts, service port, NetworkPolicy peers, scheduling (nodeSelector, tolerations, affinity), feature toggles (`enabled` flags), references to existing Secrets/ConfigMaps by name.

Keep selector labels and API structure stable. Choose secure defaults for security contexts and token mounting, but preserve the workload's runtime requirements and the project's enforced policy. Expose reviewed settings when the image UID, writable paths, API access, probe semantics or tenancy differ; validate them in the schema. A chart default is not an admission-security boundary, and hardcoding one UID or probe path does not make every application safe.

Conventions:
- camelCase keys, nested by concern (`image.repository`, `image.tag`), flat booleans named `enabled`.
- Lists the user may extend are maps when merge matters (`env: {KEY: value}`), because Helm replaces lists wholesale.
- No secret values in values.yaml or in templates. Reference an existing Secret by name (`envFrom: [{secretRef: {name: app-secrets}}]`); the Secret itself comes from the secrets pipeline.
- Defaults that work in dev and are safe in prod. `image.tag` defaults to `.Chart.AppVersion`; production overrides with a pinned tag or digest, never `latest`.
- Use `required` for values that have no safe default, `default` for the rest. Use `toYaml | nindent N` for blocks; get the indent right or lint fails.
- Every resource gets `app.kubernetes.io/*` labels from `_helpers.tpl`; selectors use only `name` and `instance`.

## Workload hardening baseline

Adapt this baseline to the actual image and platform policy. Verify the image runs as the chosen numeric UID, required writable directories have suitable volumes/ownership, and token mounting is disabled unless the workload needs Kubernetes API access. Do not add blanket exceptions to make an incompatible image run.

Pod level:
```yaml
securityContext:
  runAsNonRoot: true
  runAsUser: 10001
  runAsGroup: 10001
  fsGroup: 10001
  seccompProfile: {type: RuntimeDefault}
automountServiceAccountToken: false
```
Container level:
```yaml
securityContext:
  allowPrivilegeEscalation: false
  readOnlyRootFilesystem: true
  runAsNonRoot: true
  capabilities: {drop: ["ALL"]}
```
Writable paths (`/tmp`, caches) get an `emptyDir` mount. Never `privileged`, `hostNetwork`, `hostPath` without written justification.

## Probes

- `startupProbe` for slow initialization; it gates both liveness and readiness until startup succeeds.
- `readinessProbe` decides traffic; may check dependencies it needs to serve.
- `livenessProbe` checks only "this process is wedged"; never dependencies.
- Use the named port (`port: http`). Keep `timeoutSeconds` at 1-2s minimum for loaded services.
- The starter uses one health path; split readiness from liveness if it checks dependencies. Jobs and self-terminating workers need workload-appropriate checks, not blindly copied HTTP probes.

## Resources

The starter schema requires CPU/memory requests and a memory limit; adapt the schema to the platform's resource policy. Derive values from representative usage and startup peaks; memory limit need not equal request, and equal memory alone does not give Guaranteed QoS. CPU limits follow cluster policy. See `k8s-rightsizing`.

## Availability and network

- Use a PodDisruptionBudget when voluntary evictions must preserve availability; derive it from replica count, quorum and serving capacity. `maxUnavailable: 1` is a starter choice, not safe for every workload. It does not protect against direct deletion or constrain Deployment rolling updates; review rollout strategy separately. Check support and intended behavior before setting `unhealthyPodEvictionPolicy`.
- Choose anti-affinity/topology spread against failure domains and actual node capacity; preferred spreading is a starter, not an availability guarantee.
- Follow the namespace's isolation model. Add workload NetworkPolicies where needed, with explicit dependencies and the actual DNS path if egress is isolated. Confirm CNI enforcement and test allowed/denied traffic. Authoring rules: [references/networkpolicy.md](references/networkpolicy.md).

## values.schema.json

Helm validates values against it on install, template, lint. Declare `required` keys (`image.repository`, `resources`), enums (`pullPolicy`, service type), numeric bounds (ports), and `additionalProperties: false` on objects where typos would silently be ignored (for example `image`). A schema failure must name the broken key; test it by passing a bad value.

## Validate a new chart (all must be clean)

```bash
helm lint charts/<name> -f <env-values>.yaml
helm template <release> charts/<name> -f <env-values>.yaml | kubeconform -strict -ignore-missing-schemas -summary
helm template <release> charts/<name> -f <env-values>.yaml | kube-linter lint -
```

- `kubeconform -strict` rejects unknown fields; `-ignore-missing-schemas` skips CRDs without a schema (pass `-schema-location` with the datree CRDs catalog to validate them).
- Lint with the production values too, not only defaults: conditionals render different manifests.
- Test toggles: render with `networkPolicy.enabled=false`, `podDisruptionBudget.enabled=false`, and with empty optionals (`env: {}`); each must still validate.
- Fix findings by changing the chart, not by adding kube-linter ignore annotations. An exception needs a written reason in the MR.
- `helm lint` INFO about missing icon is not a failure.

Details, common kube-linter findings and fixes, and Flux-specific notes: [references/checks.md](references/checks.md).

## Deliver a new chart

MR containing the chart, the values for each environment, and in the description: what the chart deploys, which values are required, the three validation commands with their clean result. If the chart is consumed by Flux, add the HelmRelease via the `flux-kustomization` skill in the same MR; preview with `flux diff`.

## Traps

- `{{ .Values.x }}` on an absent key renders empty and passes lint; the schema `required` is what catches it.
- Changing selector labels on an existing Deployment is immutable and breaks the rollout; keep `selectorLabels` stable.
- An ingress-only policy does not isolate egress. DNS needs an explicit allow when an Egress policy isolates the pod and no other policy already allows its DNS path; policies combine additively.
- Hardcoding namespaces in templates. Let the release namespace decide.
- ConfigMap/Secret changes do not restart pods; add a checksum annotation on the pod template if the config is mounted or consumed via env.

Technical references: [NetworkPolicy direction/default semantics](https://kubernetes.io/docs/concepts/services-networking/network-policies/) and [disruption-budget scope](https://kubernetes.io/docs/concepts/workloads/pods/disruptions/).
