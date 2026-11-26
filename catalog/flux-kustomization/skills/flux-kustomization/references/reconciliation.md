# Trace a Flux reconciliation failure

Use this procedure for stale revisions, failed sources, Kustomizations or HelmReleases. Keep inspection read-only and collect only the failing object's dependency chain. An installation-wide health check is useful for widespread failures, not mandatory for every values error.

## Establish the chain

1. Confirm the intended kube context, controller versions and served CRD versions. Inspect controller Deployments; use FluxInstance/FluxReport only when Flux Operator is installed. Recheck installation identity after changing context.
2. Trace the workload through its Deployment/StatefulSet/Job to the managing HelmRelease or Kustomization and its source. With an available Flux MCP, `trace_kubernetes_resource` can expose this chain; otherwise use owner references, Flux inventory, labels and `flux tree`. Labels are leads, not proof of current ownership.
3. Record namespace/name, generation, observed generation, suspension, condition reason/message and timestamps at each failing link. Compare source artifact revision with the applier's attempted/applied revision. A previously Ready condition does not establish that the newest generation has reconciled.
4. Follow the first failed prerequisite upstream before changing the downstream workload. If the source is Ready but the consumer cannot fetch its artifact, inspect source-controller storage/service reachability and controller network policies.

Use projected status fields rather than dumping whole objects. For an available MCP, inspect its tool schema before calling it; prefer resource tracing, bounded events and logs. Tool availability does not expand the skill's execution boundary or permit Secret reads.

## Pick the failing stage

| Stage | Evidence to inspect | Decision |
| --- | --- | --- |
| Git source | Selected branch/tag/commit, artifact revision, fetch conditions, ignore rules | Separate wrong revision, missing files and authentication/network failures; the local checkout may contain files excluded from the artifact |
| OCI source | Selected tag/digest, verification conditions, layer media type | Distinguish unavailable artifact, signature failure and wrong layer selection; retain verification |
| HelmChart | Referenced source readiness, selected chart/version, packaging events | Repair source or packaging before release values; for vendored charts check artifact inclusion and Chart.yaml version |
| Kustomization build/apply | Source path, patch target, substitution references, schema/admission errors | Reproduce the exact overlay; distinguish a missing CRD from malformed custom-resource fields |
| Dependency | Dependency conditions, suspension, readiness checks and dependency cycles | Fix the prerequisite; an arbitrary timeout increase cannot resolve a cycle |
| HelmRelease | Ready/Released/Remediated conditions, history, attempted revision, chart source, values reference names/keys | Distinguish rendering, hook, rollout and exhausted-remediation failures before choosing a fix |
| Workload health | Inventory, owner events, current and previous container logs | Continue with pod triage for the failing workload; applied manifests alone do not prove rollout success |

For values/substitution/authentication errors, inspect reference names, namespaces and non-sensitive configuration. Secret existence and key-shape checks require an approved metadata-only surface; otherwise report them as unverified. Do not fetch Secret objects on the assumption that a client masks them.

## Optional controllers

Read only the branch present in the installation:

- **ResourceSet:** inspect input-provider readiness, template inputs, dependencies and generated inventory. Fix the owning template or input rather than a generated child. A Ready ResourceSet is not proof that every generated workload is healthy.
- **Image automation:** follow ImageRepository scan → ImagePolicy selection → ImageUpdateAutomation update/push → watched Git source. Compare selected image with Git, update path, policy markers and push branch. Verify write-credential ownership without retrieving credentials or making a test push.
- **Notifications:** inspect Alert event selectors/severity and Provider configuration, then notification-controller delivery logs. Do not assume every served Provider/Alert API exposes Ready conditions. For Receiver problems, separate ingress reachability, signature validation and the referenced resources; do not send a test webhook without task authorization.

## Completion evidence

Report the first failed link, supporting condition/event/log timestamps, intended versus observed revision, the owning file and the smallest supported fix. After the authorized delivery workflow runs, verify the expected revision, current-generation readiness and affected workload health. A successful render or an opened MR proves neither deployment nor recovery. If live access is unavailable, state which checks remain open.

Source: independently summarized from [Flux cluster debugging](https://github.com/fluxcd/agent-skills/tree/25da0ed5bfdd1d8f779ef79c2c7e336781978d87/skills/gitops-cluster-debug) (Apache-2.0). The local read-only and Secret-access rules take precedence over upstream mutation examples.
