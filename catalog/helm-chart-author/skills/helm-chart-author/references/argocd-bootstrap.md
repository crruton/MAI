# Argo CD bootstrap checks

Use when preparing GitOps bootstrap, investigating manifest-generation failures or handing CRDs between a distribution and an application chart. Preserve the selected deployment owner and bootstrap exception; installing Argo CD does not transfer ownership of every prerequisite to it automatically.

## Render the exact inputs

Resolve chart and application versions separately. A Git release tag's source `Chart.yaml` can contain a version later replaced by the publication pipeline. Prefer the exact published chart when available; if using source templates, record the source revision and that limitation. Inspect `Chart.lock` and render dependency subcharts too, including hooks, init containers and every workload using a shared image override.

Render with the real release name, namespace, Kubernetes version and all injected values. When Ansible invokes Helm, check compatibility among the pinned Helm CLI and `kubernetes.core` collection: `helm template` succeeding does not prove the collection's `helm list` or install command is compatible. Check the collection's supported CLI flags before changing Helm or increasing timeouts.

## Keep bootstrap dependencies acyclic

Identify which stage provides working CNI, DNS, API access and the initial Argo CD installation. Repository access must work from repo-server, image pulls from nodes and controller API access from its own execution environment. Verify these paths before waiting for a root Application to converge.

Inspect the root's sync-wave dependency graph and Application health customization. A later wave missing entirely can be blocked by an unhealthy earlier child; diagnose that child instead of repeatedly applying the root or bypassing health gates.

## Resolve CRD ownership before rollout

Inventory distribution-packaged CRDs, Helm releases, Argo applications and upgrade-validation policies. Compare the exact CRD release and standard/experimental channel required by the chart. Matching kind names do not establish compatible schemas or a permitted upgrade.

Choose one continuing owner. Before an authorized handoff, inventory all affected custom-resource instances, conversion dependencies and data-retention consequences, then prepare the owning-source changes and recovery path. CRD deletion removes instances and is not a normal conflict-resolution step. Disabling a distribution's packaged chart can uninstall its CRDs; inspect that effect before applying the disable flag.

## Diagnose repository fetches

Separate DNS/TLS/authentication failures from Git transfer volume, source-generation time and controller RPC deadlines. Inspect the failing Git command and timing. For a public chart repository whose full-history fetch exceeds the deadline, check whether the installed Argo CD release supports a per-repository shallow-clone depth and whether the pinned revision can be fetched that way. Configure only the affected repository and verify a cold fetch completes within the existing deadline. Do not assume settings supported by a newer Argo CD release exist in the installed one.

## Verify convergence

A hard refresh requests reconciliation; it does not prove success or require a workload restart. Verify child sync/health, the expected source revisions, actual workload image identities and the public TLS path. Treat CRD `Established` state, controller readiness, PVC binding and a real workload request as separate evidence. An HTTPS 404 can prove routing and certificate validation while model serving remains untested.

Sources: [Argo CD repository scaling and shallow clones](https://argo-cd.readthedocs.io/en/stable/operator-manual/high_availability/), [sync waves](https://argo-cd.readthedocs.io/en/stable/user-guide/sync-waves/), [RKE2 packaged components](https://docs.rke2.io/install/packaged_components), [kubernetes.core release notes](https://github.com/ansible-collections/kubernetes.core/blob/main/CHANGELOG.rst).
