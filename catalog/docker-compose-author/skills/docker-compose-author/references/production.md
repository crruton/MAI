# Single-host production

Use for production configuration or readiness review. Sources checked on 2026-11-01. Compose can run production workloads on one host; it does not by itself provide host failover, guaranteed rolling updates or zero downtime. Identify the availability and recovery requirements before claiming the design meets them. [Docker production guidance](https://docs.docker.com/compose/how-tos/production/)

## Release and runtime

- Deploy the tested immutable image digest. Do not use `latest`, omitted tags, source bind mounts, development reload commands or debug tooling in the production model. Keep builds separate from release startup and verify the actual pull/build policy. Explicit version tags alone can still be mutable.
- Keep an inventory of image digests, configuration and compatible data/schema versions. Define startup order, migrations, readiness, traffic admission and stop/drain behavior. A one-shot migration may gate startup with `service_completed_successfully`; it still needs locking, failure handling and an explicit rerun policy.
- Choose a restart policy for the service and test host/daemon restart behavior. A health check reports health; it does not by itself make Docker restart an unhealthy container. Dependency `restart: true` concerns explicit Compose operations, not automatic propagation of runtime crashes. Require application reconnect behavior after dependency failure.
- Set measured CPU, memory and PID budgets, with host headroom and OOM behavior understood. Check actual limits on created containers. The optional `deploy` specification is implementation dependent: neither assume every field works locally nor declare the whole section ignored. Swarm scheduling/update settings do not create those guarantees in ordinary Compose. [Deploy specification](https://docs.docker.com/reference/compose-file/deploy/)
- Run as the supported non-root identity; test permissions, health probes and writable paths. Consider `read_only`, scoped `tmpfs`, dropped capabilities and `no-new-privileges` where compatible. Do not invent a numeric UID or disable required functionality without testing. Avoid privileged/host-network/host-PID modes and Docker socket access unless the actual service requires and justifies them.

## Secrets, network and logs

- Grant secrets per service and use the image/application's supported file interface. `_FILE` variables are a convention, not universal support. Local Compose file secrets are host bind mounts, not an encrypted managed secret store. Protect host storage, permissions, backups and provisioning. For file sources, do not rely on Compose `uid`/`gid`/`mode` remapping; verify effective access. [Compose secrets](https://docs.docker.com/compose/how-tos/use-secrets/), [file secret permissions](https://docs.docker.com/reference/compose-file/services/#secrets)
- Keep databases, caches, metrics and administrative ports private unless the deployment explicitly needs exposure. Define ingress/TLS ownership and test reachability from outside the host, including the actual Docker/firewall path. Networks must allow required dependencies; `internal: true` also affects outbound connectivity and is not a universal setting.
- Set bounded log retention or a supported external logging path. The default `json-file` driver has no rotation unless configured; `local` rotates by default. Choose delivery/backpressure behavior and disk budgets deliberately. Avoid logging credentials, request bodies or customer data by default. [Docker logging](https://docs.docker.com/engine/logging/configure/)

## Persistence and recovery

- Give each stateful service an explicit persistent data location. Preserve existing volume identities and ownership across upgrades. Local volumes survive container replacement but do not protect against host/disk loss. Bind mounts need an explicit host provisioning and permission contract. [Volume lifecycle](https://docs.docker.com/engine/storage/volumes/)
- Record backup ownership, retention, RPO/RTO and restore evidence. Use application-consistent database backups; copying a live data directory is not automatically a valid backup. Exercise recovery in an isolated environment before treating it as proven.
- Plan rollback with the previous available image/config and data compatibility. Reverting an image cannot reverse an incompatible migration. Document destructive or irreversible steps and recovery limits before executing them through the authorized release process.
- Report remaining operational gaps: monitoring/alerts, patching, disk pressure, certificate renewal, restart/recovery tests and host failure capacity. Do not silently solve an unmet availability requirement by switching the user's orchestrator.
