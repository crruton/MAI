# Security job patterns

These are examples to adapt to the repository's real inputs, stages, versions and runner routing. They do not configure schedules, issue delivery or merge enforcement by themselves. Preserve stricter existing policy. The selected default below concerns dependency scanning; secrets can appear in any file.

## Dependency gate on relevant MR changes, full scheduled audit

```yaml
dependency-scan:
  stage: test
  image:
    name: aquasec/trivy:0.76.1  # example version; verify availability/compatibility
    entrypoint: [""]
  needs: []
  variables:
    TRIVY_CACHE_DIR: $CI_PROJECT_DIR/.cache/trivy
  script:
    - trivy fs --exit-code 1 --severity CRITICAL --scanners vuln --format json --output dependency-report.json .
  artifacts:
    when: always
    expire_in: 7 days
    paths: [dependency-report.json]
  rules:
    - if: '$CI_PIPELINE_SOURCE == "schedule" && $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH'
    - if: '$CI_PIPELINE_SOURCE == "merge_request_event"'
      changes:
        - requirements*.txt
        - pyproject.toml
        - uv.lock
        - Dockerfile
        - .gitlab-ci.yml
        - infra/ci/**/*
```

Expand the inputs for the actual language/build graph: base-image pins, lockfiles, build scripts and local includes. A job omitted on unrelated MRs is intentional in this mode; consumers must use an optional `needs` edge only for this deliberately conditional check. The scheduled failure remains visible and retains a report; an owner must configure a schedule and finding/issue handling. This example does not silently downgrade failures to success or create issues itself.

For all-MR enforcement, omit `changes` after the owner selects that policy. Severity is the project policy; CRITICAL is an example. Caching Trivy's DB should preserve refresh behavior and follow the verified backend's writer policy.

## Scan the actual built image

```yaml
image-scan:
  stage: scan
  image:
    name: aquasec/trivy:0.76.1
    entrypoint: [""]
  needs: [build]
  script:
    - trivy image --exit-code 1 --severity CRITICAL "$BUILT_IMAGE_DIGEST"
```

Declare the `scan` stage after `build`, or use the project's existing DAG. `BUILT_IMAGE_DIGEST` is a contract to implement from the real builder's artifact/dotenv output, not an assumed existing variable. A werf profile can use its build report instead. Align scan rules with the build and release policy; omit image scanning when no image is built. Authenticate through scoped CI variables without logging credentials.

## Secret scanning scopes

Working-tree MR example (does not inspect deleted/intermediate commit content):

```yaml
secret-scan:
  stage: test
  image:
    name: zricethezav/gitleaks:v8.30.1
    entrypoint: [""]
  needs: []
  script:
    - gitleaks dir --redact --no-banner .
  rules:
    - if: '$CI_PIPELINE_SOURCE == "merge_request_event"'
```

For MR commit coverage, prefer `gitleaks git --redact --log-opts="$MERGE_BASE..$CI_COMMIT_SHA" .` in a reviewed helper that resolves and verifies the merge base against the intended target. Fetch sufficient history; validate both refs and the reported scanned commit range. A missing base or zero scanned commits must not masquerade as a clean check. Use project lint/wiring tests for these conditions.

History audit is a distinct scheduled job with sufficient checkout depth (often `GIT_DEPTH: "0"`) and `gitleaks git --redact --no-banner .`. Track genuine historical leaks through remediation/rotation; keep reviewed baseline decisions separate from current-tree/range coverage. Do not repeatedly scan all history in every MR merely because a generic template did so.

Tool behavior: [Gitleaks usage](https://github.com/gitleaks/gitleaks#usage). Verify flags against the installed version.

## Existing GitLab templates and IaC

Retain approved SAST/Dependency Scanning includes when already used. Inspect the server's expanded template and actual job names before overriding them. Reports do not automatically enforce findings severity. Apply `trivy config` only to relevant Dockerfile/Terraform/Kubernetes inputs; the presence of this skill does not imply a Kubernetes deployment.
