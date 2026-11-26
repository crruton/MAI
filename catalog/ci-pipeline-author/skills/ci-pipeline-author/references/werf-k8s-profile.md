# werf / Kubernetes profile

Use only for a project already on this stack or an explicitly requested new Kubernetes pipeline. A Compose VM project is not a migration candidate as a side effect of CI work. Common practices remain in the parent skill; runtime restrictions come from the environment actually installed.

- Build with werf/Buildah on unprivileged runners; no dind or host Docker socket in this profile. Read [build-and-deploy.md](build-and-deploy.md) for build reports, giterminism and deployment commands.
- Configure the project’s registry and namespace. Set `CONTAINER_REGISTRY`, `REGISTRY_PROJECT`, scoped `REGISTRY_USERNAME`/`REGISTRY_PASSWORD`, and an eligible `RUNNER_TAG`. The template uses public PyPI; override it only for jobs with access to a project proxy.
- Reuse job configuration with `extends` and approved includes; preserve the project’s component architecture.
- Use [the starter](../templates/gitlab-ci.yml) with matching [werf.yaml](../templates/werf.yaml), [giterminism config](../templates/werf-giterminism.yaml) and [Dockerfile](../templates/Dockerfile). Verify tool versions and supply the required project variables before use.
- Starter contract: MR verification/build; default branch build and manual production deployment; scheduled audits/cleanup. It intentionally creates no feature-branch-only or tag pipelines. Add those only with matching job rules and release semantics; the core skill does not claim the starter supports them.
- This starter preserves each default-branch release candidate with `on_new_commit: none`. Projects releasing from protected tags instead use their actual release ref and may keep main latest-only. `on_job_failure` is enabled only for MR verification here, which has no deployment jobs.
- Dependency scans default to relevant MR input changes plus scheduled audits; default-branch image scanning is a separate pre-release check. The MR image scan is conditional on relevant image/dependency inputs. Adapt paths when scripts or includes influence build inputs. Secret scanning examines the MR worktree; scheduled history audit is separate.
- Validate `werf config render`, and `werf render` for chart changes; build/publish/deploy through the authorized pipeline. Record which checks actually ran.

Before enabling schedules, separate security audits from destructive registry cleanup. Remove the starter cleanup job unless requested, or restrict it to a dedicated owner-approved cleanup schedule as described in [build-and-deploy.md](build-and-deploy.md).

Owner checklist: registry credential variables and scope, registry namespace, environment-scoped kubeconfig file variable, runner prerequisites and verified tags, release protections, scheduled audit owner/issue handling and separately approved cleanup scope/schedule. These are inputs for this stack, not requirements for every GitLab project.
