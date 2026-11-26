# Build secrets

Use for private dependencies, authenticated downloads, SSH access or suspected image leakage. Sources checked on 2026-11-01; confirm support in the actual builder/frontend.

- Do not pass credentials through Dockerfile `ARG`, `ENV` or `--build-arg`. Values can reach image configuration, history, provenance or build output; `ARG` is not safe merely because it is absent from the running container's environment. Check authenticated index/proxy URLs too. Docker's `SecretsUsedInArgOrEnv` check detects suspicious names, not every secret flow. [Docker check](https://docs.docker.com/reference/build-checks/secrets-used-in-arg-or-env/)
- With BuildKit, pass a file or host environment variable through `--secret` and consume it with `RUN --mount=type=secret`. SSH dependencies can use an SSH mount instead of copying a private key. Require a mount when absence must fail the build. Other builders need their supported ephemeral credential mechanism; never fall back to a secret build argument. [Build secrets](https://docs.docker.com/build/building/secrets/)

Example fragment for a build that needs a private pip index configuration:

```dockerfile
RUN --mount=type=secret,id=pip_config,target=/run/secrets/pip.conf,required=true \
    PIP_CONFIG_FILE=/run/secrets/pip.conf pip install --no-cache-dir -r requirements.txt
```

Pass the existing credential file using `--secret id=pip_config,src=/secure/path/pip.conf`; do not inline its contents. The environment assignment above names a file, not a credential. BuildKit can also mount a secret as a temporary environment variable; that is distinct from Dockerfile `ENV`. [Mount options](https://docs.docker.com/reference/dockerfile/#run---mounttypesecret)

The mount itself is ephemeral. The invoked program can still copy its contents into artifacts, package caches or logs. Inspect that behavior, avoid tracing/echoing credentials and scope cache access. Removing a copied secret in a later layer does not erase the earlier layer. A builder-only stage also does not justify leaving credentials in intermediate caches or exported artifacts.

Changing secret contents does not invalidate the cached build step. When fresh authentication or changed private content must be exercised, invalidate the affected stage or use a separate non-secret cache revision; never use the credential itself as a cache key. [Cache invalidation](https://docs.docker.com/build/cache/invalidation/#build-secrets)

Verify suspected leakage in a restricted environment. Inspect image config, history, relevant layers and available build/cache/provenance outputs without printing credential values into chat. For regression checks use a synthetic marker and report only presence and location. An already-published real secret also needs rotation/revocation through the owner's workflow; rebuilding alone cannot retract copies. Establish exposure scope and affected consumers, preserve redacted evidence, and verify revocation and consumer recovery through the authorized incident process.

Runtime secret delivery is separate from build credentials. Preserve the project's secret-manager or orchestrator mechanism; do not bake runtime values into an image or claim that every runtime environment-variable injection is a Dockerfile `ENV` leak.
