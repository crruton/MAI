# Worker loss and runner resource pressure

`node down: Not properly terminated`, a crashed xdist worker, exit 137 or a green retry do not by themselves identify the cause. A killed child may leave the job container alive, with no Python traceback or container-level OOM status.

1. Compare matching jobs/commits across runners and time windows. Separate assertion failures, worker disappearance and timeouts. Count attempts and jobs separately; report denominators and missing traces.
2. Resolve job → runner ID → manager → physical host/node. Multiple registrations may share a machine; names and suffixes do not prove co-location. Check executor, architecture, workload fan-out and changes around onset.
3. Collect the job's cgroup baseline and final sample, preserving its original exit code. Determine the cgroup path/mount from `/proc/self/cgroup` and `/proc/self/mountinfo`; `/sys/fs/cgroup` need not be the job's group.
4. For cgroup v2 read available `memory.events`, `memory.events.local`, `memory.current`, `memory.peak`, `memory.max` and swap counters. Compare deltas; hierarchical counters include descendants. Missing/denied files mean unavailable, not zero. A local limit of `max` does not exclude an ancestor limit or host pressure.
5. Correlate UTC windows and job/container/cgroup/PID identifiers with host kernel OOM records and runtime events. A positive `oom_kill` delta confirms an OOM-killed group member, but not necessarily the pytest worker or a local-limit breach. No retained kernel log does not exclude OOM.
6. Check host RAM/swap, reserved memory, active jobs across all managers and build/helper/service limits. `concurrent` and per-runner `limit` constrain execution; `request_concurrency` controls polling for jobs. A configured maximum is not the observed overlap or a guaranteed per-job memory budget.

For cgroup v1 use available memory usage, peak, limit, fail-count and OOM-control counters. A fail-count alone is not a confirmed kill. Counter lifetimes must match the sampled job.

## Choose the fix from evidence

- Job exceeds its resource class: select a verified larger class, or reduce measured process fan-out without reducing coverage. Include service/helper overhead.
- Shared host is overcommitted: propose a capacity/concurrency change to its owner; moving tags alone may keep jobs on the same overloaded host.
- Memory grows steadily: investigate a leak; a higher limit only postpones failure.
- No OOM evidence: check cancellation, runner restarts, native crashes, PID limits, CPU/I/O contention and transport loss.

A container memory limit bounds consumption; it does not reserve host RAM or guarantee a useful pytest error. Preserve logs before a project-authorized retry, respect its budget and exclude deployment side effects. Do not quarantine a test solely because its worker vanished.

Request redacted host evidence, not full runner configs or environment dumps. If the container dies, `after_script` cannot collect its final sample: use host monitoring. Verify a fix over comparable workloads using worker-loss rate, OOM deltas, peak usage, queue and execution time; one passing retry is insufficient.

References: [GitLab runner configuration](https://docs.gitlab.com/runner/configuration/advanced-configuration/), [cgroup v2 memory interface](https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html), [xdist worker crashes](https://pytest-xdist.readthedocs.io/en/stable/crash.html).
