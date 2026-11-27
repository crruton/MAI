---
name: flux-kustomization
description: Author or diagnose Flux Kustomizations and HelmReleases in the project's existing GitOps layout. Use for reconciliation failures, GitOps manifest reviews, source paths, values wiring, SOPS or NetworkPolicy changes; preserve the selected chart source and reload mechanism.
version: 1.0.0
owner: crruton
---

# Flux Kustomization and HelmRelease

Produce a focused manifest change or a diagnosis with source-to-workload evidence,
validation results and exact remaining gaps. Follow the project's source ownership,
review and deployment workflow; authoring a change does not authorize applying it.

## Establish the project contract

1. Locate repository instructions, Flux entrypoints, source objects, Kustomizations,
   HelmReleases and their actual paths. Identify the target cluster/namespace,
   installed controller/CRD versions and every consumer of a shared component.
2. Record the existing chart source (Git, Helm repository or OCI), pinned artifact,
   values merge order, secret delivery and runtime reload mechanism. Preserve them
   during a narrow change. For a new component, use the documented project pattern;
   ask for unresolved source/layout choices that would change the implementation.
3. Read [the shared/vendored profile](references/shared-vendored-profile.md) only
   when the project selects its shared bases, cluster overlays and vendored charts.
   Otherwise use existing paths and source types without introducing that layout.

Done when target, source path, release identity, selected profile and validation
scope are known, or the exact blocking facts are recorded.

## Execution boundary

Inspect prune, force/recreation, namespace changes and Helm uninstall/remediation
before proposing a rollout. A Git revert cannot restore lost data. Keep diagnostic
cluster access read-only and prepare fixes in the owning source. Reconciliation,
suspension, restarts and other live mutations require the project's authorized
operational workflow; they are not implicit diagnostic steps.

Use Secret references and encrypted metadata; keep real values and private keys
out of inspection output. Preserve the installed secret-delivery mechanism. For
SOPS, inspect the owning encryption rules and decryption reference without
reading private keys or decrypting real Secrets. Prepare a plaintext-free skeleton
when a secret owner must supply the encrypted content.

## Select the procedure

- Failed or stale reconciliation: read [reconciliation](references/reconciliation.md)
  and trace the source-to-workload chain before editing manifests.
- Repository review, schema validation or API upgrade: read
  [repository review](references/repository-review.md); use the target installation.
- Dependency health, retries, drift ownership or configuration watches: read
  [readiness](references/readiness.md).
- Adding/upgrading charts or changing values: read
  [chart verification and rendering](references/helm-vendoring.md). Its vendoring
  branch applies only to Git-vendored releases.
- Runtime configuration changes: read
  [reload mechanisms](references/configuration-reloads.md). Keep working native
  reload, checksums or hashed references; use Reloader only when selected.
- Network isolation changes: read [NetworkPolicy](references/networkpolicy.md),
  including the actual DNS path and enforcement checks.
- Resource authoring or command syntax: consult only the needed
  [resource example](references/resource-examples.md) or
  [inspection command](references/inspection.md).

## Procedure for a change

1. **Locate the owner.** Match the changed resource to its source, path and
   consumers. Done when the intended file and affected clusters are identified;
   a matching filename alone does not establish ownership.
2. **Edit the narrowest source.** Use shared configuration for shared behavior
   and environment inputs for local differences. Inspect exact chart defaults,
   schema and templates before changing values. Done when rendered changes
   implement the requested behavior without unrelated source/layout migrations.
3. **Validate every affected overlay.** Run `kustomize build <dir>`, check source
   inclusion, reference names and namespaces. Render Helm separately with the
   pinned artifact and effective values: Kustomize emits the HelmRelease, not its
   workloads. Run project schema/policy checks with matching CRD schemas. Done
   when intended behavior is present and checks pass, or failures/skipped kinds
   are explicitly recorded; preserve failures through shell pipelines.
4. **Preview consequences.** Use `flux diff` for each affected cluster where
   authorized read access exists. Inspect inventory deletions, namespace/release
   identity, hooks and ownership changes. Done when every affected consumer has
   a reviewed preview or an explicit unavailable-check record. A HelmRelease
   diff does not replace the separate rendered workload comparison.
5. **Deliver.** Include behavior/cause, source and artifact identity, affected
   consumers, validation, live-preview status and recovery limits in the
   project's review artifact. For diagnosis without a code defect, return the
   evidence and next owner action rather than manufacture an MR.

## Traps

- Flux Kustomization and Kustomize's `kustomization.yaml` have different schemas.
- Repository checkout contents can exceed the published source artifact; check
  ignore rules and dependency inclusion before blaming a correct local build.
- Values ConfigMaps configure Helm; runtime ConfigMaps configure pods. Their
  update paths and reload owners are different.
- A cleared reconcile error does not prove the intended workload revision is
  healthy. Report the observed revision and remaining runtime checks.
