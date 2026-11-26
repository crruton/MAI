# Verify charts and render the effective release

Read this before adding/upgrading a Helm-backed component or changing its values. A remembered version or a successful YAML parse is not upstream verification.

## Upstream evidence

1. Identify the official chart distribution URL and source repository. For an existing release, retain its pinned version unless an upgrade is requested or required by the change; explain any required upgrade.
2. Verify that the exact chart version is published in the upstream Helm index or OCI registry. Inspect that version's `Chart.yaml`, release notes and Kubernetes/CRD compatibility. Distinguish chart version from `appVersion`; do not copy example versions or silently select latest.
3. Read upstream `values.yaml`, `values.schema.json` when present, README and templates from the same release. Check every added/changed key, type and nesting, including chart-specific support for existing Secrets. A schema may allow unknown keys, and Helm may silently ignore them: trace uncertain keys into templates and rendered behavior.
4. Record the upstream URL, chart/version, package SHA-256 or OCI digest, relevant values/schema links and retrieval commands in the project's artifact record. For the shared/vendored profile, use `chart-source.md` next to the vendored chart. Use a version/tag/commit URL for source files rather than a moving default branch. Preserve the upstream license.
5. If upstream access fails, report exactly what could not be verified. Existing vendored metadata can establish the local version, but does not prove current publication or compatibility. Continue local checks without claiming upstream verification or guessing a replacement version.

## Select the source branch

For an existing HelmRepository/OCI source, retain that source and the project's
pinning policy. Fetch the exact artifact into a temporary directory for inspection
and rendering without committing it as a new runtime source. Check source
readiness and artifact identity separately from local render success. Continue
with **Validate the effective release** below.

## Vendor the complete chart

Use this branch only when Git vendoring is already established or explicitly
selected through [the shared/vendored profile](shared-vendored-profile.md).

Run downloads with an elapsed-time deadline using the available process runner. Fetch into a temporary directory first, inspect the contents, then copy the verified chart into `infra/<component>/charts/<chart>/` or `apps/<app>/charts/<chart>/`. Do not overwrite a vendored chart while investigating versions.

Choose the command matching the verified upstream distribution (placeholders must be replaced):

```bash
helm show chart <chart> --repo <upstream-url> --version <version>
helm show values <chart> --repo <upstream-url> --version <version>
helm pull <chart> --repo <upstream-url> --version <version> --destination <temporary-dir>

helm show chart oci://<registry>/<chart> --version <version>
helm show values oci://<registry>/<chart> --version <version>
helm pull oci://<registry>/<chart> --version <version> --destination <temporary-dir>
```

Keep the complete unpacked chart, including `Chart.yaml`, upstream defaults, schema, templates, CRDs and subcharts. Keep deployment-specific values outside the chart, in the component/overlay values files. Do not edit upstream defaults to configure an environment.

If dependencies are missing, use `helm dependency build <chart-dir>` with the upstream `Chart.lock`, then vendor the resulting `charts/` dependencies too. Without a lock file, build resolves dependencies like update; resolve and review exact versions deliberately, retain the generated lock and record this deviation. Avoid dependency updates during ordinary values-only changes. Verify nested dependencies and ensure the Git artifact includes all chart files and archives so reconciliation does not need upstream downloads.

Use `HelmRelease.spec.chart.spec.chart` for the directory path relative to the GitRepository artifact root and `reconcileStrategy: ChartVersion`. With GitRepository sources, `spec.chart.spec.version` does not pin anything; the committed chart content and `Chart.yaml.version` establish the version. No runtime HelmRepository/OCIRepository is needed for the vendored release.

Treat each chart version as immutable. Any change within the packaged chart, including CRDs and subcharts, requires a new `Chart.yaml.version`; otherwise Flux keeps the previous artifact. Keep upstream versions for unchanged packages. If a local chart patch is necessary, assign a distinct valid SemVer, document the upstream base and local changes in `chart-source.md`, and compare rendering with that deployed version. External `valuesFrom` changes are reconciled independently and need no chart version bump.

Do not use `Revision` with a shared Git source: Flux adds the source revision to the chart version for every commit, including unrelated changes. Charts commonly put this version in pod-template labels or configuration checksums, causing unnecessary upgrades and restarts. When migrating to `ChartVersion`, preview the one-time removal of revision metadata from the chart version and the resulting rollouts/hooks. Verify that unrelated commits leave chart versions and pod templates unchanged, while intended values changes still reach the release. Avoid per-commit timestamps, random values or Git SHA labels in pod templates as restart triggers.

## Validate the effective release

Build each affected overlay first. Read its HelmRelease and generated non-sensitive ConfigMaps to establish the actual merge order; do not assume that all clusters use the same overrides. Account for existing inline values, `targetPath`, post-renderers, release name, namespace, Kubernetes version and API capabilities. Never fetch or decrypt real Secret values to render locally; use clearly identified synthetic inputs only if needed, and report that limitation.

For the shared/environment example in [layout.md](layout.md), run from the GitOps repository root:

```bash
kustomize build clusters/dev/infra/new-component
helm lint infra/new-component/charts/my-chart --strict \
  -f infra/new-component/values.yaml \
  -f clusters/dev/infra/new-component/values.yaml
helm template new-release infra/new-component/charts/my-chart \
  --namespace new-component --include-crds \
  -f infra/new-component/values.yaml \
  -f clusters/dev/infra/new-component/values.yaml
```

Pass the target Kubernetes version/API capabilities when they affect rendering. Capture rendered manifests in a temporary file, check the requested behavior, then run `kubeconform -strict -summary` with required CRD schemas and `kube-linter lint` on the workloads. Report missing schemas/tools and render limitations. Render every affected environment, not just the shared base or dev. A values change should produce the intended workload diff, not merely pass Helm lint.

Preview with `flux diff` in each affected cluster where read access is available. It previews the HelmRelease and ConfigMaps, not the future Helm workload changes; retain the separate Helm render/diff as evidence. Include source artifact availability, dependency completeness, version/values evidence and affected consumers in the MR.

## Upstream references

- [Flux HelmChart chart paths, version and reconciliation strategy](https://fluxcd.io/flux/components/source/helmcharts/)
- [Flux HelmRelease values references](https://fluxcd.io/flux/components/helm/helmreleases/#values-references)
- [Helm pull](https://helm.sh/docs/helm/helm_pull/)
- [Helm dependency build](https://helm.sh/docs/helm/helm_dependency_build/)
