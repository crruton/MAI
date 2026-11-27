---
name: ci-pipeline-author
description: Write or improve GitLab CI pipelines using measured bottlenecks, DAG dependencies, caching, runner selection and cancellation semantics. Use for pipeline authoring, CI speedups, rules, needs or cache changes; preserve the existing deployment stack and project policy.
version: 1.0.0
owner: crruton
---

# CI pipeline author

Output: a focused pipeline change, validation evidence and a measured comparison (or an explicitly unmeasured hypothesis). Establish the owning repository, target environment, execution context, change owner and authorized workflow from project instructions and configuration. Reuse known facts; ask only for missing information that changes the action. Use the project's branch, review and merge workflow. This skill does not authorize retries, merges or deployments.

## Execution boundary

Before pushing, merging, triggering or enabling a schedule, inspect resulting deploy, migration and cleanup jobs. Preparing YAML does not authorize running those effects.

## Discover before selecting a template

Read `.gitlab-ci.yml`, included files, CI documentation/ADRs and repository tests for pipeline behavior. Identify:

- GitLab version, permitted status tools, branch/merge owner and retry policy.
- Pipeline sources and release refs: MR, default branch, feature branches, tags and schedules. Distinguish latest-only development deployment from releases that must remain deployable.
- Build backend and deploy target: werf/Kubernetes, Docker host daemon/Compose VM, or another existing system. A host Docker socket is a distinct trust boundary, not dind; retain an explicitly established architecture during optimization and raise any security change separately.
- Runner tag expressions, architecture, resource classes, network reachability and actual cache backend. Keep existing default build-runner routing and dynamic test pools. Read [runners.md](references/runners.md); discover resource-class tags and eligible larger classes from the project.
- Existing duration-weighted sharding, coverage checks, test selection, already-tested tree reuse and security policy. Preserve stronger working mechanisms.

For an existing pipeline, change the measured bottleneck instead of replacing the pipeline with a starter. For a new Kubernetes pipeline using werf, read [werf-k8s-profile.md](references/werf-k8s-profile.md). Only that profile uses the bundled templates.

When changing Dockerfiles or build context, read [container build checks](references/container-builds.md) for image construction, runtime and secret checks. For Kubernetes deployments, also render manifests with the same value injection used by the deployment job.

For new delivery or changes to runtime/deployment behavior, read [delivery readiness](references/delivery-readiness.md) before implementation. Resolve consequential unknowns early and complete the applicable pre-merge checks before recommending merge. Keep performance-only changes scoped to their measured behavior.

## Procedure

1. **Measure the baseline.** Use supplied traces or one bounded history query through the project's permitted interface, never a polling loop. Record pipeline IDs, source/ref, runner/resource class, queue time, job execution, cache restore/archive, install time and critical path. Separate warm/cold cache and cancelled/completed pipelines. No traces means no measured speed claim.
2. **Choose one change by expected impact.** Use [speed.md](references/speed.md). Report both latency and aggregate runner-minutes: parallel jobs can shorten latency while consuming more capacity. Preserve coverage and release behavior.
3. **Model the DAG and workflow.** Use `needs` for actual dependencies and artifacts; independent checks can use `needs: []`. For every supported source/ref, verify which jobs exist and that required dependencies exist. For MR-based workflows, run feature checks only as MR pipelines and allow push pipelines only on the deployment/default branch. Check the first-push-then-open-MR sequence too: `CI_OPEN_MERGE_REQUESTS` suppression alone cannot prevent a second pipeline when the MR is opened after a branch pipeline has already started. Preserve explicitly required tag, schedule or other release sources. Read [cancellation-and-retry.md](references/cancellation-and-retry.md) before changing auto-cancel or retry. Do not force `on_new_commit: none` onto main when the project intentionally deploys only the latest dev state and releases from protected tags.
4. **Verify cache topology.** Follow [cache-and-mirrors.md](references/cache-and-mirrors.md). Use the established environment topology; when it is unknown or failures contradict it, distinguish shared storage from local/slot caches using current traces. Choose writers based on reachability and archive cost. Keep build outputs as artifacts; caches may miss.
5. **Keep configuration maintainable.** Prefer GitLab keywords to shell control flow; reuse meaningful job structures with `extends`/`default`/`!reference`. Preserve approved local/shared includes rather than migrating them incidentally. Pin release artifacts by digest or another immutable identity; use the project's update/pinning policy for tool images. Compare pull plus installation cost before choosing slim vs full images.
6. **Validate the change.** Run the project's pipeline wiring tests, script checks and CI lint for its GitLab version. Resolve inherited arrays and dynamic tags. Offline parsing is not server lint. Report unavailable validation. Retain negative and positive tests for selection/gates where present.
7. **Compare and deliver.** Report comparable before/after runs, sample sizes, cache state and queue conditions. If only a model or estimate exists, say so; do not claim a speedup. Include coverage/cancellation impact, rollback and any owner action. Use the repository's MR workflow; do not silently alter runner settings, protected variables or merge policy.

## Operational traps

- `extends` replaces arrays; a job's `rules` or `tags` can discard inherited safety/routing. Check the effective configuration, including `workflow:rules:variables`.
- An optional `needs` edge is for a deliberately absent job, not a way to bypass an existing required gate. Image scans and deployments must use the exact artifact that was built and tested.
- A latest-only dev branch and a protected production tag need different cancellation behavior. `interruptible: false` does not protect against every cancellation mechanism.
- Mirrors help only jobs that can reach them, and only the network fraction of the critical path. Do not add private proxy URLs globally when workflow rules route jobs across different networks.
- Define scanner coverage, severity thresholds, failure policy and suppression ownership; verify that a qualifying finding blocks the intended merge path and that scanner errors cannot pass as clean results. The default for new dependency scanning is relevant MR changes plus scheduled default-branch audits; preserve an existing stronger policy unless its owner authorizes changing it.

## GitLab CI instead of shell

| Written in bash | Use instead |
|---|---|
| `if [ "$CI_COMMIT_BRANCH" = main ]; then ... fi` | `rules: - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH` |
| `git diff --name-only ... \| grep` to skip work | `rules:changes` (with `compare_to`) |
| `for i in 1 2 3; do cmd && break; sleep 10; done` | `retry: {max: 2, when: [...]}`; flaky network: fix the cause |
| `timeout 600 cmd` around the whole job | `timeout: 10m` |
| Polling another job or pipeline | `needs` within a pipeline; a downstream trigger with `strategy: mirror` where supported (`depend` on older servers). `needs:project` fetches successful artifacts and does not wait for an in-flight pipeline |
| Writing a small set of non-secret values for the next job | `artifacts:reports:dotenv` only within the instance limits; full werf reports use regular file artifacts. Artifact access/retention still apply |
| Parsing test output for presentation | JUnit/coverage reports; the test command must still return failure, and coverage thresholds need explicit enforcement |
| `flock`/checks that no other deploy runs | `resource_group` |
| `read -p "deploy?"`, approval scripts | `when: manual` + protected environment with approvals |
| `echo "$KUBECONFIG_B64" \| base64 -d > ~/.kube/config` | file-type CI/CD variable |
| Independent post-job cleanup/reporting | `after_script` (separate shell); keep a trap when same-process state/exit handling is required |
| One job looping over environments/versions | `parallel:matrix` or one `extends` per environment |
| Installing tools with curl in every job | a pinned image that has the tool |
| Cancelling old pipelines by API or a "newer commit?" check in script | `workflow:auto_cancel:on_new_commit: interruptible` + `interruptible: true` |
| Stopping other jobs after a final blocking failure | `workflow:auto_cancel:on_job_failure: all`, after checking cancellation consequences |

Keep genuine shell logic in the repository’s existing script directory, lint it and verify its exit behavior. Do not replace a tested helper with a shell one-liner just to shorten YAML.

## DRY mechanisms inside one repo

| Need | Use |
|---|---|
| Same keys in several jobs | hidden job `.base` + `extends` (hashes merge, arrays replace) |
| Splice one array (script, rules) into another job | `!reference [.base, script]` |
| Defaults for all jobs (tags, image, retry, interruptible) | `default:` |
| Values used by many jobs | global `variables:` |
| Same job for several environments or versions | `extends` of one hidden deploy job, or `parallel:matrix` |
| Split a big file | `include: local` |
| Whether a pipeline exists | `workflow:rules`; whether a job exists: job `rules` |
