# Readiness, retries and configuration watches

Read when changing dependency gates, rollout health, Helm failure behavior, drift correction or values/substitution update latency. Verify fields and feature gates against the installed controller version before emitting YAML.

## Dependency gates

A dependency on a Kustomization waits for that object's readiness. If it only applies a HelmRelease without checking its health, the dependency may pass before Helm installs the controller or its CRDs. Put CRD/controller installation and custom-resource consumers in separate Kustomizations; make the former wait for the relevant HelmRelease or workloads.

Choose one health scope:

- `wait: true` checks all reconciled resources and ignores `healthChecks`.
- Explicit `healthChecks`, with `wait` false or omitted, checks only the selected resources. Use this when unrelated objects should not block the dependency.

For custom resources with unsupported health semantics, use version-supported `healthCheckExprs`. Evaluation checks `inProgress`, then `failed`, then `current`. Guard optional fields and test expressions against missing status, progressing, failed and healthy objects. Ensure the healthy case actually contains the required condition; an `all()` predicate over an empty filtered list can succeed without evidence of readiness.

A dependency `readyExpr` replaces the built-in readiness test unless `AdditiveCELDependencyCheck` is enabled. Include current-generation readiness as well as any version/label constraint when replacing that test; a matching version label alone does not establish a completed rollout. Check for cycles before adding edges.

## Helm failure behavior

Choose behavior from workload recovery requirements, not uniformity across releases:

| Strategy | Effect | Decision |
| --- | --- | --- |
| `RetryOnFailure` | Retries failed actions without automatic uninstall/rollback; failed installs are retried through an upgrade | Consider when rollback/uninstall would disrupt a stateful workload; repeated hooks or migrations still need retry-safe behavior |
| `RemediateOnFailure` | Uses the configured install/upgrade remediation, including uninstall or rollback | Consider when a known-good release can safely be restored; inspect configured retries and last-failure handling |

Set strategy explicitly when defaults matter; controller versions and feature gates can change defaults. `strategy.retryInterval` belongs to `RetryOnFailure`; remediation retry counts describe a different mechanism. Exhausted retries are evidence to investigate the failure, not a reason to reset counters repeatedly.

Before changing CRD policy, verify chart ownership and compatibility with existing custom resources. `CreateReplace` can update CRDs but does not migrate stored objects for the application. Helm uninstall generally leaves chart CRDs behind; do not equate release rollback with CRD or data rollback.

## Drift ownership

Enable Helm drift correction according to the project's ownership model. For HPA-managed replicas, use a narrowly targeted `driftDetection.ignore` rule for `/spec/replicas` on the intended workload. Avoid a broad ignore that hides unrelated drift. An ignore rule controls drift correction; it does not remove the field from chart rendering during a Helm upgrade.

## Values and substitution watches

For stable-name ConfigMaps/Secrets referenced by `valuesFrom` or `postBuild.substituteFrom`, the label `reconcile.fluxcd.io/watch: Enabled` lets supported controllers react to changes before the next interval. Add it to the producing manifest or generator configuration in Git; preserve the existing controller watch configuration.

For generated Helm values ConfigMaps, keep name hashes and the custom name-reference transformer: a changed hash updates the HelmRelease spec already. The watch label is not a replacement for this wiring. Label updates to Secret resources belong in their SOPS/External Secrets workflow; reading their values is unnecessary.

Distinguish this controller reconciliation from application reloads: neither a watch label nor a successful Helm action guarantees a pod consumes changed runtime configuration. Follow [configuration reloads](configuration-reloads.md) for pod reload behavior.

Sources: [Flux agent knowledge](https://github.com/fluxcd/agent-skills/tree/25da0ed5bfdd1d8f779ef79c2c7e336781978d87/skills/gitops-knowledge) (Apache-2.0), independently summarized; semantics cross-checked with the official [Kustomization reference](https://fluxcd.io/flux/components/kustomize/kustomizations/) and [HelmRelease reference](https://fluxcd.io/flux/components/helm/helmreleases/). Upstream recommendations are conditional here to preserve workload-specific recovery and the selected chart source.
