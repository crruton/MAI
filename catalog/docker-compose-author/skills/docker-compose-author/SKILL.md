---
name: docker-compose-author
description: Create, change or review Docker Compose configurations for local development and single-host production. Use for compose.yaml, docker-compose.yml, overrides, profiles, service wiring or deployment-readiness checks.
version: 1.0.0
owner: crruton
---

# Docker Compose authoring and review

Produce configuration and validation for the requested environment. In review mode, report findings without changing files unless asked. Preserve the application's deployment model; writing a production configuration does not itself authorize a rollout.

## Establish the deployment contract

Read the existing Compose files, Dockerfiles, entrypoints, application configuration and launch/deploy commands. Identify the ordered file stack, active profiles, interpolation inputs, project name, Docker context/host, Compose/Engine versions and target OS/architecture. Linux UID, capabilities, init and file-secret guidance requires Linux containers; verify platform support before applying it elsewhere. Reuse known constraints; ask for missing decisions that affect public exposure, durable data, secret delivery or availability.

Choose the relevant guidance: [local development](references/development.md), [single-host production](references/production.md), or both for a shared configuration. Keep development-only settings out of the production file stack. Use the Compose Specification; an obsolete top-level `version` does not pin behavior.

## Build or review the service model

1. **Services and connectivity.** Give each service one responsibility; worker children are valid. Use service DNS and container ports for internal connections, not host-published ports or fixed container IPs. Publish only required ingress; bind development tools to loopback. Avoid `container_name` unless required: it prevents scaling that service beyond one container.
2. **Configuration and secrets.** Distinguish `.env`/`--env-file` interpolation from service `env_file` injection. Require necessary inputs with `${VAR:?message}`; examples contain placeholders only. Grant runtime secrets only to consumers and verify their supported file interface. Build credentials use ephemeral BuildKit secret/SSH mounts, never Dockerfile `ARG`/`ENV` or credential-bearing build arguments. Treat rendered configuration and logs as potentially sensitive.
3. **Images.** Use maintained, compatible images with explicit versions; reject `latest` and omitted tags for release inputs, and pin tested digests for immutable deployment. For local builds, check `.dockerignore`, locked dependencies, stable dependency layers, multi-stage separation of build/runtime artifacts, and non-root execution. Combine related installation and cleanup in one `RUN`; deleting files in a later layer does not remove their earlier bytes. Keep only required runtime files and dependencies; do not collapse unrelated cached steps merely to reduce the layer count.
4. **Readiness and lifecycle.** Use workload-specific, bounded health checks whose executables exist in the image. `depends_on` alone does not mean ready; use `service_healthy` or `service_completed_successfully` where appropriate, plus application reconnect/retry behavior. Use exec-form commands; a setup wrapper must fail on errors and end in `exec "$@"`. Keep migrations under a deliberate single-owner/concurrency policy. Use `init: true` when signal forwarding/reaping requires it, avoiding a redundant image init. Test the stop signal and grace period; an init does not implement application draining.
5. **Isolation and state.** Verify the runtime UID and permissions of mounted data. Prefer non-root, scoped writable mounts and least privileges. Do not fix access with `chmod 777`, privileged mode or a host Docker socket. Separate disposable caches from persistent state. Preserve existing project/volume identities; a renamed project can appear to lose data by selecting new volumes.
6. **Validation.** Follow [configuration and runtime checks](references/validation.md). Validate every supported file/profile combination. Report static checks separately from runtime, recovery and release evidence.

Compose semantics: [service reference](https://docs.docker.com/reference/compose-file/services/), [startup dependencies](https://docs.docker.com/compose/how-tos/startup-order/), [interpolation](https://docs.docker.com/compose/how-tos/environment-variables/variable-interpolation/).

## Deliver

For authoring, provide the focused diff, exact dev/production commands with explicit file selection, required non-secret inputs, data locations and completed checks. For review, order findings by impact with file/service evidence and a concrete correction. State untested runtime assumptions and operational gaps; valid YAML alone does not establish production readiness. Do not add deployment, destructive resets, global pruning or volume deletion to a configuration task.
