# Speed from observed costs

Choose by measured impact, not by resemblance to a starter pipeline. Record completed and cancelled pipelines separately, with runner queue time and total runner-minutes as well as user-visible latency.

## Critical path and dependencies

Find the longest chain using actual start/finish times and `needs`; stages alone are not a schedule. Independent checks may start with `needs: []`. Remove an install/cache-warming stage only when its outputs are unnecessary or its cost exceeds the benefit. Preserve artifact edges and required gates; optional dependencies are only for intentionally conditional jobs.

## Cache and image cost

Read [cache-and-mirrors.md](cache-and-mirrors.md). Measure restore, install, archive and upload independently. A writer can cost more than it saves; a reader on an isolated slot may never see that writer's archive. Dynamic runner pools require sampling every relevant backend.

Compare image pull + package installation + job execution, including cold and warm hosts. A full image with required native tools can beat a slim image that installs them every run. Prefer evidence over image size alone. A host daemon layer cache, registry-backed cache and werf stage cache have different locality and export costs; preserve the existing backend until a measured comparison justifies migration.

## Parallelism and test selection

- Keep duration-weighted shard generation when it exists. Rebuild weights automatically; verify the union of shards equals real test collection, without unintended duplicates or omissions. Detect a single heavy file that bounds the critical path.
- Bound worker count by effective cgroup CPU/memory and service overhead, not host CPU count. Select a verified larger runner resource class when the workload does not fit; additional shards still consume finite fleet concurrency.
- `parallel: N` is only an execution mechanism. Equal test counts do not imply equal durations. Do not replace a measured sharder with equal-count splitting.
- Preserve already-tested tree reuse only when content, test inputs/toolchain, required checks and provenance match; a green commit with a different merge tree is insufficient.
- For coverage-map selection, rebuild maps automatically and measure misses in shadow mode before enabling skips. Stale/untrusted maps should fall back to the full suite.

## Avoid work that is no longer useful

Read [cancellation-and-retry.md](cancellation-and-retry.md) before changing auto-cancel. Main may intentionally be latest-only while production releases use protected tags. Preserve ref/source routing and scheduled audits. Reduce checkout/artifact scope only when history, merge-base and reports are not needed.

A mirror reduces network installation cost, not test duration. If fixed overhead is 2% of the shard, do not promise a large pipeline speedup from optimizing that overhead. Security scan scheduling follows the selected project policy; it is not a shortcut to make a benchmark faster.

## Measurement record

For each candidate: baseline pipeline/job IDs, source/ref, workload, runner class, warm/cold state, sample count, median/range where available, proposed change, latency and runner-minute impact, and validation of coverage/release behavior. Mark estimates and toy models explicitly. A template-conformance score does not establish quality on a different stack or prove a real speedup.
