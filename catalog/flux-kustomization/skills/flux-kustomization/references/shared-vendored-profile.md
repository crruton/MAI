# Shared bases and vendored charts profile

Use this profile only when the project explicitly selects shared `infra/` and
`apps/` bases, cluster overlays, Git-vendored charts and generated values files.
An existing Flux installation alone does not select this profile. For a new
repository, present this as an option; confirm the consequential layout/source
choice before creating the structure. Preserve unrelated release sources.

## Selected layout

```
clusters/<name>/
  kustomization.yaml  .sops.yaml  flux-system/
  infra/flux-ks.yaml  infra/{namespaces,crds,secrets}/  infra/<component>/
  apps/flux-ks.yaml   apps/<app>/
infra/<component>/   # Shared infrastructure: observability, cert-manager, postgresql
apps/<app>/          # Shared applications: frontend, backend
```

Keep reusable manifests and chart copies in root-level `infra/` and `apps/`. Put cluster-specific resources, values files and patches under `clusters/<name>/`; overlays reference the shared directory rather than copy it. A shared component is a reusable kustomize base, not necessarily `kind: Component`.

`flux-ks.yaml` holds one Flux Kustomization per deployed component, pointing to its cluster overlay. Derive `dependsOn` from actual namespace, CRD, controller and secret prerequisites; do not copy arbitrary app dependencies. Read [references/layout.md](layout.md) when adding or restructuring a component. Inspect the existing paths with `rg --files clusters infra apps`. Apply this model to new work; keep unrelated deployments untouched and preserve resource identity when migrating an existing component.

There are two different "Kustomization" kinds: the Flux one (`kustomize.toolkit.fluxcd.io/v1`, tells Flux what path to apply) and the kustomize one (`kustomize.config.k8s.io/v1beta1`, the `kustomization.yaml` that lists resources). Do not mix their fields.

## Where each task goes

1. Locate the owner, existing source and all cluster overlays consuming the component. Confirm the namespace in `clusters/<name>/infra/namespaces/` (or its existing equivalent).
2. Create or reuse `infra/<component>/` or `apps/<app>/` with `kustomization.yaml` and only the shared Kubernetes resources needed. For Helm, also include `hr-release.yaml`, `values.yaml`, `kustomizeconfig.yaml` and the vendored chart under `charts/<chart>/`.
3. Before adding/upgrading a chart or changing values, read [references/helm-vendoring.md](helm-vendoring.md). Verify the exact published version and supported values against upstream, then vendor the chart and its dependencies in Git. Do not invent a version or infer value keys from another chart/version.
4. Generate the shared values ConfigMap from `values.yaml`; wire `valuesFrom` and the custom name-reference transformer. Keep the hash suffix enabled.
5. Create `clusters/<name>/{infra,apps}/<component>/kustomization.yaml`, referencing the shared base. Patch environment differences here. Keep environment Helm values in a separate file, generate a second ConfigMap and patch `valuesFrom` to merge shared values first, environment values second. Do not copy the base or embed values YAML in a ConfigMap patch.
6. Register the overlay in `clusters/<name>/{infra,apps}/flux-ks.yaml` and ensure the cluster root includes that file. Set real `dependsOn` prerequisites and SOPS decryption only where needed. For CRD-heavy charts, choose `install.crds`/`upgrade.crds` explicitly and order CR consumers after the owning controller/CRDs are Ready.
7. Build every affected overlay, render the vendored chart with its effective values, preview and prepare the MR.

New Helm releases use `spec.chart.spec` with a repository-relative chart directory, `sourceRef.kind: GitRepository`, and `reconcileStrategy: ChartVersion`. Remote OCI/Helm repositories are upstream download sources for vendoring, not the default runtime source. Do not migrate unrelated existing releases during a narrow fix. If the project instead selects remote chart sources, follow that choice without loading this profile.


For runtime configuration, select the existing reload mechanism separately. This profile does not require installing Reloader.
