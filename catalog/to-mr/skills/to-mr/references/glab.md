# glab operations

Use installed `glab <command> --help` as the source for supported flags. Current
online documentation can describe flags absent from the installed version.
Use `glab mr` where supported and `glab api` for missing operations; both use
glab authentication. Ordinary Git commits and pushes still use `git`.

## Access and setup

Determine the host from the intended remote before checking authentication:

```sh
glab --version
glab auth status --hostname "$gitlab_host"
glab api --hostname "$gitlab_host" "projects/$project_path_encoded"
```

URL-encode the entire namespace/project path as one path segment, or use a
verified numeric project ID. Keep source and target project IDs distinct for
forks. Prefer explicit full project URLs for `--repo` on self-hosted instances.
Do not let a globally configured host silently select another instance.

If installation is needed, offer the platform-appropriate method from the
[official CLI installation guide](https://gitlab.com/gitlab-org/cli#installation).
For example, Homebrew users can install with `brew install glab`. Help carry out
accepted setup, then verify the installed command.

Use `glab auth login --hostname "$gitlab_host"`; choose supported web/device
login or let the user enter a token through the CLI. Consult `--help` for this
version's keyring option and prefer OS credential storage when available. If a
token is required, explain the GitLab `api` scope for MR operations. Use an
approved secret input mechanism or stdin, never ask for a token in chat, print
it, or save it in the repository. Preserve existing Git transport settings.

Check authentication and project access again before resuming. If authentication
works but the network or authorization fails, report the actual failure; do not
repeatedly reinstall or request login. Missing write permissions can still
surface at publication; report them without claiming the MR was created.

## Find and inspect an MR

```sh
glab mr list --repo "$target_project_url" \
  --source-branch "$source_branch" --target-branch "$target_branch" --output json
glab mr view "$mr_iid" --repo "$target_project_url" --output json
```

`mr list` defaults to open MRs. Check `source_project_id`, `target_project_id`,
branches, and state in results; branch names alone can match multiple forks.
Paginate if needed. The MR IID is local to the target project. Use the project's
`default_branch` from project metadata when no target has been specified.

The API can read the full saved MR, including `sha`, `draft`, and `description`:

```sh
glab api --hostname "$gitlab_host" \
  "projects/$target_project_id/merge_requests/$mr_iid"
```

## Publish Markdown safely

Write the exact UTF-8 description to a temporary Markdown file outside the
commit. If the installed CLI supports `--description-file`, use it for create or
update. Otherwise read the file and pass it as one `--description` argument via
an argument-array subprocess call, with no shell interpolation. For example,
after resolving the actual values:

```python
import subprocess
from pathlib import Path

args = [
    "glab", "mr", "create", "--repo", target_project_url,
    "--source-branch", source_branch, "--target-branch", target_branch,
    "--title", title, "--description", Path(body_file).read_text(encoding="utf-8"),
    "--draft", "--yes",
]
if source_project_url != target_project_url:
    args.extend(["--head", source_project_url])
subprocess.run(args, check=True)
```

Pass the normal `[KEY] …` title with `--draft`; verify that GitLab stores exactly
one Draft prefix. For updates use the same file-reading approach with
`glab mr update <iid> --repo <target-url> --description <body> --yes`, adding a
title only when it needs changing. Preserve a Draft prefix when editing a Draft
title; do not accidentally make it ready through a title change.

Never use `--fill` to replace the authored description with commit history, or
enable `--auto-merge`. If this CLI still prompts despite explicit inputs, use
`glab api --method POST/PUT --input <json-file>` for the corresponding MR
endpoint. Generate that UTF-8 JSON with a serializer, preserving the full
description and explicit Draft title; do not build JSON with shell escaping.

## Upload artifacts

When `glab api --help` lists `--form`, upload to the target project:

```sh
glab api --hostname "$gitlab_host" --method POST \
  "projects/$target_project_id/uploads" --form "file=@$artifact_path"
```

Use the response's `markdown` or upload URL; do not invent a link or put a local
filesystem path into the MR. Keep captions beside attachments under Evidence.
Check that a returned link is usable for the intended reviewers. Upload only
the relevant captured artifacts, avoiding secrets and personal data.

`--field file=@...` reads a value for JSON and is not a multipart upload. If
`--form` is absent, check whether this version supports `mr create/update
--attach`. Use it when available and arrange its returned links in Evidence.
If neither exists, retain the local artifact, report the upload limitation, and
publish the textual evidence. Do not bypass the glab requirement.

## Draft transitions

```sh
glab mr update "$mr_iid" --repo "$target_project_url" --draft --yes
# Only after the designated reviewer's approval of the current source SHA:
glab mr update "$mr_iid" --repo "$target_project_url" --ready --yes
```

Apply the review rules in the main skill before either transition. Re-read the
MR after writes, particularly after an uncertain response. The GitLab ready
operation is not a commit-SHA compare-and-swap; verify the head before and after
it and restore Draft if approval became stale.

## Official references

- [Authentication](https://docs.gitlab.com/cli/auth/login/)
- [Create MR](https://docs.gitlab.com/cli/mr/create/) and [update MR](https://docs.gitlab.com/cli/mr/update/)
- [Authenticated API calls](https://docs.gitlab.com/cli/api/)
- [Markdown uploads](https://docs.gitlab.com/api/project_markdown_uploads/)
- [Draft status](https://docs.gitlab.com/user/project/merge_requests/drafts/)
