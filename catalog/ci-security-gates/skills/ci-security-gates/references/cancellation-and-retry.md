# Cancellation and retry: choose by pipeline purpose

A ref name alone does not establish deployment semantics. Inspect workflow, jobs and release ownership first.

| Pipeline purpose | Candidate policy | Check before changing |
|---|---|---|
| Superseded MR verification | `on_new_commit: interruptible`, checks `interruptible: true` | Required reports and side effects |
| Latest-only dev deployment on main | Supersede old verification/build work; protect an in-flight rollout as needed | Do not turn every main commit into a mandatory release |
| Production release candidate that must remain deployable | `on_new_commit: none` on its actual branch/tag; serialize rollout | Release ref, artifact identity and protected environment |
| MR with staging deploy/manual jobs | Decide whether to use `on_job_failure: all` | It can cancel staging and manual jobs too; a non-interruptible flag is not protection |

`resource_group` serializes jobs sharing a group; it does not shield them from cancellation. Never change a release process solely to match an example workflow.

## Semantics agents often miss

- `on_new_commit: conservative` stops auto-cancelling a running pipeline after a non-interruptible job starts; `interruptible` targets interruptible jobs. `none` disables this mechanism.
- `on_job_failure: all` is independent of `interruptible`: non-interruptible jobs are not protected from failure-triggered pipeline cancellation. Pending manual jobs can also become cancelled.
- Allowed failures do not trigger failure auto-cancellation. If a retry is expected, cancellation waits for a final blocking failure; do not describe this as stopping on the first failed attempt.
- `retry.max` is one budget across matching `when`/`exit_codes` causes, with a maximum of two retries. It is not a separate allowance per failure reason. Do not omit selectors and accidentally enable retry for every error.

## Targeted retries

Use an existing project's documented selectors and budget. A test helper may emit a dedicated code only when **all** failures meet a retryable condition; mixed assertion failures must retain their nonretryable status. Dedicated retry exit codes are project conventions; verify the classifier and preserve nonretryable failures. Do not introduce blanket `script_failure` retries to hide flaky tests.

An agent-initiated retry is separate from YAML automatic retry. It requires authorization covering that action and must respect the project's failure signature, maximum attempts and job side effects. Preserve the failed trace before retry; stop at the budget and report both attempts. Never infer permission to retry deployment from permission to retry a test shard. Before replaying a mutation after timeout or partial failure, inspect the resulting state read-only; do not assume the previous attempt did nothing. Approval must cover the retry or rollback and its effects, not just the original attempt.

Sources: [GitLab auto-cancel settings](https://docs.gitlab.com/ci/yaml/#workflowauto_cancelon_new_commit), [failure cancellation](https://docs.gitlab.com/ci/yaml/#workflowauto_cancelon_job_failure), [retry selectors](https://docs.gitlab.com/ci/yaml/#retry). Check supported failure-reason names against the server version; names can change between GitLab releases.
