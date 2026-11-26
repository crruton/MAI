---
name: devops-context
description: Identify the target environment, deployment owner and operational constraints before CI, Kubernetes, database or backup work. Use when the runtime, network access or change workflow is unclear.
version: 1.0.0
owner: crruton
---

# Establish the environment

Read the repository's instructions, configuration and deployment definitions. Reuse known facts; ask only for missing information that changes the action.

- **Target:** project, environment, affected job/release/database, incident window and timezone.
- **Owner:** repository/file controlling the resource, branch/review workflow, release owner and authorized actions.
- **Runtime:** runner executor/architecture/resource class; cluster/context/namespace; database version and primary/standby role.
- **Connectivity:** registry, package proxy, cache and deployment endpoint reachable from the actual execution environment, including VPN routing. A GitLab hostname does not establish runner connectivity.
- **Constraints:** available tools/access, SLO or RPO/RTO, maintenance window and required validation.

Configuration shows intent; current state and traces show behavior. Resolve contradictions before choosing a fix. Separate observations, hypotheses and confirmed causes. Compare failing and successful samples under comparable conditions.

## Execution boundary

Establish which local files, development and staging resources are disposable from ownership and task scope; environment names and access rights alone do not establish this.

## Change the owning source

| Deployment model | Change location |
|---|---|
| App CI / werf | Pipeline, build configuration and app chart |
| Docker / Compose on VMs | Build scripts, Compose/deploy configuration and release workflow |
| Shared Helm chart | App values for configuration; chart repository for template defects |
| Flux | The HelmRelease/Kustomization's actual source path |
| Managed database | Provider/module configuration; table/index changes remain migrations |
| Self-hosted database or runner | Its configuration management repository |

Preserve the project's established workflow and enforced access boundaries. Use installed wrappers when required; otherwise use the project's approved tools. Report unavailable checks instead of claiming they passed. Keep investigating independent questions while waiting for missing evidence.

For image pull failures, regional registry restrictions or mirror selection, read [registry reachability](references/registry-reachability.md).

For projects on a corporate network or VPN, also read the organization’s network profile from its private skills catalog, if one exists. It does not apply to unrelated environments.

## Completion

Return the target, owning source, runtime, connectivity, authorized workflow and required checks. For each unknown, state whether it blocks the next action and what observation would resolve it. Context discovery is complete when the next scoped action has an identified owner and execution boundary, or the exact blocker is recorded.
