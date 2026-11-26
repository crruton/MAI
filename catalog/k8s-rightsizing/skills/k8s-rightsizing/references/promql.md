# PromQL for rightsizing

Replace `<ns>`, `<workload-pod-regex>` (for example `api-.*`), and `<c>`. Always filter `container!="",container!="POD"`. Window `14d` below; use `7d` minimum. Subquery resolution `5m` keeps cost sane on 14 days.

## CPU usage (cores)

Per-pod rate, then quantile over time per container:

```promql
quantile_over_time(0.95,
  sum by (pod, container) (
    rate(container_cpu_usage_seconds_total{namespace="<ns>",pod=~"<workload-pod-regex>",container="<c>"}[5m])
  )[14d:5m]
)
```

Use `0.99` for p99, `max_over_time(...)` for max. The result is one series per pod; take the max across pods for the request (each replica gets the same request):

```promql
max(
  quantile_over_time(0.95,
    sum by (pod) (rate(container_cpu_usage_seconds_total{namespace="<ns>",pod=~"<workload-pod-regex>",container="<c>"}[5m]))[14d:5m]
  )
)
```

## Memory working set (bytes)

```promql
max(max_over_time(container_memory_working_set_bytes{namespace="<ns>",pod=~"<workload-pod-regex>",container="<c>"}[14d]))
```

p99 variant: `quantile_over_time(0.99, container_memory_working_set_bytes{...}[14d])`, then `max` across pods.

## CPU throttling ratio

```promql
sum by (pod) (rate(container_cpu_cfs_throttled_periods_total{namespace="<ns>",pod=~"<workload-pod-regex>",container="<c>"}[5m]))
/
sum by (pod) (rate(container_cpu_cfs_periods_total{namespace="<ns>",pod=~"<workload-pod-regex>",container="<c>"}[5m]))
```

Worst hour over a week: wrap in `max_over_time((...)[7d:1h])`. Guide: under 1% fine, 5% or more on a latency-sensitive service is a problem. Zero or no data usually means no CPU limit is set (CFS bandwidth stats stay at 0 without a quota); guard the division against 0/0 (NaN).

## OOM and restarts

```promql
max_over_time(kube_pod_container_status_last_terminated_reason{namespace="<ns>",pod=~"<workload-pod-regex>",container="<c>",reason="OOMKilled"}[14d])

increase(kube_pod_container_status_restarts_total{namespace="<ns>",pod=~"<workload-pod-regex>",container="<c>"}[14d])
```

`last_terminated_reason` is a gauge that can retain an OOM from before the observation window and does not count events. `restarts_total` counts all restarts, not OOMs specifically. Correlate last-termination timestamps, events and runtime telemetry to date OOMs; report limitations when only gauges remain. The memory max before a restart is a sampled lower bound, not necessarily the peak at kill time.

## Current requests and limits

```promql
kube_pod_container_resource_requests{namespace="<ns>",pod=~"<workload-pod-regex>",container="<c>",resource="memory"}
kube_pod_container_resource_limits{namespace="<ns>",pod=~"<workload-pod-regex>",container="<c>",resource="cpu"}
```

Requests-to-usage efficiency (over-provisioning view):

```promql
sum(rate(container_cpu_usage_seconds_total{namespace="<ns>",container!="",container!="POD"}[1h])) by (pod)
/ sum(kube_pod_container_resource_requests{namespace="<ns>",resource="cpu"}) by (pod)
```

## Cleaning data

- Rollouts: old/new ReplicaSets overlap and new pods spike on start. Correlate `kube_pod_created`, owner/revision metadata and deploy events; `changes(kube_pod_info[1h])` is not a reliable rollout clock because that info gauge is normally constant. Separate steady-state sub-ranges, but retain representative startup peaks for memory/capacity decisions.
- Restart loops: a crash-looping pod has low usage; exclude pods with restarts in the window.
- Load tests / incidents: exclude if documented; otherwise keep.
- Metric gaps (scrape failures) lower quantiles; check `count_over_time(...)` covers the window.
- Different replicas can carry different load (StatefulSet shards). Size to the busiest replica.
