# Evidence capture

## Baseline and provenance

For changed behavior, compare a known pre-change revision with the final task
revision. Usually the merge base supplies the baseline; prefer a known affected
release when the issue specifically concerns it, and label the difference.
Record revisions and scenario in the existing verification record; link it from the MR.

Use an isolated temporary worktree or existing baseline deployment. Preserve
the builder's working tree and index: do not reset, stash unrelated work, or
switch its checkout just to capture before evidence. Use separate ports and
test data where needed. Remove only temporary worktrees and processes created
for this capture after retaining their artifacts.

Capture comparable inputs, state, viewport, and environment on both revisions.
For new functionality, demonstrate the implemented state only. If the baseline
cannot run, provide the after artifact and describe the original issue in text,
explicitly stating why a recorded before state is unavailable.

Keep artifacts outside the product commit. Record which revision each artifact
demonstrates; evidence captured before subsequent relevant edits is stale and
must be refreshed or labelled as historical. Avoid exposing authentication
state, tokens, or real user data in recordings, logs, and screenshots.

## UI: recording or screenshots

Prefer a short Playwright video for an interaction, transition, or multi-step
flow. Use screenshots for static visual changes or when recording is not
available. Reuse the project's browser tooling and test scenarios where possible.

1. Start the appropriate application revision and open the relevant scenario.
2. Exercise the actual changed behavior, including the resulting visible state.
3. Record a successful run as well as a failing baseline when relevant. Video
   settings that retain only failures will discard the after demonstration.
4. With the Playwright library, enable `recordVideo` on the browser context and
   await `context.close()` before expecting the video file to be complete. With
   Playwright Test, use video mode `on` for the capture run without unnecessarily
   changing the project's permanent configuration.
5. Inspect the files: the important state must be visible and the video must
   finish with the demonstrated result. A created file alone is not sufficient.
6. Caption the result in Russian; add actions or timestamps only when needed.
   Transcripts, narration, and burned-in subtitles are not required.

Use the changed component or meaningful page region for screenshots. Include
another viewport only when responsive behavior is part of the change. Keep
before/after labels clear and avoid mixing screenshots from different scenarios.

If the browser tools or running application are unavailable, use the main
skill's text fallback. Do not turn an MR publication task into an unrelated
browser-infrastructure project.

## Backend and database views

Use views only to clarify application changes. Derive flows from the implementation:
entrypoint, decisions, relevant calls, side effects, and result. Keep before/after
small enough to compare; one diagram or focused structural diff usually suffices.

For database changes, show only affected entities, fields, constraints, and
relationships, using exact table and column names from the schema. Distinguish
conceptual/application models from the database schema and verified runtime state.
Show a new model only once when it has no predecessor. Run migrations and data
checks only in an appropriate isolated test database; never mutate production
just to produce evidence.

Pair these views with actual observed checks when available. A diagram derived
from source proves neither migration success nor runtime behavior. For a bug,
show the exact reproduction and its result on each revision. If only the new
revision was tested, state that rather than asserting that a regression test
failed on the baseline.

## Publication

Upload the selected artifacts using [glab operations](glab.md). Link them next
to the explanation they support, and retain readable text if the video or HTML
cannot render inline. A local path is useful to the builder but not a published
MR attachment. Existing stable CI artifact links are usable when the reviewer
can access them; mention known expiry rather than promising permanence.

## Playwright references

- [Videos](https://playwright.dev/docs/videos)
- [Screenshots](https://playwright.dev/docs/screenshots)
