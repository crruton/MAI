# Delivery readiness before merge

Use for a new delivery pipeline or changes to deployment, runtime images, credentials, ingress, storage or release behavior. A cache-only change does not require a new infrastructure audit. Scope checks to changed behavior and its dependencies.

## Resolve consequential unknowns early

Read repository instructions, current CI/chart configuration, applicable infrastructure profiles and authorized read-only cluster/runner state first. Keep a short record of fact, source/date and unresolved consequence. A runner tag proves scheduling eligibility, not rootless builder support or target-cluster reachability.

Ask before choosing an implementation when the answer is missing or contradictory:

| Unknown | Focused question / evidence to obtain |
|---|---|
| Release behavior | Which refs deploy automatically, to which environment, and who merges? Reuse an already stated choice. |
| Runner capability | Which eligible runner supports this builder, architecture and resources? Prefer configuration or a bounded disposable build over a tag name. |
| Network boundaries | Which registries and model/package endpoints are reachable from the runner and from cluster nodes? Keep these as separate paths. |
| Ingress | Inspect controller namespace, CNI, hostNetwork, load-balancer protocol and TLS ownership; ask the owner only for what cannot be observed. |
| Stateful dependencies | External or in-chart? Which StorageClass, capacity and retention are intended? If resources do not fit, present measured alternatives instead of silently reducing requests. |
| Credentials | Who provisions each credential, through which approved source, with what scope and expiry? Request variable names/source, never secrets pasted into chat. |
| First runtime test | Is there an authorized staging/disposable target, or will main perform the first deployment? What bounded user journey and test account establish success? |

Bundle related questions early; state which decision each answer changes. Continue independent implementation while waiting. Do not guess an unresolved deployment-critical value or treat silence as consent. Do not repeatedly ask for facts or permissions already supplied. Keep project names, node IPs and secrets out of generic skills; propose shared profile updates only for reusable infrastructure facts.

## Evidence required before recommending merge

1. Validate the effective CI configuration with the target GitLab version. Exercise supported sources/refs and the first push -> open MR -> next push sequence, including missing protected variables in MR jobs. Check that dependencies and gates exist without duplicate pipelines or accidental deployments.
2. Build/test the relevant artifacts and exercise changed job commands in the selected CI image/runtime. Validate real producer/consumer artifacts: expected keys, limits, file paths and failure behavior. A successful build followed by failed artifact upload is a failed build job.
3. Render the actual release namespace, environment values, image injection and Kubernetes version. Inspect all subcharts/init containers. Check runtime identity, writable paths, probes, scheduling requests, PVC retention, migrations and rollback limits. Inspect live drift before proposing a recovery.
4. Establish registry/network prerequisites from the target network, using existing evidence or an explicitly authorized disposable probe. A laptop pull, office runner pull, successful lint or server-side dry run does not prove runtime connectivity. Dry runs may exercise admission but do not start containers.
5. Where a staging target is available and authorized, test startup and affected dependency paths before merge. For ingress/policy changes, cover different nodes and intended denied paths, not only local-node health probes. Account for hostNetwork and PROXY protocol.
6. Review the MR's current commit and its relevant checks. Fix observed failures before recommending merge. Identify any unperformed check with its reason, impact and exact execution plan; do not hide it behind a green badge.

If runtime validation is impossible before the first deployment, finish all independent checks and make the remaining gap explicit **before** recommending merge. Agree the first-deploy target, checks, stopping conditions and recovery limits with the owner. Do not deploy production merely to obtain pre-merge evidence, expose protected secrets to MR jobs, or imply that owner acceptance proves a missing check passed. A completed MR can be ready for review with a documented first-deploy plan; Draft means implementation or required pre-merge validation is still in progress.

## Verification after an authorized merge/deploy

Follow the same artifact through build report, scan and deployed image IDs. Inspect actual pods as well as their controllers; readiness does not establish ingress reachability or queue progress. Verify TLS and application responses through the real load balancer, then the agreed bounded user journey (for example login and one completed background task). Define test data, cost and cleanup before executing a state-changing smoke test.

Report the reached level accurately: configuration validated; artifacts tested; deployment ready; external route verified; user journey verified. Do not call the whole service verified if the last requested level remains untested. A newly discovered cause needs diagnosis before another retry; do not keep retrying a main pipeline without a reason and authorized scope.
