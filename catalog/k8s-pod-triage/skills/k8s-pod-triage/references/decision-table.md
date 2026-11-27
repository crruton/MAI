# Pod state decision table

Evidence to collect first, then the usual root causes and where the fix goes. Desired-state fixes belong in MRs; explicitly authorized operational recovery follows the execution boundary in SKILL.md and [StatefulSet recovery](statefulset-recovery.md). Repository paths: `.helm/values-<env>.yaml` (CI push) or `clusters/<name>/apps/<app>/` (Flux).

## CrashLoopBackOff

Back-off state, not a cause. Read `lastState.terminated` for the real reason.

| lastState | Exit code | Meaning | Evidence | Fix |
|---|---|---|---|---|
| Error | 1, 2 | Application exited with error | `logs --previous`: stack trace, "missing env", "connection refused", "cannot open config" | Correct env var / ConfigMap key / dependency address in the manifest or values |
| Error | 126, 127 | Command not executable / not found | event or log: `exec: ... not found`, `permission denied` | Fix `command`/`args`; image entrypoint or file mode problem is an image fix |
| Error | 139 | SIGSEGV | log, core crash | Application bug; report to owners, do not mask with resources |
| OOMKilled | 137 | OOM; distinguish container limit from node pressure | `Reason: OOMKilled`, configured limit, node/cgroup evidence; sampled working set can miss the peak | Size request/limit from representative evidence (`k8s-rightsizing`); check leaks and runtime heap settings |
| Error | 137 without OOMKilled | SIGKILL; probe, node/runtime or other termination | Correlate probe/termination events and node/runtime evidence | Fix confirmed mechanism; do not infer a probe failure from exit code alone |
| Error | 143 | SIGTERM, graceful stop | pod was deleted/rolled | Usually not a fault |
| Completed | 0 | Container exits cleanly but restartPolicy=Always | log shows normal end | Wrong workload kind (should be Job) or process daemonizes |

Container that dies instantly with `readOnlyRootFilesystem: true`: log shows "read-only file system". Fix: add an `emptyDir` volume mount for the written path (`/tmp`, cache dir), keep the flag.

## ImagePullBackOff / ErrImagePull

Event text decides:

| Event message contains | Cause | Fix |
|---|---|---|
| `manifest unknown`, `not found` | tag or repository does not exist | Correct tag in manifest/values; verify the tag was pushed by CI |
| `unauthorized`, `pull access denied` | missing or wrong imagePullSecret | Add `imagePullSecrets` reference to an existing Secret (do not read it); registry credential rotation is a platform task |
| `no such host`, `i/o timeout`, `TLS`, `403 Forbidden` | registry/network/authentication boundary; inspect the complete error | Verify the failing endpoint from the target network. If the manifest points at a mirror unavailable to that environment, correct the registry in git with a verified equivalent digest and pull access. Otherwise diagnose DNS, TLS, network or credentials with the owner; do not change references blindly. |
| `exec format error` (runtime) | wrong CPU architecture | Image built for another arch; fix build |

## CreateContainerConfigError

Container cannot be built from the spec. The event names the missing object.

| Event | Cause | Fix |
|---|---|---|
| `configmap "X" not found` | ConfigMap absent or in another namespace | Add it to the repo or fix the name |
| `secret "X" not found` | Secret absent (not yet synced by SOPS/ExternalSecret?) | Check the Secret manifest or ExternalSecret exists in git and its Kustomization is Ready (`flux get ks`); do not create it by hand |
| `couldn't find key K in ConfigMap|Secret X` | key missing in the object | Compare the key in `env[].valueFrom.*KeyRef.key` with the keys in git manifest, or `kubectl describe secret X` (names and sizes only; skip if RBAC denies it). Fix the reference or add the key to the source manifest |
| `container has runAsNonRoot and image will run as root` | image runs as UID 0 | Set `runAsUser` to a numeric non-root UID, or fix the image |

Also check `optional: true` on the ref if the key is truly optional.

## Pending

`kubectl describe pod` Events, `FailedScheduling` message after `0/N nodes are available:`

| Fragment | Cause | Fix |
|---|---|---|
| `Insufficient cpu|memory` | requests exceed free allocatable | Lower requests to real usage (`k8s-rightsizing`), or capacity request to platform team |
| `node(s) had untolerated taint` | taint without toleration | Add toleration in values/manifest |
| `didn't match Pod's node affinity/selector` | nodeSelector/affinity mismatch | Fix selector or labels |
| `pod has unbound immediate PersistentVolumeClaims` | PVC Pending | `kubectl describe pvc`: StorageClass missing, no capacity, zone mismatch |
| `didn't match pod topology spread constraints` / anti-affinity | hard spread rules | Relax to `ScheduleAnyway` / preferred |
| `exceeded quota` (on ReplicaSet events) | ResourceQuota | Reduce requests or request quota change |

No `FailedScheduling` event and `Pending` with `ContainerCreating`: look at volume mount, CNI and image pull events.

## Probes failing

| Event | Meaning | Fix |
|---|---|---|
| `Readiness probe failed` | Pod Running but not Ready, no traffic | Wrong `path`/`port`, app slow to start, dependency down. Align probe with the app endpoint |
| `Liveness probe failed` then restart | kubelet kills the container (exit 137) | Add `startupProbe` for slow start, raise `timeoutSeconds`/`failureThreshold`; liveness must not check dependencies |
| `Startup probe failed` | start slower than `failureThreshold * periodSeconds` | Raise `failureThreshold` |
| `connection refused` in probe message | app listens on another port or localhost only | Bind 0.0.0.0, correct `containerPort` |
| `context deadline exceeded` | probe timeout, often CPU throttling | Check throttling ratio (`k8s-rightsizing`) |

## Evicted

`kubectl get pod`: `Status: Evicted`/`Failed`; `describe` message e.g. `The node was low on resource: memory|ephemeral-storage`.

- Memory pressure: pods using more than requests are evicted first. Set requests close to real usage (QoS).
- Ephemeral storage: container writing logs or temp files; add `resources.requests/limits.ephemeral-storage`, move data to a volume.
- Evicted pods stay as objects until garbage collected; the replacement pod is the one to inspect.

## Init container failures

`Init:Error`, `Init:CrashLoopBackOff`, `Init:0/1`: logs of the init container (`-c <name>`), not the main one. Typical: waiting for a dependency that is down, migration error, permission on a shared volume (`fsGroup`).

## Other states

| State | Look at |
|---|---|
| `Terminating` (stuck) | finalizers, preStop hook, `terminationGracePeriodSeconds`; report, do not force delete |
| `ContainerCreating` long | volume attach/mount events, CNI errors, image pull |
| `RunContainerError` | `describe` message: runtime error, bad `command`, bad mount |
| `Error` on Job pod | `backoffLimit`, logs of the failed pod |
| `Unknown` / node `NotReady` | node problem, platform team |

## Migration hook Job failed

Symptom: the release does not roll out; the CI deploy job (or HelmRelease) reports `pre-install/pre-upgrade hook failed`, `BackoffLimitExceeded` or `DeadlineExceeded`; the old Deployment pods keep running unchanged. The hook pod belongs to Job `<fullname>-<preHook.hookName>` (default `...-pre-hook`).

```bash
kubectl get job,pod -n <ns> | grep pre-hook
kubectl describe job <fullname>-pre-hook -n <ns>
kubectl logs job/<fullname>-pre-hook -n <ns> --tail=200
```

The Job is deleted on success and replaced on the next run (`hook-succeeded,before-hook-creation`), so a failed one remains for inspection until the next attempt.

| Evidence | Cause | Fix |
|---|---|---|
| Logs show migration error (SQL error, lock, `connection refused`) | Bad migration or unreachable DB | Fix the migration in the app repo, or the DB address in `preHook.env`; never rerun by hand against the DB |
| Hook Job stays `ContainerCreating` with a missing Secret | Rendered volume reference and Secret name do not match, or the Secret is absent | Compare names in the deployed chart version and declared secret source; fix the owning configuration/template |
| `DeadlineExceeded` with a running migration | `preHook.activeDeadlineSeconds` (300) too low | Raise it in values |
| `BackoffLimitExceeded` after one try | `preHook.backoffLimit` is 0 by default | Fix the cause; raise only for idempotent, transient failures |
| `ImagePullBackOff` / exec not found | `preHook.image` override wrong, or `command` not in the image | Fix `preHook.image.*` / `preHook.command` |
| Pod `Pending` / OOMKilled | `preHook.resources` empty or too small (separate from `resources`) | Set `preHook.resources` |

After the fix merges, CI push redeploys; under Flux the HelmRelease follows its configured reconciliation/remediation policy. Inspect actual rollback settings, release history and live resources rather than assuming the previous release is intact. Atomic rollback does not reverse migration side effects. Check whether a half-applied migration needs a human DB decision before retrying, and report that rather than guessing.
