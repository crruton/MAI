# Verify the final image

Use after a proposed correction or when the review needs execution evidence. Sources checked on 2026-11-01. Start with the repository's existing checks; report missing tools rather than installing or replacing a builder without need.

## Static checks

```bash
hadolint Dockerfile
docker buildx build --check -f Dockerfile .
```

Substitute the real Dockerfile/context/target and non-secret build inputs. [Hadolint](https://github.com/hadolint/hadolint#how-to-use) checks Dockerfile and embedded shell patterns; honor existing configuration and explain narrowly scoped exceptions. Do not use blanket ignores or `--no-fail` to turn findings into a green check.

[Docker build checks](https://docs.docker.com/build/checks/) require compatible Buildx and Dockerfile frontend versions; the documented baseline is Buildx 0.15 and Dockerfile 1.8. `--check` does not execute build steps and returns nonzero on check violations, whereas a normal build can report warnings and still exit zero. It can still require builder access, frontend/base resolution and network access; it is not an offline sandbox. Neither tool proves absence of secrets or successful runtime behavior.

Use the project's KICS and Semgrep checks as well when available. Keep tool and ruleset versions reproducible and inspect scan coverage, not just the exit status:

| Analyzer | Scope and invocation |
|---|---|
| KICS | Dockerfile/IaC queries: `kics scan --path Dockerfile --type Dockerfile`. Check installed query coverage and the project's `--fail-on` thresholds; do not mask scanner failures with `--ignore-on-exit`. [KICS CLI](https://docs.kics.io/latest/commands/), [platforms](https://docs.kics.io/latest/platforms/#docker) |
| Semgrep | Reviewed local Dockerfile rules: `semgrep scan --config rules/dockerfile.yaml --error --strict Dockerfile`. Substitute the actual rule path; do not assume it exists. Dockerfile support is listed as experimental, so check parser errors, skipped files and rule applicability in the installed version. [Language support](https://docs.semgrep.dev/supported-languages), [CLI semantics](https://docs.semgrep.dev/cli-reference) |

These complement Hadolint; they do not replace a final-image vulnerability scan. Validate any new/custom rule with a violating fixture and a corrected or out-of-scope fixture. A successful scan of zero applicable files/rules is not evidence of coverage. Missing tools/rules are an explicit validation gap, not a reason to claim a clean result or automatically install every scanner.

## Build and exercise

Use an isolated target and approved build inputs. Record the selected stage, OS/architecture, output identity and actual command exit status. Do not run a debug/builder stage and claim the release image passed. If the builder leaves outputs only in cache, explicitly export/load the intended artifact before testing it.

Exercise the application entrypoint under the intended UID, mounts and writable-path constraints. Test a representative request or worker operation, dependency imports and graceful shutdown. Limit network access and resource consumption to what that test needs, use an elapsed-time deadline, and clean only containers/images created for it. Killing the Docker CLI does not necessarily stop a daemon-managed container: retain the created container ID for bounded cleanup. [Container execution](https://docs.docker.com/engine/containers/run/)

Check at least one cold-cache build when changing dependency/context handling. For a secret-handling fix, test with a synthetic credential marker and inspect the relevant artifact surfaces described in [secret handling](secrets.md). Never deliberately inject a real secret as a negative control.

## Scan and preserve identity

Run the project's vulnerability/secret checks on the final artifact and record scanner/database versions, platform and identity. Separate fixable vulnerabilities, accepted exceptions and missing evidence. Build cache contents, attestations and source history may need separate inspection; a clean final-filesystem scan does not cover them all.

When supply-chain evidence is in scope, preserve SBOM/provenance and verify that the chosen exporter, image store and registry retain them. Merely setting an attestation flag does not establish that evidence survived export. Attestations describe contents and origin; they are not vulnerability clearance or publication authorization. [Docker attestations](https://docs.docker.com/build/metadata/attestations/)
