# Failure classes

Signatures are typical substrings; match on meaning, wording varies by version and tool.

## Runner / infra

| Class | Signature in log | Fix |
|---|---|---|
| No disk space | `no space left on device`, `ENOSPC`, `write error: No space` | Not a repo bug first: report runner/disk to owner. In repo: shrink artifacts/cache paths, `expire_in`, avoid `docker save` of big images, clean build dirs. |
| Suspected OOM / process loss | `node down: Not properly terminated`, `worker ... crashed`, `Killed`, exit code 137, `JavaScript heap out of memory`, `OOMKilled`, `signal: killed` | Exit 137 alone is SIGKILL, not proof of OOM; language heap exhaustion differs from a kernel kill. Use [runner resource diagnosis](runner-resources.md) for cgroup/host evidence before changing parallelism or capacity. Do not change runner settings. |
| Stuck / timeout | `This job is stuck because you don't have any active runners that can run this job`; `execution took longer than 1h0m0s`; reason `stuck_or_timeout_failure` | Stuck: tag/runner mismatch in `tags:` (check spelling vs available runners), protected-runner vs unprotected branch. Timeout: find the hanging step (waiting for input, network wait); set job `timeout:` only after the hang is understood. |
| Image pull | `ImagePullBackOff`, `pull access denied`, `manifest unknown`, `toomanyrequests`, reason `image_pull_failure` | Typo/removed tag: fix `image:`; pin an existing tag. `toomanyrequests` (Docker Hub rate limit): use a verified project registry proxy if reachable. Private registry 401: credentials are a human task. |
| Network | `Could not resolve host`, `connection reset`, `TLS handshake timeout`, `i/o timeout`, `502/503` from a registry | Usually transient: check history for the same error on other jobs. Fix in repo only via bounded `retry:` (see below) or a mirror; never `--insecure`/`NODE_TLS_REJECT_UNAUTHORIZED=0`. |
| Runner system failure | reason `runner_system_failure`, `failed to pull image`, executor errors | Infra; report. Use the project’s bounded infrastructure retry policy and failure names supported by its GitLab version. |

## Config

| Class | Signature | Fix |
|---|---|---|
| YAML invalid | `yaml invalid`, `jobs:build config contains unknown keys`, pipeline did not start | `glab ci lint`; fix indentation/keyword. |
| Rules produce no jobs / wrong jobs | `Pipeline will not run`, `no jobs`, job missing in MR pipeline | Check `workflow:rules` and `rules:if` against `CI_PIPELINE_SOURCE`, `CI_COMMIT_BRANCH` (empty in MR pipelines; use `CI_MERGE_REQUEST_*`). Never use `only/except`. |
| `needs` mismatch | `'build' job needs 'compile' job, but 'compile' is not in any previous stage`; `needs` job excluded by rules | Make the needed job exist under the same rules; fix name; `needs:optional: true` only when the dependency is legitimately conditional. |
| Missing variable | `variable is not set`, empty `$FOO`, `unbound variable`, auth errors with blank token | Check where defined (project vs group, protected, environment scope). If it is defined but protected: see Permissions. If undefined: ask owner; do not invent a value. |
| Include broken | `Project ... not found or access denied`, `local file ... does not exist`, `Included file ... ref` errors | Fix path/ref; project includes need the token/project visibility. |
| Artifact / dependency gap | `No such file or directory` for build output | Missing `artifacts:paths`, expired artifact, or `dependencies:`/`needs:artifacts` excluding it. |

## Dependency / cache

| Class | Signature | Fix |
|---|---|---|
| Lockfile drift | `npm ci` can only install with an existing package-lock.json / "in sync"; `pip` hash mismatch; `go: updates to go.mod needed`; `Cargo.lock needs to be updated`; `yarn --frozen-lockfile` fails | Regenerate the lockfile locally and commit with the manifest change in the MR. Do not switch `npm ci` to `npm install` to pass. |
| Registry 401/403 | `401 Unauthorized`, `403 Forbidden`, `E401`, `authentication required` from npm/pip/maven/registry | Expired/missing token or scope: human task. Check that `.npmrc`/`settings.xml` reference a CI variable, not a literal. |
| Registry 429 | `429 Too Many Requests`, `rate limit` | Transient or shared-IP limit: use mirror/cache; bounded `retry:`; no tight loops. |
| Corrupted cache | `unexpected end of archive`, `tar: ... Unexpected EOF`, `invalid checksum`, odd module resolution errors that vanish on a fresh branch | Change the cache `key` (e.g. add a version prefix via `key:prefix`) in the MR so a clean cache is built; consider `policy: pull` on consumers so only one job writes. |
| Version bump broke build | New error after a dependency/base-image update with no code change | Pin the version; compare lockfile diff between last green and first red pipeline. |

## Code

| Class | Signature | Fix |
|---|---|---|
| Test failure (deterministic) | Same assertion on every attempt, tied to the MR diff | Fix code or test on the branch; quote the failing test name. |
| Flaky test | Passes on retry/same commit; timing, ordering, network, random seed, shared state | Exclude worker/infrastructure loss first. Preserve the existing quarantine registry: diagnosed mechanism, issue/owner, expiry and continued test execution where supported. Do not replace it with skip. No blanket `script_failure` retry; use only project-approved specific selectors/exit codes and budget. |
| Lint / format / type check | `eslint`, `ruff`, `mypy`, `gofmt` diff output | Run the same command locally, fix. |
| Build error | compiler error pointing at changed lines | Fix at the line. |

## Permissions

| Class | Signature | Fix |
|---|---|---|
| Protected variable unavailable | Variable empty on a branch/tag that is not protected; deploy/registry auth fails only on unprotected refs or MR pipelines | Expected behavior. Do not unprotect or copy the value. Report: which variable (name only), which job, and that the job should run only on protected refs or a human should provide a non-protected scoped variable. |
| Job token scope | `403` fetching another project's package/artifact/include with `CI_JOB_TOKEN` | Human adds project to the job-token allowlist; report. |
| Protected runner / environment | Job pending forever on non-protected ref | Runner/environment protection is a human setting; report. |
| Push/permission in script | `remote: You are not allowed to push` | Check actual token scope and repository branch policy. Do not infer allowed branch names from a generic skill. |
