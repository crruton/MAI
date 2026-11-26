# Validate the effective deployment

Use for authoring and review. Run static checks first, then bounded runtime checks only on the intended authorized host/project. Sources checked on 2026-11-01.

## Render the actual inputs

Record CLI versions, file order, project directory/name, profiles and interpolation sources. Use explicit `-f` arguments for each supported environment. For example, adapt these filenames to the repository:

```bash
docker compose --env-file .env.production -f compose.yaml -f compose.production.yaml config --quiet
```

`config --quiet` checks the model without printing it. Inspect `config --format json` privately when needed to verify effective images, ports, mounts, permissions, health checks, secrets and resources. Rendered output and `config --environment` can disclose credentials; do not attach them unredacted. Use synthetic values for fixtures. A successful render does not verify image contents, secret permissions, host capacity or application behavior. [Config CLI](https://docs.docker.com/reference/cli/docker/compose/config/)

Check merge results, not just each YAML file: many sequences append, ports use an IP/target/published/protocol uniqueness key, and mounts merge by target. `ports: []` does not erase inherited published ports. Commands, entrypoints and `healthcheck.test` replace rather than append. Use supported `!reset`/`!override` tags only after checking the minimum deployed Compose version, or move development-only settings out of the base. Relative paths in ordinary multi-file merges use the base file directory. [Merge rules](https://docs.docker.com/reference/compose-file/merge/), [multiple files](https://docs.docker.com/compose/how-tos/multiple-compose-files/merge/)

Run existing static analysis with matching rules. KICS supports DockerCompose (`kics scan --path compose.yaml --type DockerCompose`); confirm CLI/rule versions and scan the relevant overrides too. Parser/rule omissions are coverage gaps. Hadolint checks Dockerfiles, not Compose YAML. Semgrep needs actual applicable YAML rules; do not claim generic rules cover Compose semantics or merged values. Keep suppressions narrow and justified. [KICS platforms](https://docs.kics.io/latest/platforms/), [KICS commands](https://docs.kics.io/latest/commands/)

## Exercise the selected configuration

For an authorized disposable project, use a unique project name, bounded startup such as `up --wait --wait-timeout 120` where supported, and a separate overall execution deadline. Choose the timeout from the workload's startup budget; services without health checks can be merely running when wait succeeds. Inspect build/entrypoint scripts before executing them. Record created resource IDs and inspect exit codes, health and logs without exposing secrets. Killing the CLI does not guarantee daemon-side work stopped. Clean up only resources created for this check, preserving pre-existing/external volumes. [Compose up](https://docs.docker.com/reference/cli/docker/compose/up/)

Test the behavior affected by the change:

- Development: source reload, dependency rebuild, host permissions, isolated concurrent checkouts and restart with existing data.
- Readiness: cold startup, dependency unavailable/recovery, failed migration preventing startup and actual client connectivity.
- Lifecycle: application PID/process tree, intended stop signal, draining within the grace period and child cleanup. Shell wrappers must end with `exec`; optional init forwarding/reaping does not add application handlers. SIGKILL cannot be caught, blocked or ignored.
- Production: effective published ports, runtime UID/write paths, secret file access, enforced resource/log limits and persistent state across container replacement.
- Recovery: representative backup restore and compatible rollback in isolated capacity, with measured recovery time where required.

Report the exact configuration checked and distinguish render/lint, runtime smoke, failure/recovery and target-host evidence. Missing runtime access leaves a configuration proposal with explicit unverified checks, not a proven production deployment.
