# Cache topology and package mirrors

## When applicable

Use when traces show download/install/archive cost or unreliable reuse across runner pools. The goal is to reduce measured cost without assuming a cache backend.

Use the environment’s known cache topology. If it is unknown or a failure contradicts it, inspect recent job traces across the actual runner pools. Successful remote cache download/upload indicates shared storage; a missing shared URL can mean local/slot caches. Redact signed URLs and credentials. Prefer current traces over comments. Do not generalize one runner’s backend to the whole fleet.

## What goes where

| Data | Mechanism | Why |
|---|---|---|
| Package-manager download cache (pip, npm, go mod, maven, uv) | GitLab `cache`, key from lockfiles | Reuse across runners only when a shared backend and compatible keys/protection scopes are verified |
| Scanner databases (trivy) | GitLab `cache`, constant key `trivy-db` | Avoids a DB download per job; trivy refreshes it when stale |
| Build outputs a later job needs (dist/, reports) | `artifacts` with `expire_in: 1 day` or less | Artifacts are tied to the pipeline; cache is best-effort and may miss |
| Image layers | Existing builder cache: host layers, registry cache or werf stages | Locality depends on builder/backend; do not archive image layers as dependency cache |
| Job images (python, trivy, werf) | effective image pull policy | Check executor/platform policy; do not assume local layers are reused |

## Dependency cache pattern

### Why it matters

Cache is optional acceleration; artifacts carry required outputs between jobs. A green warm-cache pipeline must not hide a broken cold-cache build.

### Incorrect for required build output

```yaml
build:
  script: ./build.sh
  cache:
    key: shared-output
    paths: [dist/]

test:
  script: ./test-built-output.sh
  cache:
    key: shared-output
    paths: [dist/]
```

The consumer can receive missing or stale output from another pipeline. These script names represent the project's existing commands.

### Corrected handoff

```yaml
build:
  script: ./build.sh
  artifacts:
    paths: [dist/]
    expire_in: 1 day

test:
  needs:
    - job: build
      artifacts: true
  script: ./test-built-output.sh
```

Keep dependency downloads in a separate cache:

```yaml
.python:
  cache:
    key:
      prefix: pip                     # separate caches per tool
      files: [requirements.txt, requirements-dev.txt]   # at most two files
    paths: [.cache/pip]               # under $CI_PROJECT_DIR, or it is not cached
    policy: pull

unit-tests:
  extends: .python
  cache:
    policy: pull-push                 # the single writer for this key
```

- Shared cache: prefer one writer per key and `pull` readers to reduce competing uploads. Local/slot cache: a single writer does not warm other slots; choose placement/writers from measured archive and miss cost. Preserve a proven existing policy.
- Cache the download dir, not the installed tree (`.cache/pip`, `.npm`, `$GOMODCACHE` under the project dir), unless install time dominates and the runtime image matches exactly.
- Never key by `$CI_COMMIT_SHA` (never hits) or by a constant for dependencies (never invalidates).
- `fallback_keys: [pip-default]` with a scheduled default-branch job writing `pip-default` helps new branches; optional.
- Protected and unprotected refs get separate caches by default (project setting). MR caches can miss separately by key, runner, slot, eviction and backend; do not promise only one cold start.
- Customer runners have their own cache backend (or none); the key scheme stays the same.

### Verify and account for side effects

Validate the expanded pipeline with the target GitLab version. Compare cold and warm runs on the actual runner routes; check both output identity and total download/install/archive time. Exercise a lockfile change and a cache miss. Required outputs must still come from the producing job in the same pipeline. Scope cache writes by trust boundary and keep credentials out of both cache and artifacts.

## Mirrors and network boundaries

Use a package proxy only when the effective runner route can reach it. Verify DNS, VPN routing, TLS and the required upstream path from the job network. Keep project-selected public defaults in Dockerfiles and build configs; pass a credential-free internal index/proxy URL as a job variable or build argument. Pass authentication separately through the builder's [ephemeral secret mechanism](build-secrets.md).

Resolve dynamic tags and `workflow:rules:variables` for every supported pipeline source/ref. Set proxy variables globally only if every resulting job route has access; otherwise scope them per reachable job/rule. A remote runner connected by VPN may use a corporate proxy, while a project hosted on corporate GitLab does not imply all runners can reach it.

Validate runtime registries separately from runner proxies. A build runner can be inside a corporate network while the target cluster is outside it; check all rendered container and init-container image references against the target cluster's network access.

If your organization keeps a corporate network profile in its private skills catalog (MAI ADR 0111), consult it. Otherwise use the project's registry/proxy/cache endpoints. Measure network time before proposing a proxy change; a mirror cannot shorten CPU-bound tests.

Sources: [GitLab cache behavior](https://docs.gitlab.com/ci/caching/), [job artifacts](https://docs.gitlab.com/ci/jobs/job_artifacts/), [needs artifacts](https://docs.gitlab.com/ci/yaml/#needsartifacts).
