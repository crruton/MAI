---
name: tf-module-author
description: Author or refactor Terraform modules, typed interfaces, provider wiring, and import or moved blocks. Use for infrastructure code changes; use tf-plan-review for evaluating a plan and tf-drift-check for unexplained divergence.
version: 1.0.0
owner: crruton
---

# Terraform module author

Produce a focused module or root configuration diff, representative usage, and validation evidence. Establish the owning repository, target and change owner from project instructions and configuration; use its existing runner, backend and release workflow.

## Execution boundary

Check test run operations, providers, external programs and provisioners before execution. Module authoring does not authorize apply/destroy, replacement or state/backend migration.

## Establish the contract

1. Read callers, existing addresses, Terraform version, provider constraints and `.terraform.lock.hcl`. Distinguish a reusable child module from a deployable root; do not copy one environment's backend or credentials into a child.
2. Identify resource ownership, failure domains, availability, data retention and network boundaries. Decide whether each dependency is created here or supplied as an ID; avoid a module that both looks up and owns the same object implicitly.
3. For an existing module, preserve defaults and resource addresses unless migration is intentional. Record callers affected by a changed type, default, output or provider alias.
4. Load only the matching provider profile: [Yandex Cloud](references/yandex-cloud.md), [Cloud.ru Evolution](references/cloudru-evolution.md), or [Timeweb Cloud](references/timeweb-cloud.md). For another provider, inspect the selected version's own documentation and schema.

When selecting a VM image, inspect the cloud's existing image/template catalog first. Verify the chosen image's OS, architecture and preinstalled drivers against the requested contract. Downloading or uploading an image requires a concrete gap in that catalog.

## Implement deliberately

- Define narrow typed inputs, descriptions, meaningful defaults, validation for real constraints, and outputs needed by callers. Specify the meaning of omitted, `null`, empty and disabled values; do not make arbitrary resource limits look like platform requirements.
- Prefer maps keyed by stable logical identity for independently managed collections. `count` is appropriate for genuinely positional or single optional resources; changing collection order must not accidentally replace identities.
- Declare provider source and compatible constraints in every module. Configure providers, authentication and backends in the root; pass aliases explicitly and declare `configuration_aliases` in the child where needed.
- Keep root dependency selections reproducible with its lockfile. A child module's lockfile does not lock versions for its consumers. Choose constraints from tested compatibility rather than copying a supposed latest version.
- Let references establish dependencies. Use `depends_on` for an actual hidden ordering requirement, not to silence unknown values; broad module dependencies can defer data reads and cause noisy plans.
- When dependency scope causes unexpected unknowns or deferred reads, use [dependency scope examples](references/dependencies.md).
- Prefer separate focused modules and explicit composition over deeply nested optional blocks. Preserve the target cloud's capabilities instead of presenting incompatible services as an interchangeable abstraction.
- Supply secret references or approved runtime credentials; `sensitive = true` hides display but does not encrypt state. Avoid secret-bearing example tfvars, generated plans and provider debug logs in the diff.

## Refactors and adoption

1. For address-only refactors, put `moved` blocks in the owning configuration and document the minimum supported Terraform version. Account for existing instances and map keys; removing a move too early breaks older consumers.
2. For adopting existing resources, prepare `import` blocks when supported by the selected version. Verify the exact resource-specific import ID and configuration; an API ID and Terraform import ID can differ.
3. Review adoption and refactor plans for updates and replacements as well as creates/deletes. An import followed by replacement is not successful adoption. Resolve differences before the project's authorized state/apply process.
4. Treat backend migrations, state removal and state repair as separate operational changes. Do not use state surgery to make an unexplained plan disappear.

## Validate from cheapest to strongest

In a local checkout or isolated copy with the approved provider installation configuration:

```bash
terraform fmt -check -recursive
terraform init -backend=false
terraform validate
terraform providers schema -json > provider-schema.json
```

`init -backend=false` installs local dependencies without configuring the backend; it does not make subsequent commands a sandbox. Do not change the user's global CLI configuration to obtain a provider. Keep generated schema output outside the delivered diff.

- Run the repository's configured TFLint and policy checks. Validate representative callers, including optional resources disabled and non-default collection sizes.
- Add focused plan assertions when they test a meaningful invariant such as stable keys, denied public access or invalid input rejection. Inspect all test runs before `terraform test`: its default run operation is **apply**. Use explicit `command = plan` or supported provider mocks for local tests; mocks cannot establish cloud API compatibility.
- For a runnable plan/mock/expected-failure pattern, read [module test examples](references/testing.md). Keep provider API acceptance separate from mocked contract checks.
- Obtain a target plan through the authorized project runner and review resource actions, replacement paths, dependent resources, data-loss risk, permission/network exposure, cost and recovery limits. Offline validate proves syntax/schema consistency, not quota, IAM, availability or runtime service health.

## Deliver

State what the module owns, required inputs, supported versions, compatibility/migration impact, checks run and checks unavailable. If a target plan is unavailable, mark that gap rather than calling the module deployment-ready. After an authorized rollout, verify service behavior and an empty follow-up plan.

Sources: [provider wiring](https://developer.hashicorp.com/terraform/language/modules/develop/providers), [dependency lockfile](https://developer.hashicorp.com/terraform/language/files/dependency-lock), [module refactoring](https://developer.hashicorp.com/terraform/language/modules/develop/refactoring), [Terraform tests](https://developer.hashicorp.com/terraform/language/tests).
