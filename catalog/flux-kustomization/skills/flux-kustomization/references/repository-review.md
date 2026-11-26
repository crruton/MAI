# Review Flux manifests and repository wiring

Use for a requested GitOps review or validation of a change. Scope findings to the requested files and their affected consumers; a full security audit is a separate scope from an ordinary manifest edit.

## Discovery and schema checks

1. Identify cluster entrypoints, source objects, component overlays and generated resources. Preserve the existing bootstrap/Operator and Git/OCI delivery model. Generated bootstrap manifests and ResourceSet outputs have upstream owners; edit their source configuration.
2. Resolve API versions, field nesting, enums and mutually exclusive settings against the target controller's CRDs or version-matched official schemas. A newer upstream skill's field index is not evidence that an older cluster supports that field. Record the versions used for validation.
3. Build each affected overlay and inspect the effective result after patches, image transforms and substitutions. Building the cluster root does not traverse child Flux Kustomization paths; Kustomize does not render HelmRelease workloads. Validate those layers separately.
4. Use matching Flux/project schemas with the repository's validator. Where installed, Flux schema discovery/validation tools can supplement it; check local help and supported versions first. Report unknown CRDs, encrypted payloads and unresolved substitutions as coverage gaps rather than claiming full validation.
5. Check API deprecations against the target upgrade. If the installed CLI supports it, `flux migrate -f <scoped-directory> --dry-run` provides a local migration preview. A failed or incomplete scan is not a clean result; changing apiVersion alone may miss removed fields or changed defaults.

Keep rendered output containing credentials out of logs and the repository. Use non-sensitive substitution inputs for local validation; document unresolved Secret-backed inputs. Validate substituted names/types rather than treating every literal `${VAR}` in source YAML as an invalid manifest.

## Operational review

- **Ownership:** each applied object has one intended reconciler. Namespace, release identity and inventory ownership survive moves. A plain YAML source directory can be valid even without a checked-in kustomization.yaml; inspect how Flux builds it.
- **Artifact completeness:** source ignore rules and artifact boundaries include vendored charts, dependency archives and shared bases referenced by overlays. A build against the full checkout can hide omissions in a published artifact.
- **Readiness:** dependencies represent prerequisites, have no cycles and wait for meaningful controller/workload health. See [readiness and release behavior](readiness.md).
- **Recovery:** distinguish retry from rollback/uninstall, check hook and migration effects, and review PVC/Namespace deletion consequences before recommending prune, force or remediation changes.
- **Reactivity:** inspect stable-name values/substitution resources for the watch label when prompt reconciliation is required. Generated hash references already change the consuming HelmRelease spec; keep the name transformer intact.

## Security review when requested or implicated by the change

Inspect the rendered resource as well as its base; overlay patches can alter security settings.

| Area | Check | Evidence limit |
| --- | --- | --- |
| Secret handling | SOPS/External Secrets wiring; plaintext in values, substitutions, generators and patches | Redact findings; report file/key location, never credential content |
| Source authentication | TLS, approved source URLs, secret references or supported workload identity | A reference alone cannot prove credential permissions or validity |
| OCI integrity | Expected digest/tag policy and signature verification for remote sources | A semver tag is not inherently immutable; use registry policy/digests as evidence |
| Tenant isolation | Scoped impersonation, controller cross-namespace restrictions, default service accounts and admission policy | Evaluate cross-namespace references against actual tenant trust boundaries; same-team sharing is not automatically an exploit |
| Image automation | Separation of read-only fetch and write-capable push credentials, target branch protection | Repository YAML cannot prove external token scope or branch settings |
| Controller network | Required source artifact, DNS, API and external endpoint access under isolation | Local manifests cannot prove live CNI enforcement or connectivity |

Report each finding with file/field, rendered effect, affected consumers, evidence and proposed action. Separate errors, risks and optional improvements. Mark unavailable live evidence explicitly. Do not prescribe Operator migration, remote chart adoption or automatic version upgrades merely because upstream examples prefer them.

Source: independently summarized from [Flux repository auditing](https://github.com/fluxcd/agent-skills/tree/25da0ed5bfdd1d8f779ef79c2c7e336781978d87/skills/gitops-repo-audit) (Apache-2.0), adapted to the selected source and validation workflow.
