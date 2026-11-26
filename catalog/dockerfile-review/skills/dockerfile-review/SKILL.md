---
name: dockerfile-review
description: Review or improve Dockerfiles and container image builds for secret handling, base-image choice, size, caching and runtime correctness. Use for Dockerfile audits, oversized images or build hardening, with or without CI.
version: 1.0.0
owner: crruton
---

# Dockerfile review

Find concrete security, correctness and build-efficiency problems. Tie each finding to a file, instruction or artifact. For a review, report findings; edit when the task asks for changes. Preserve the application's behavior, package manager, builder and deployment stack.

## Establish the actual build

Read the Dockerfile, effective `.dockerignore`, dependency manifests/lockfiles, entrypoint scripts and the build invocation. Identify context root, selected target, build arguments, secret IDs, builder/frontend versions, target OS/architecture and runtime user. Inspect Compose, Bake or CI only where they supply these inputs. Do not assume the last stage is the published target.

Keep pipeline/DAG and scan-enforcement changes within the requested scope; image review alone does not require redesigning CI.

## Review in consequence order

1. **Secrets and trust.** Reject credentials in Dockerfile `ARG`/`ENV`, copied files, URLs or generated image content. Trace where credentials originate and where commands write them. Non-secret build arguments remain valid. Read [secret handling](references/secrets.md) for ephemeral mounts, cache effects and exposure verification.
2. **Base and final contents.** Choose a maintained, trusted image with only the runtime dependencies needed. Compare the final image, not just the base tag. Reject `latest` and omitted tags for release inputs; check digest policy and an update path. Use separate build/runtime stages where build tooling would otherwise ship. Remove unnecessary filesystem layers; combine related installation and cleanup in one `RUN` while retaining useful cache boundaries. Read [image and cache decisions](references/images-and-cache.md) when reviewing stages, bases, package installation or context.
3. **Runtime contract.** Confirm copied artifacts, entrypoint executables and shared libraries exist in the final target. A copied virtualenv may refer to a missing interpreter; a package manager installed only in the builder cannot launch the final image. Verify target architecture and runtime ABI rather than assuming a successful build proves compatibility.
4. **User and permissions.** Run the application as a non-root user unless a concrete runtime requirement justifies an exception, including when the identity is inherited from the base. Check executable/read permissions, writable application paths and mounted volumes. Do not fix permission errors with blanket `chmod 777` or force an arbitrary UID onto every image. Keep application code read-only where practical; give only required data/cache paths write access. Build-stage root access is a separate question.
5. **Startup and shutdown.** Use exec-form `ENTRYPOINT`/`CMD` and preserve argument overrides. For wrappers, migrations, child processes, health checks or delayed shutdown, read [runtime lifecycle](references/runtime.md). Verify signal handling and cleanup rather than assuming JSON syntax or an init process alone makes shutdown correct.
6. **Artifact evidence.** Build/test the selected final target and retain its identity. If publication is in scope, promote the tested artifact rather than rebuilding an allegedly identical tag. Scan that artifact using the project's policy; a small image or clean lint result alone does not establish security. Read [verification](references/verification.md) for checks and their limits.

Runtime behavior sources: [Dockerfile instructions](https://docs.docker.com/reference/dockerfile/), [container users, mounts and runtime options](https://docs.docker.com/engine/containers/run/).

## Execute and report

Inspect build scripts before executing them and use the project's approved runner. Builds execute repository/dependency code and may contact private services. Bound builds, downloads and smoke tests by elapsed time; terminate only resources created for this task on expiry. Do not add publication, privileged execution, a host Docker socket or production credentials just to validate a Dockerfile.

Report findings by impact with the affected instruction, consequence, evidence and smallest useful correction. Distinguish verified defects from conditional risks. State what was linted, built, scanned and run, including target/platform and unavailable checks. Quantify size or speed changes only from comparable measurements; record justified exceptions instead of silently suppressing checks.
