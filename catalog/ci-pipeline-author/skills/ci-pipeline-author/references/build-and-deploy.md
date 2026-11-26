# Build and deploy with werf / Buildah

This reference is only for the selected werf/Kubernetes profile. It does not prescribe migration of existing Docker/Compose or other deployment stacks.

## Why werf with the Buildah backend

- No Docker daemon and no `docker:dind`, so the runner pod runs without `privileged: true`.
- werf stores image stages in `WERF_REPO` and reuses them on every runner: an unchanged layer is not rebuilt and not re-uploaded. This is the layer cache; do not cache images through the GitLab cache.
- One tool builds, tags by content, deploys (`werf converge`) and cleans the registry by what is deployed (`werf cleanup`).

## Build job

```yaml
.werf:
  image: registry.werf.io/werf/werf:2.81.4      # exact version; read the current one before pinning
  variables:
    WERF_BUILDAH_MODE: auto
  before_script:
    - echo "$REGISTRY_PASSWORD" | werf cr login --username "$REGISTRY_USERNAME" --password-stdin "$CONTAINER_REGISTRY"

build:
  extends: .werf
  stage: build
  script:
    - werf build --save-build-report --build-report-path werf-build.env
  artifacts:
    expire_in: 7 days
    paths: [werf-build.env]
```

- Set `CONTAINER_REGISTRY`, `REGISTRY_PROJECT`, `REGISTRY_USERNAME` and `REGISTRY_PASSWORD` from the project’s registry configuration. Use scoped CI credentials and `WERF_REPO: $CONTAINER_REGISTRY/$REGISTRY_PROJECT/$CI_PROJECT_NAME`.
- Password via `--password-stdin`, never as an argument (visible in the process list).
- `<IMAGE>` in the report is the werf image name uppercased, `-./+` replaced with `_` (`app` -> `WERF_APP_DOCKER_IMAGE_NAME`).
- Preserve the complete build report as a regular file artifact, not `artifacts:reports:dotenv`. GitLab limits dotenv variable count and size; a multi-image werf report can exceed those limits after the images have already built and pushed successfully. The report contains image metadata, not a dump of job environment variables.
- Scanner jobs must read the required image references from the downloaded report as data, validating missing/duplicate entries and the expected registry/repository before passing registry credentials. Do not `source` or `eval` the report. A small, explicitly selected dotenv report is an alternative only after checking the target instance limits. Never publish credentials or a full environment dump as artifacts.
- Deploy with `--use-build-report --build-report-path werf-build.env` and `needs: [build, image-scan]` so it consumes the same build artifact without depending on dotenv inheritance.
- Do not set `WERF_BUILDAH_STORAGE_DRIVER: vfs`: werf documents vfs as requiring a privileged container.

## Build arguments and mirrors

`werf.yaml` (giterminism forbids reading the environment unless allowed):

```yaml
project: app
configVersion: 1
---
image: app
dockerfile: Dockerfile
args:
  PIP_INDEX_URL: {{ env "PIP_INDEX_URL" "https://pypi.org/simple" | quote }}
```

`werf-giterminism.yaml`:

```yaml
giterminismConfigVersion: 1
config:
  goTemplateRendering:
    allowEnvVariables:
      - PIP_INDEX_URL
```

Dockerfile keeps the public default: `ARG PIP_INDEX_URL=https://pypi.org/simple`. This argument is only for credential-free URLs. A job with verified proxy connectivity can override the index; other jobs retain the public default. For authenticated indexes, use the builder's ephemeral secret mechanism described in [build secrets](build-secrets.md), never a URL containing credentials in this argument. Check with `werf config render` (with and without the non-secret variable).

## Runner prerequisites (platform, not the agent)

Buildah in an unprivileged pod needs: user namespaces allowed on the node (Ubuntu 24.04: `kernel.apparmor_restrict_unprivileged_userns=0`), rootless OverlayFS in the kernel or `/dev/fuse` for fuse-overlayfs, and an AppArmor/seccomp profile that permits `unshare` and mounts in the build container. No `privileged`, no host Docker socket. A build failing with `newuidmap`/`unshare`/`operation not permitted` is a runner problem: report it, do not switch to dind.

## Plain buildah (images not deployed by werf)

Libraries, base images, tools pushed to the configured registry and consumed elsewhere:

```yaml
image-build:
  image: quay.io/buildah/stable:v1.43.5
  variables:
    STORAGE_DRIVER: overlay
    BUILDAH_ISOLATION: chroot
  script:
    - echo "$REGISTRY_PASSWORD" | buildah login --username "$REGISTRY_USERNAME" --password-stdin "$CONTAINER_REGISTRY"
    - buildah build --layers
        --cache-from $CONTAINER_REGISTRY/$REGISTRY_PROJECT/$CI_PROJECT_NAME/cache
        --cache-to $CONTAINER_REGISTRY/$REGISTRY_PROJECT/$CI_PROJECT_NAME/cache
        -t $CONTAINER_REGISTRY/$REGISTRY_PROJECT/$CI_PROJECT_NAME:$CI_COMMIT_SHORT_SHA .
    - buildah push $CONTAINER_REGISTRY/$REGISTRY_PROJECT/$CI_PROJECT_NAME:$CI_COMMIT_SHORT_SHA
```

Same runner prerequisites as werf. Publish through the project’s authorized build pipeline.

## Deploy

```yaml
.deploy:
  extends: .werf
  stage: deploy
  interruptible: false
  needs: [build, image-scan]
  resource_group: $CI_ENVIRONMENT_NAME
  script:
    - werf converge --require-built-images --use-build-report --build-report-path werf-build.env --env "$CI_ENVIRONMENT_NAME" --values ".helm/values/$CI_ENVIRONMENT_NAME.yaml" --atomic
```

- Kubeconfig: a protected file-type variable `KUBECONFIG` scoped to the environment (a human creates it). werf reads `KUBECONFIG` like kubectl.
- `--require-built-images`: deploy never builds; it fails if `build` did not publish the images.
- `werf converge` waits for readiness, but automatic rollback is not implicit. Inspect the pinned version's help and effective flags/environment; pass `--atomic` explicitly when the selected rollout policy requires it. A failed first install has no previous deployed revision to restore. Inspect the actual release, pods and PVCs after failure; rollback cannot restore database contents.
- Production in the bundled starter: `when: manual`, default branch only (adapt to the project’s actual release ref), `environment: production` (protected environment, Maintainers deploy).
- Secrets: `werf helm secret values` with `WERF_SECRET_KEY` as a masked protected variable, or External Secrets. The agent never reads or decrypts secret values files.
- Chart in `.helm/` of the app repo; render locally with `werf render --env dev --values .helm/values/dev.yaml`.

## Registry cleanup

Registry cleanup deletes images and must have a separately approved scope and schedule, including retention and deployed-image protection. Inspect the bundled cleanup job before adopting the starter: its schedule rule alone does not distinguish a cleanup schedule from a security audit. Remove the job or make it opt-in for a dedicated owner-approved cleanup schedule; never activate it incidentally when scheduling scans. Preparing this configuration does not authorize running `werf cleanup`.
