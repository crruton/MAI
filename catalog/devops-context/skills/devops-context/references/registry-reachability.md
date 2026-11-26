# Registry reachability and mirror selection

Use for regional registry failures and private or public mirror selection. Scope the change explicitly: upstream registries, image namespaces, runtime versus chart values, and participating nodes/controllers. A request to change an existing mirror does not automatically include package repositories or every other registry.

## Probe the actual consumers

1. Inventory all rendered containers, init containers, hooks and dependency images, including operator-managed images that appear only when hardware is present. Separate container images from OCI Helm charts and Git chart sources; containerd mirrors do not redirect Argo CD's chart downloads.
2. Probe from each relevant execution environment. Laptop, CI runner, control-plane VM, GPU worker and repo-server can have different DNS, CA trust, routing and authorization. Corporate-network access on one does not imply it on another. Compare upstream and candidate mirror under the same conditions.
3. Follow the registry's normal authentication challenge with scoped anonymous or approved credentials. Validate TLS. Check the exact repository, tag/digest, target platform manifest and blobs. A successful `/v2/` response or manifest GET alone does not establish that a full image pull will work. Inspect node-runtime errors for redirected blob hosts and transport timeouts. Report cached-layer reuse when a pull did not exercise full network transfer.
4. Prefer a user-selected registry or a mirror with an identifiable operator and official mapping documentation. Preserve immutable digests when available. Matching hashes across independent mirrors establish content agreement, not publisher identity or signature verification. State which checks actually ran.

## Apply through the owner

For RKE2, configure its managed `registries.yaml` through the existing Ansible role and let its handlers restart the affected service. Mirror endpoints and repository rewrites are distinct: a mirror preserving the upstream namespace needs no added project prefix. Verify the generated containerd endpoint after restart; preserve upstream fallback unless policy or the user's requirement calls for disabling it.

Use chart image values when a per-image override is appropriate. Validate the exact subchart keys and every rendered workload; keep versions and digests stable during a mirror-only change. Existing workloads or cached images can mask an unusable mirror, so retain the explicit runtime pull evidence.

Treat 401/403, timeouts, TLS-chain failures and missing tags as different diagnoses. Use approved credentials or another reachable endpoint when appropriate; retain TLS verification and enforced network boundaries. Recheck reachability when the deployment network or mirror operator changes rather than promoting one successful lab probe into a global default.

Sources: [OCI distribution protocol](https://github.com/opencontainers/distribution-spec/blob/main/spec.md), [RKE2 registry mirrors and rewrites](https://docs.rke2.io/install/private_registry).
