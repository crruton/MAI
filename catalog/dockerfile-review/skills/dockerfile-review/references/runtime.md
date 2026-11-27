# PID 1, startup and health

Use for entrypoint wrappers, startup actions, subprocesses or shutdown problems. This section describes Linux containers with a private PID namespace; host/shared PID modes and Windows have different behavior.

## One service, a deliberate process tree

Keep one service responsibility per container. A service can legitimately have worker processes; do not interpret this as a ban on children. Decide whether the application or a small init owns PID 1 and manages the process tree. [Docker process guidance](https://docs.docker.com/engine/containers/multi-service_container/)

Use JSON-array forms for `ENTRYPOINT` and `CMD`. When setup is required, make the wrapper executable, ensure its interpreter exists in the final image, and replace the shell with the requested command:

```sh
#!/bin/sh
set -eu

/app/prestart
exec "$@"
```

```dockerfile
ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["/app/server", "--foreground"]
```

`/app/prestart` represents an existing, bounded setup action, not a requirement to invent one. A failure must prevent server startup. If it runs migrations, preserve the project's release ownership, concurrency/locking and retry semantics; do not automatically run a schema migration in every replica. During setup the shell has not yet been replaced: test cancellation there too, or use a separate lifecycle job/init process with appropriate forwarding. The wrapper requires a shell and cannot be copied unchanged into a shell-free image.

## Signals and init

Linux namespace PID 1 has special signal rules. Other processes in the namespace can send it only signals for which it installed handlers, even when privileged. SIGKILL/SIGSTOP sent from an ancestor PID namespace are forcibly delivered. This restriction on delivery is different from a handler ignoring a signal: SIGKILL and SIGSTOP cannot be caught, blocked or ignored. `exec` removes an intervening shell but does not install handlers in the application. [PID namespaces](https://man7.org/linux/man-pages/man7/pid_namespaces.7.html), [signals](https://man7.org/linux/man-pages/man7/signal.7.html)

When the application does not correctly forward signals or reap orphaned children, consider Docker `--init`, Compose `init: true`, or an explicitly installed Tini. Compose's init implementation is platform-specific. [Compose init](https://docs.docker.com/reference/compose-file/services/#init)

For an image that already installs Tini at `/sbin/tini`, an entrypoint can be `ENTRYPOINT ["/sbin/tini", "--", "/app/entrypoint.sh"]`. Verify the actual binary path, architecture and supply source. Tini forwards signals and reaps children; by default it signals its immediate child. Use `-g` only when the workload needs process-group forwarding. Avoid redundant nested init processes. An init does not supply application-specific draining or transaction cleanup. [Tini behavior](https://github.com/krallin/tini#process-group-killing)

Test the intended stop signal and grace period, server exit status, completion of in-flight work and child cleanup. A forced kill after the grace period is not successful graceful shutdown.

## Health checks

Define a workload-appropriate health signal and verify it in the final image. Bound probe execution, allow startup time and choose meaningful failure thresholds. Confirm the probe executable, user and permissions; do not install a full toolchain merely to run a probe. Avoid fragile shell/curl probes in images without those executables. A worker need not expose HTTP just for a check.

Match the consuming runtime: Docker `HEALTHCHECK`/Compose health checks and Kubernetes startup/readiness/liveness probes are separate configurations. Do not claim image health configuration automatically supplies Kubernetes probes. [Docker health checks](https://docs.docker.com/reference/dockerfile/#healthcheck), [Compose healthcheck](https://docs.docker.com/reference/compose-file/services/#healthcheck)
