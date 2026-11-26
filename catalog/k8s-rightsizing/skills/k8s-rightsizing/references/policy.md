# Sizing policy and rationale

## Memory

- Memory pressure can lead to cgroup OOM or node eviction. Choose limits from credible peaks and headroom; reserving the whole limit as the request is a conservative capacity choice, not a guarantee against OOM or a universal sizing rule.
- Headroom default 20% over the window max; 30-50% for caches, in-memory queues, workloads whose input size varies, or when the window is short.
- A limit above request permits bursting; justify the gap against startup/load behavior and node headroom. The scheduler places by request, so aggregate bursts can push a node into eviction. Equal memory alone does not set QoS: evaluate the full CPU/memory configuration for every container and any supported pod-level resources.
- Raising a memory limit does not fix a leak: usage keeps climbing to the new limit. Signal: working set grows monotonically between restarts. Report as an application bug and size only to buy time.

## CPU

- CPU is compressible: excess demand is throttled, not killed.
- Requests set the guaranteed share and drive scheduling and HPA percentages. Size them from p95 (p99 for latency-critical).
- Limits cause CFS throttling even when the node has idle CPU. Two defensible policies:
  1. No CPU limit (preferred where allowed): a pod bursts into idle CPU, noisy neighbors are contained by request-based shares. Requires accurate requests and node-level monitoring. If the namespace has a LimitRange default limit or a Kyverno rule requiring limits, follow it.
  2. Keep a limit: predictable cost and isolation for multi-tenant clusters or batch jobs. Set at 2-4x request; verify throttling ratio stays under 5%.
- Check the platform's policy (LimitRange, Kyverno, repo conventions) before choosing; do not remove limits that policy requires.
- For container-level resource configuration, all containers need positive equal requests/limits for both CPU and memory for Guaranteed QoS. Omitting a CPU limit generally makes the pod Burstable; evaluate the platform's policy and any pod-level resource configuration. See [Kubernetes QoS criteria](https://kubernetes.io/docs/concepts/workloads/pods/pod-qos/).

## Minimum observation

- 7 days minimum, 14 days when load is weekly or has biweekly jobs. Include at least one full business cycle.
- New service (< 7 days of data): propose from load test or VPA, label confidence low, and recheck after the window.
- After a code release that changes memory behavior, restart the clock.

## Anti-patterns

- Copying the same request across all services.
- Request far below usage: the node overcommits, neighbors suffer, evictions follow.
- Request far above usage: wasted capacity and scheduling failures (`Insufficient cpu`).
- Sizing from `kubectl top` snapshots.
- Changing replicas and resources in one MR: results cannot be attributed.

## Quotas and autoscaling checks before the MR

- `kubectl describe resourcequota -n <ns>`: new requests x replicas (plus surge during rollout) must fit.
- HPA: `kubectl get hpa -n <ns>`. CPU-based HPA utilization is relative to requests; changing requests changes scaling behavior.
- PDB and rollout strategy: higher requests with `maxSurge` need free capacity.
