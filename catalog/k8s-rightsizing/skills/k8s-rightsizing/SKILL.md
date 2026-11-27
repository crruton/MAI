---
name: k8s-rightsizing
description: Size Kubernetes container CPU/memory requests and limits from historical usage, throttling, OOM evidence and VPA recommendations. Use for resource tuning or cost reviews; diagnose an actively failing pod with k8s-pod-triage first.
version: 1.0.0
owner: crruton
---

# Rightsizing

Establish the owning repository, target environment, execution context, change owner and authorized workflow from project instructions and configuration. Reuse known facts; ask only for missing information that changes the action.

Output: a table of current vs proposed requests/limits per container, with the evidence behind each number, and an MR changing the values or manifest in git. You never patch the cluster.

If a pod is crashing right now, run `k8s-pod-triage` first; a rightsizing change is the fix only when the evidence says resources are the cause.

## Execution boundary

Resource changes can evict or restart workloads and alter HPA behavior. Prepare the proposal; do not patch resources or enable automatic VPA updates to validate it.

## Procedure

### 1. Scope

Identify the workload and every affected container. Trace resource values from the owning manifest or chart inputs through the rendered workload; inspect the pinned chart's schema/templates instead of guessing key names. Compare declared and observed requests/limits, replicas and admission defaults. Explain drift or injected defaults before sizing a change.

For a project explicitly using the legacy shared `app` chart, read [that chart profile](references/shared-app-chart.md). Its paths and keys do not apply to other charts.

Done when each affected container maps to an owning file/key, effective current resources and replica count, or a specific unresolved discrepancy.

### 2. Check the observation window

Use at least 7 days and cover a complete workload cycle; weekly/biweekly/month-end work may require longer. A short window, recent version change or unobserved peak lowers confidence. Separate steady-state and rollout/load-test analysis, but retain representative startup, recovery and scheduled peaks when sizing memory and capacity (see Cleaning data in the reference).

### 3. Query

Queries with exact templates are in [references/promql.md](references/promql.md). Run them through the Prometheus/Grafana read tool. Collect per container (not per pod):

| Signal | Metric | Statistic |
|---|---|---|
| CPU usage | `rate(container_cpu_usage_seconds_total[5m])` | p95 and p99 over 7-14d (subquery), max |
| Memory | `container_memory_working_set_bytes` | max over 7-14d, p99 |
| Throttling | `container_cpu_cfs_throttled_periods_total / container_cpu_cfs_periods_total` | ratio over 7d, worst hour |
| OOM | `kube_pod_container_status_last_terminated_reason{reason="OOMKilled"}` | last-reason evidence; correlate with termination timestamp/events, not an event count |
| Restarts | `kube_pod_container_status_restarts_total` | increase over window |
| Current config | `kube_pod_container_resource_requests` / `_limits` | for the table |

Optional cross-check: VPA recommender in `Off` mode (see below).

### 4. Compute the proposal

Rules (rationale and edge cases in [references/policy.md](references/policy.md)):

- Memory request = max working set over the window x 1.2 (headroom 20%), rounded up to a sane step (Mi). Raise headroom to 30-50% for spiky or cache-heavy workloads.
- Set a memory limit above the credible peak with explicit headroom; choose the request against sustained/peak demand and the platform's overcommit policy. Request = limit is a conservative option when reserving the full budget is appropriate, not a universal requirement. Equal memory alone does not make a Pod Guaranteed; CPU and all container settings matter too.
- CPU request = p95 of usage x 1.1-1.2. Latency-critical services: p99.
- CPU limit: the default policy is to omit it when the namespace policy (LimitRange/Kyverno) allows, and to rely on request for fair share. If a limit is required, set it at 2-4x request and never below p99 x 1.5. Throttling ratio above 5% on a latency-sensitive service means the limit is too low or should be removed.
- Never size below credible OOM or throttling evidence. Scraping can miss the memory peak at a kill; the last observed working set is a lower bound. Correlate the limit, termination time and runtime/cgroup evidence, and investigate leaks rather than treating an OOM as proof of an exact required size.
- Replica count unchanged. Rightsizing changes per-container resources only.
- Cap the step: do not cut a request by more than 50% in one MR for a workload with less than 14 days of data.

### 5. Language/runtime caveats

- JVM: working set includes heap plus metaspace, threads and off-heap. Set heap relative to the container limit (`-XX:MaxRAMPercentage=70-75`), not the other way round. Memory usage grows to the max heap by design, so the max is not "waste".
- Go: set `GOMEMLIMIT` to about 90% of the memory limit so the GC reacts before the OOM killer.
- Node.js: `--max-old-space-size` below the limit.
- Page cache counts in `container_memory_working_set_bytes` only for active pages; do not use `container_memory_usage_bytes` (includes reclaimable cache).
- Startup spikes (JIT, cache warm-up): size memory for the spike, and cover CPU with a higher request or a `startupProbe` rather than a high steady-state limit.

### 6. Present the table

```
| Container | Resource | Current req/limit | Proposed req/limit | Evidence (window, stat, value) | Confidence |
|---|---|---|---|---|---|
| app/api | memory | 256Mi / 512Mi | 640Mi / 640Mi | illustrative: 14d max 512Mi, confirmed limit OOM; kill peak may be missed | medium; recheck under comparable load |
| app/api | cpu | 100m / 200m | 300m / none | 14d p95 240m, throttled 18% | high |
```

Every proposed number has a metric, window and statistic next to it. State the window dates and anything excluded.

### 7. MR

1. Edit only `resources` for the named containers (manifest or the single values key that owns them).
2. Validate: `helm template | kubeconform -strict -ignore-missing-schemas`, `kube-linter lint` (render the shared chart as in `helm-chart-author`), `flux diff kustomization <name> --path <dir>` under Flux. With CI push the merge deploys. Check requests x replicas fit the namespace ResourceQuota.
3. MR description: the table, the PromQL used, window, and rollback (revert the MR).

## VPA as a data source

If a VerticalPodAutoscaler exists with `updatePolicy.updateMode: "Off"`, read recommendations without any pod being touched:

```bash
kubectl get vpa -n <ns> <name> -o jsonpath='{.status.recommendation.containerRecommendations}'
```

Fields: `lowerBound`, `target`, `upperBound`, `uncappedTarget`. Treat `target` as a cross-check, not an answer; the recommender ignores your headroom policy and is weak on short windows. Adding a VPA object in `Off` mode is itself an MR. Do not propose `Auto`/`Recreate` for workloads managed by HPA on CPU/memory.

## Traps

- Per-pod sums hide per-container differences (sidecars). Aggregate by `container`, exclude `container=""` and `POD`.
- `rate(...[5m])` averages away short bursts; for p99 use a subquery or recording rule.
- HPA targets are percentages of requests: lowering CPU requests makes HPA scale out earlier. Mention HPA in the MR if present.
- Over-cutting right after an incident window: the peak you excluded as "a rollout" may be real load.
