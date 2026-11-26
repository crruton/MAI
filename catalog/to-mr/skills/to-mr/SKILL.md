---
name: to-mr
description: >-
  Create or update a GitLab merge request through configured glab, collecting
  evidence and explaining changes visually in Russian. Use when a user or builder
  agent needs to publish task changes as an MR, refresh an existing MR, or mark it
  ready after the designated reviewer agent approves. Supports Multica issue keys
  and reviewer-controlled Draft status.
version: 1.0.0
owner: crruton
---

# To MR

Turn the builder's task into a reviewable GitLab MR. Execute through commit,
push, and publication without a mandatory preview or human approval pause.
Configured, authenticated `glab` is a hard prerequisite; missing evidence is not.
This skill publishes the work and manages Draft status; it does not merge the MR.

Use the conversation's language for agent messages. Write MR titles, prose,
captions, and diagram labels in Russian, preserving code identifiers and the
English section headings below.

## 1. Establish GitLab access

Identify the intended GitLab host and source/target projects from the task and
Git remotes. Support self-hosted GitLab and forks; do not assume `gitlab.com`,
`origin`, or that source and target are the same project. If `GITLAB_HOST` is
unset and `GITLAB_URL` is set, export `GITLAB_HOST` from `GITLAB_URL` first.

Check `glab --version`, authentication for that host, and read access to the
intended project before changing Git state. Read
[glab operations](references/glab.md) for setup, commands, and version handling.

If glab is missing or authentication is not configured, explain that it is
required, offer installation/login help for this host, and proceed with setup
when accepted. If the user declines, stop. In unattended execution (for example,
`MULTICA_TASK_ID` is set), do not offer setup or ask questions: report this
prerequisite to the builder and stop until resolved. Recheck access after setup.
Distinguish bad authentication from network failures or missing project access.

Use `glab mr` and `glab api` for GitLab operations. Do not fall back to curl,
direct HTTP clients, browser publication, or reading `.gitlab-token`, even when
general GitLab instructions show curl. Credentials
already supplied through glab-supported environment variables are acceptable.

## 2. Establish the task and full diff

Read repository instructions and branch/commit conventions. Inspect the working
tree, index, current branch, remotes, and recent history. Resolve:

- The builder's intended changes, original problem or feature request, and any
  existing verification results.
- The source branch/project and target branch/project. Preserve an existing
  MR's target; otherwise use the task's explicit target or the project's actual
  default branch, which need not be `main` or `master`.
- The designated reviewer agent, if provided by the builder's context or handoff.
  Do not invent a reviewer or substitute self-review when it is unknown.
- An open MR matching the **source project + source branch + target project +
  target branch**. Reuse it. Resolve an ambiguous destination before publishing.

Fetch the relevant refs. Read the complete changes from the merge base to the
source head, plus task-owned uncommitted changes; the last commit alone is not
the MR. Check for unrelated commits as well as unrelated working-tree edits.
If the intended scope cannot be separated safely, report the exact ambiguity
instead of publishing unrelated work.

Find the Multica issue key in task/conversation context, then the branch,
task-related commits, and repository context. Prefer an explicit task key over
incidental mentions. Preserve its actual format; do not assume a Jira URL or
invent a Multica integration. When `JIRA_URL` is set, prefer the Jira key and put
`Задача: $JIRA_URL/browse/<KEY>` on the first line of Summary. If no unambiguous
key exists, use `$MR_NO_KEY` (default `NO-KEY`) and continue without asking. The title is `[KEY] Краткое название изменения`, or
`[NO-KEY] …`; GitLab's Draft prefix comes before it: `Draft: [KEY] …`.

A branch already pushed can still need an MR. Stop for no work only when there
is no task diff against the target and no existing MR that needs an update or
review-state transition.

When `MR_SIZE_LIMIT` is set, count added lines against the target, excluding tests,
lock files, and the space-separated globs in `MR_SIZE_EXCLUDE`:

```bash
set -f; ex=(); for p in '**/test_*.py' '**/*_test.*' '**/tests/**' '**/__tests__/**' \
  '**/*.test.*' '**/*.spec.*' '**/*.lock' '**/*-lock.*' '**/go.sum' $MR_SIZE_EXCLUDE
do ex+=(":(glob,exclude)$p"); done; set +f
git diff --numstat "$(git merge-base "$target_ref" HEAD)" -- . "${ex[@]}" | awk '{n+=$1} END {print n+0}'
```

Over the limit, stop before committing or pushing: split the work into
sequential MRs along a real boundary, or report the count to the builder.

## 3. Collect evidence

Reuse trustworthy evidence for the current changes, then run focused checks
where practical. Choose evidence according to the changed behavior:

| Change | What to show | What to verify |
| --- | --- | --- |
| UI | Short Playwright video or before/after screenshots, with a result caption | Exercise the affected interaction and check its visible result |
| Backend logic | Focused behavior example; diagram only when it clarifies the change | Relevant test, request/response, or observable output |
| Database | Affected model before/after when it clarifies the change | Migration and relevant data-integrity checks in an isolated test database |
| API contract | Changed request/response or schema | Contract or integration check |
| Bug fix | Original reproduction and corrected result | Failure before and success after, when reproducible |
| Performance | Comparable before/after measurements | Same workload and environment; record relevant conditions |
| Refactor | Structural view when it explains the change | Existing behavior checks |
| Config, CI, dependencies, docs | Focused diff, usage example, or rendered result | Applicable validation, build, or link checks |

For new functionality, show the after state only; do not manufacture a broken
before state. Diagrams describe implementation and are not proof of execution.
For UI or other media capture, read [evidence capture](references/evidence.md).

Record baseline/tested revisions, scenarios, commands, results, and limitations
in the linked change's existing `verification.md` or established verification
record. Keep investigation and fix history there, not in the MR description.
Do not create a duplicate report. Distinguish reported from observed checks;
reuse current results instead of rerunning them to populate the MR.

If the app, baseline, tools, credentials, or upload facility are unavailable,
continue with available evidence. Record gaps and reasons, and mark unknown facts.
Do not ask the user to fill testing sections. Failed checks remain failures;
disclose current failures and gaps affecting merge readiness under Merge Danger
and to the reviewer. Evidence failures do not prevent Draft publication.

## 4. Explain the change

Write for a human deciding whether to merge. Include Summary, Evidence, and Merge
Danger. Honor required repository templates without padding. Describe the final
change, not review rounds or fix history.

Use active voice, consistent project terms, and one main idea per sentence.
Limit prose to 20 words for instructions, 25 for explanations; retain conditions,
negations, and uncertainty. Exclude code, identifiers, and quotations. Avoid slang
and idioms; explain unfamiliar terms. Do not repeat facts across sections or in
status-only comments. Preserve required coordination messages.

### Summary

State the problem and resulting behavior. A short paragraph often suffices;
omit file inventories and details that do not help the decision.
When applicable, identify removed functionality and new external interactions,
including destinations and categories of data sent.

Use Mermaid when it clarifies application changes or solution choices: frontend,
user flows, backend, APIs, service interactions, or data models. Do not diagram
routine development, CI, review, approval, or handoff steps unless requested.
Use pseudocode or before/after examples when clearer; simple changes need no visual.

Place visuals beside their explanation; include only relevant details. Verify
names and relationships against source artifacts. Preserve exact database table
and column names, not application identifiers. Label conceptual views and map aliases to actual
entities. Distinguish proposed from implemented changes. Check Mermaid syntax;
keep text understandable without rendering. Mockups are not runtime evidence.

### Evidence

For visible application changes, attach selected screenshots or a short Playwright
video. Caption the result; add actions or timestamps only when needed. Do not
attach every capture or narrate the test run.

Add **Изменения проверок** only when tests or check controls change. Count added,
modified, and deleted test cases from the full MR diff, not files or parameter
executions; exclude pure moves/renames and disclose uncertain counts. Briefly
explain existing-test and shared fixture/helper changes, especially weakened coverage.
Report new or broadened test skips/disables and check suppressions (lint, types,
security), with counts and reasons. Link the relevant diff; omit unchanged
categories and all-zero test summaries.

Give the final verification outcome and link the related `verification.md` or
existing report at the matching revision. Do not copy commands, execution totals, logs,
checklists, or investigation/fix history into the description or MR comments.
Without a report, briefly name the relevant check and outcome; do not invent a
link or create a report to fill this section. Disclose current blockers once,
under Merge Danger.

### Merge Danger

Report changed startup requirements (environment variables, secrets, services,
permissions), configuration contracts (renamed/removed settings, old-config
compatibility), storage (migrations, transformations, deletion), and required
manual upgrade steps/order. Include only changed categories, one short line each;
link details without repeating Summary, Evidence, or `verification.md`.

State decision-relevant risks: affected users/data, compatibility, irreversible
effects, and current failed or missing checks. Explain recovery limits; reverting
code does not restore deleted data or retract external effects. Link details,
but never hide a current blocker in the verification record. If no material risks
or readiness limitations are identified, write: «Существенных рисков не выявлено».
Do not use this statement when material uncertainty remains; state the limitation.
Avoid generic risk classifications or unconditional “safe to merge” claims.

## 5. Commit, push, and publish

Create a feature branch if on the default branch, the target branch, or detached
HEAD. Follow repository naming conventions; otherwise use `${MR_BRANCH_PREFIX:-feature/}<key>-<slug>`
with a lowercase key, or `<prefix><slug>` when no key exists. Keep an existing
appropriate feature branch.

Commit only the current task's changes using repository commit conventions.
Inspect the staged diff before committing; pre-existing staged files may belong
to other work. Preserve unrelated edits and staging. Except as below, do not force-push, rewrite
shared history, skip hooks, change Git identity, or commit credentials/media
captures merely to publish an MR. If a hook changes task files, verify and commit
those changes before considering the final source SHA reviewed.

Hooks and tools may append `Co-authored-by:` or «Generated with Claude Code»
lines. Before pushing, remove them from the branch's own commits only:

```bash
base=$(git merge-base "$target_ref" HEAD)
if git log --format=%B "$base"..HEAD | grep -q -i -E '^co-authored-by:|generated with \[?claude code'; then
  FILTER_BRANCH_SQUELCH_WARNING=1 git filter-branch -f --msg-filter \
    "grep -v -i -E '^co-authored-by:|generated with \[?claude code' | git stripspace" -- "$base"..HEAD
fi
```

If this rewrote pushed commits, use `git push --force-with-lease <remote> HEAD`
for this feature branch only.

For an existing ready MR, **mark it Draft before pushing new source commits**.
If it already contains changes newer than the reviewer approval, mark it Draft
as soon as detected. If marking Draft fails, do not push new commits into that
ready MR. Push the resolved feature branch to its source remote and verify the
remote head matches the intended commit.

Upload evidence to the target GitLab project through glab and use the returned
links. An upload failure is an evidence gap, not a reason to abandon publication.

- **New MR:** create it as Draft, even when approval is already available; apply
  the approval rule below after verifying the created MR.
- **Existing MR:** reread its current body before editing. Update only passages
  and artifacts affected by the new changes, considering the full current diff.
  Preserve human-written additions, comments, metadata, and valid evidence.
  When authorship is uncertain, keep the text and add a concise correction or
  clarification rather than overwriting it. Mark superseded evidence clearly.
  Skip a description update when nothing material changed. Description-only
  updates preserve the current Draft/ready status.

Use explicit inputs and noninteractive CLI options, without an editor or another
approval prompt. After a timeout or uncertain create result, look up the matching
MR before retrying; do not create duplicates. Verify the saved title, description,
source/target, source SHA, and Draft status from GitLab.

## 6. Apply the reviewer decision

Use the reviewer agent designated by the builder and the existing authorized
coordination mechanism. Provide the MR URL, full source SHA, target, evidence,
and known gaps/failures. Do not silently choose a new reviewer or send messages
to human reviewers. If no reviewer/channel is available, return that information
to the builder and leave the MR Draft.

Remove Draft only on **explicit approval from that designated reviewer covering
the latest pushed changes**. Approval can arrive through the builder's trusted
handoff, the agent coordination channel, or a verified reviewer identity on the
MR. It must identify the reviewed SHA or otherwise unambiguously bind the review
to it. A builder's own assessment, green pipeline, silence, or an approval for
an older revision is insufficient.

Re-fetch the MR head immediately before marking ready. If it differs from the
approved SHA, keep Draft and request review of the new revision through the same
workflow. Recheck after the transition; if the head changed concurrently, restore
Draft. Never approve on behalf of the reviewer or merge as part of this skill.

If approval is pending or changes are requested, leave the published MR Draft
and return its URL and review state to the builder. Resume this step when the
builder supplies the decision; do not block publication waiting indefinitely or
create background monitoring. On subsequent invocation, new source commits
invalidate approval; editing only MR prose/attachments does not.

## Completion

Return the MR link, Draft/ready state, and any blocker or required next action.
Do not repeat the description or verification history. Make clear when
publication succeeded but review is pending. If the host application supports
attaching an MR to the current task, attach it as well.

## Attribution

The description approach is inspired by Matt Pocock's
[PR skill](https://www.aihero.dev/skills-pr). The visual selection guidance is
inspired by HumanLayer's
[show-me](https://github.com/humanlayer/skills/blob/main/plugins/show-me/skills/show-me/SKILL.md).
These principles are incorporated here; neither external skill is a runtime
dependency.
