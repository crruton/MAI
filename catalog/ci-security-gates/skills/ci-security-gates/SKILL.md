---
name: ci-security-gates
description: Configure and verify GitLab CI security scans, merge gates and scheduled audits with explicit scope and suppression policy. Use for dependency/image/secret scanning, findings, false positives or proving that a scan blocks the intended merge/release workflow.
version: 1.0.0
owner: crruton
---

# CI security scans and gates

Establish the owning repository, target environment, execution context, change owner and authorized workflow from project instructions and configuration. Reuse known facts; ask only for missing information that changes the action. Deliver a scoped CI change and evidence of the chosen behavior. A scan, a failed job and an enforced merge block are different things; name which one is implemented.

## Execution boundary

A security audit schedule must not incidentally execute deployment or registry cleanup. Weakening gates or enabling destructive scheduled jobs requires approval for that specific change.

## Choose scope before writing jobs

Preserve the existing project's security and merge policy. For new dependency scanning, default to **relevant MR changes plus scheduled default-branch audit**:

- MR gate: dependency manifests/lockfiles, Dockerfile/base-image definitions and any scripts/includes that change those inputs. Review the actual dependency graph; do not blindly copy a file list.
- Scheduled audit: full default-branch dependency state with a fresh vulnerability database. Name the triage owner, reporting/issue mechanism and expected cadence. A schedule without a receiver is not a completed operational setup.
- Dependency CVEs in unchanged inputs are discovered by the scheduled audit, not guaranteed to block every MR. State that detection delay and separate release policy explicitly.
- All-MR blocking scans remain an option where the owner requires continuous enforcement. Do not convert an existing all-MR gate to selective scanning merely to make a red pipeline green.

Secret detection has a different input scope: secrets can appear in any file. Prefer an MR commit-range scan or a documented working-tree scan, plus a separate history audit; do not restrict secret scans to dependency changes. `gitleaks dir` misses secrets added and deleted within MR commits, while a range scan needs a valid fetched merge-base and enough history. See [snippets](references/gitlab-snippets.md).

## Procedure

1. **Inventory the effective CI.** List tools, scopes, thresholds, rules, allowed failures, audit schedules and actual merge/release enforcement (GitLab settings, approval policy or project coordinator). Preserve the project's branch names and authorization model.
2. **Select relevant tools.** Dependency/image vulnerabilities: Trivy; secret content: Gitleaks; IaC misconfiguration: Trivy config only for present IaC inputs. Existing SAST/dependency templates can provide reports, but severity findings do not automatically make a blocking gate. Reuse approved existing includes; werf is not required.
3. **Wire jobs and artifacts.** A blocking scan must exit nonzero on the selected findings and must not be allowed to fail. Conditional scan jobs need matching conditional consumers or deliberately optional `needs`; do not require an absent job. Image scans use the immutable artifact from the actual builder (digest/full-SHA receipt or werf report), never an unrelated `latest` tag.
4. **Check auto-cancel effects.** `on_job_failure: all` can remove test and staging results after a final blocking scanner failure; `interruptible: false` does not protect them. Allowed-failure/report-only jobs do not trigger it. Coordinate scan scope and fail-fast policy using [cancellation semantics](references/cancellation-and-retry.md).
5. **Validate.** Use the project's CI lint and wiring tests. Test relevant MR changes, unrelated MR changes, default-branch schedule and release flow. An offline YAML parse does not prove GitLab behavior. Confirm scanner execution and input coverage, not just an exit status with zero scanned files.
6. **Prove the result.** Use synthetic known-bad and fixed fixtures in a local/isolated test, never a real credential. Show failure/pass of an intended gate; for an audit, show that its finding reaches the configured owner/reporting path. Prepare issue integration if requested; do not send findings externally without authorization. Do not describe a pending owner setup as verified.
7. **Deliver.** Include selected scope, known existing findings, scan vs merge-block behavior, checks actually run, missing owner setup and rollback. Settings/credentials/schedules are changed only within the task's authorization, never as an implicit consequence of adding YAML.

## Findings and suppressions

Do not suppress an out-of-scope finding merely because its fix belongs in another MR. Report it to the owner and retain the current gate/policy until a targeted exception is approved. Scanner transport errors are infrastructure failures, not clean results.

Exceptions are per finding, with reason, owner, issue and expiry; use the project's maximum lifetime (a stricter 30-day policy must not become 90 days). If no lifetime is established, propose a short bounded period for owner review. Do not present a default as permission to accept risk. Keep suppression changes visibly reviewable.

For Trivy, an approved `.trivyignore` entry can use `exp:YYYY-MM-DD`; verify the installed scanner's supported format and expiry behavior. Gitleaks allowlists/baselines must be specific to an approved false positive or reviewed historical baseline, not broad file or history exclusions. Never relabel a real leaked credential as a false positive; track rotation/revocation separately, even if it is absent from the current tree. Redact scanner logs and reports, and never reproduce the value.

## Enforcement checklist

- Which MR/release inputs are covered, and which are covered only by scheduled audit?
- Which setting or coordinator actually prevents merging/releasing on a blocking failure? Is that policy enabled or merely proposed?
- Does the schedule exist, and who receives and tracks findings? What happens if the audit fails to run?
- Are tool versions compatible with the server and is the vulnerability DB refreshed? Are credential variables referenced by name only?
- Do the known-bad and clean controls demonstrate the expected behavior without weakening other tests?

A scheduled scan cannot itself block an earlier unrelated MR. A GitLab report widget is not a severity gate. A historical secret audit does not establish that leaked keys were rotated.
