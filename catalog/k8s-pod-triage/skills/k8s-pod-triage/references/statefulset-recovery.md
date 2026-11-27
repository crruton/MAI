# Corrected StatefulSet, stale unready pod

A failed rollout can leave an old unready pod blocking a later corrected template. Do not infer that the new image failed to pull until you inspect the image the pod actually uses.

## Evidence before recovery

- Compare desired template image/digest, generation and observedGeneration, update strategy/partition, currentRevision/updateRevision, pod controller-revision-hash, actual pod image/imageID and owner UID.
- Read pod events and current/previous logs. Distinguish an old ImagePullBackOff from a new image failure, CrashLoopBackOff or a storage/scheduling failure.
- Confirm the corrected desired state exists in the owning repository and controller. Check active CI/Flux operations so recovery does not race another update or rollback.
- Inspect PVC names, binding, owner references and StatefulSet retention. A claim reference alone is not a backup. Determine whether a database process ever started and whether its data/migrations need additional recovery planning.

Under ordered rolling updates, an unready pod may prevent replacement even after correcting the template. Kubernetes documents this under [forced rollback](https://kubernetes.io/docs/concepts/workloads/controllers/statefulset/#forced-rollback); the name does not mean force deletion is required.

## Scoped action

Prepare the exact context, namespace and stale pod, the corrected replacement image, expected service interruption and storage consequences. If normal pod deletion is necessary and no existing authorization covers it, ask once for that concrete recovery. A pipeline retry is a separate action: inspect its migrations/secrets/cleanup and obtain or reuse deployment-specific authorization before retrying it.

Immediately before an authorized operation, recheck pod identity and controller template. Stop if evidence changed materially. Use ordinary graceful deletion of the stale pod only; do not force-delete it, delete PVCs, scale unrelated workloads or broaden permissions. A stricter project read-only role still applies.

Verify a new pod UID, the intended image/revision, volume attachment, startup logs and readiness. Confirm retained PVC identity and application health. Do not equate pod deletion or a successful CI retry with recovery. If a different failure appears, diagnose it rather than repeating deletion. Record the action and validation in the owning incident/MR; generic skills must not acquire project pod names or node IPs.
