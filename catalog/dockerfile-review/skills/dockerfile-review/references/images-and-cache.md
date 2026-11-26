# Image, dependency and cache decisions

Use when changing the base, stage layout, dependency installation or build context. Sources checked on 2026-11-01.

## Choose a compatible minimum

Prefer maintained, trusted bases and remove unnecessary packages from the final image. Pin the chosen base identity according to the project's reproducibility policy; pair digest pinning with reviewed updates and rebuilds. A fixed digest freezes vulnerabilities as well as working behavior. Do not use `latest` or omitted tags in release inputs. Use an explicit supported version and a tested digest when immutable identity is required. [Docker best practices](https://docs.docker.com/build/building/best-practices/#choose-the-right-base-image)

| Candidate | Check before choosing |
|---|---|
| Slim distribution/runtime | Required shared libraries, CA certificates, locale/timezone data and package availability |
| Alpine | musl compatibility, native dependencies and available wheels/binaries; a smaller base can require extra compilation |
| Distroless | Matching runtime/ABI and a shell-free launch/health-check path; normal images omit a shell and package manager |
| Scratch | Executable dependencies and required runtime data must be supplied explicitly; do not assume every compiled binary is self-contained |

Alpine's libc tradeoff is documented by the [official Python image maintainers](https://github.com/docker-library/docs/blob/master/python/README.md#pythonversion-alpine). Distroless's launch and debugging constraints are documented in the [upstream project](https://github.com/GoogleContainerTools/distroless#entrypoints). These are choices to test, not a universal preference for one image family.

Keep compilers, SDKs and build-only dependencies in named stages, and copy the required outputs into the runtime stage. Preserve generated files, package data and runtime libraries. Check the real target and stage dependency graph: BuildKit skips unrelated stages, so a `test` stage is not automatically executed when building `runtime`. [Multi-stage builds](https://docs.docker.com/build/building/multi-stage/)

## Avoid unnecessary filesystem layers

Remove redundant `RUN`/`COPY` operations and files that do not belong in the runtime artifact. Combine related download, install and cleanup commands in one `RUN` so temporary archives and package caches never enter a committed layer. Deleting them in a later layer hides them but retains their earlier bytes. Use `&&` or equivalent failure handling so a failed install cannot be masked by successful cleanup. Keep build tools in a separate stage and copy only runtime outputs.

Optimize retained bytes and cache reuse, not instruction count alone: metadata instructions do not add filesystem payload like `RUN`/`COPY`, and one giant `RUN` can invalidate expensive dependency work for every edit. Preserve useful dependency/source boundaries. Do not clear cache mounts solely to shrink the image; their contents are not image layers. [Dockerfile instructions](https://docs.docker.com/reference/dockerfile/), [cache mounts](https://docs.docker.com/build/cache/optimize/#use-cache-mounts)

## Make dependency work repeatable

- Preserve the package manager and use its lockfile-respecting install mode. Check that dependency manifests, workspace packages and build metadata are available before installation; ordering for caching must not omit required inputs.
- For Debian/Ubuntu packages, keep index refresh and installation in the same `RUN`, omit unnecessary recommendations and remove downloaded package lists in that same layer when they are not cache-mounted. Do not combine unrelated steps solely to minimize layer count. [Package installation guidance](https://docs.docker.com/build/building/best-practices/#apt-get)
- Verify downloaded artifacts against a trusted digest/signature where the publisher provides one. Do not disable TLS validation to make a build pass. Pinning the base alone does not freeze dependencies downloaded during `RUN`.

## Bound context and cache scope

Check the context selected by the actual build command, including named contexts. Dockerfile-specific ignore files can override the root `.dockerignore`. Exclude credentials and irrelevant generated state, while retaining files required by packaging or version generation. Prefer explicit `COPY` inputs where practical; `.dockerignore` is not a secret-delivery mechanism. [Build contexts](https://docs.docker.com/build/concepts/context/#dockerignore-files)

Place stable dependency inputs before frequently changing source. Use supported cache mounts for disposable downloads; outputs needed in the final image must not live only in those mounts. Scope caches by platform/toolchain as needed and respect trust boundaries for shared cache writers. Keep a working cold-cache path. [Cache optimization](https://docs.docker.com/build/cache/optimize/)

Separate freshness from performance: `--no-cache` reruns build steps but does not itself pull a new base; `--pull` checks the base reference. Neither replaces a deliberate dependency-update process. Compare cold/warm builds and final image sizes under the same target, platform and measurement method. [Rebuild behavior](https://docs.docker.com/build/building/best-practices/#rebuild-your-images-often)
