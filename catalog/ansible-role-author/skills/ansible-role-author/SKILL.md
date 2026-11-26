---
name: ansible-role-author
description: Create, refactor, or review Ansible roles with explicit inputs, reliable change reporting, restart behavior, and repeat-run validation. Use for role tasks, defaults, handlers, argument specs, templates, or idempotency failures.
version: 1.0.0
owner: crruton
---

# Ansible role author

Deliver a role diff with its input contract, supported targets and validation evidence. Establish the owning repository, target environment, execution context, change owner and authorized workflow from project instructions and configuration. Reuse known facts; ask only for missing information that changes the action. Identify the target inventory and rollout process.

## Execution boundary

Inspect included roles, handlers, delegation and check_mode overrides before execution. Do not treat check mode as proof that repartitioning, state: absent, credential changes or service restarts cannot run.

## Preserve the project's contract

1. Read the role's callers, Ansible/collection versions, lint configuration and supported OS matrix. Keep established collection/standalone packaging, FQCN style and tag behavior unless changing them is part of the task.
2. Define a focused responsibility and typed, namespaced public inputs. Keep overridable values in `defaults/`; use `vars/` deliberately for higher-precedence values. No variable prefix makes a value immutable, and extra vars can override role vars.
3. Add `meta/argument_specs.yml` for a new reusable role's public entry points when the supported Ansible version supports role validation. Match types and choices to real inputs; defaults in the spec document defaults, while actual values come from `defaults/main.yml`.
4. Keep genuinely required inputs without a dummy default; add semantic assertions for nonempty strings, valid ranges and interdependent inputs. A supplied empty string can satisfy presence validation. Test valid `false` and `0` values explicitly rather than treating all falsy values as missing.
5. When the user or repository selects the linear-role house style, load [the opt-in profile](references/linear-role-profile.md). Do not impose its naming, no-tags or short-builtin preferences on unrelated projects.

## Implement predictable convergence

- Prefer state-aware modules over shell/command. For commands, define success/failure and real changed conditions; use `creates`/`removes` only when that path reliably represents completion. Read-only observations use `changed_when: false`; real mutations must not falsely report unchanged.
- Keep task flow understandable. Extract coherent platform-specific files or reuse roles when that clarifies behavior; avoid nested includes that obscure ordering. `set_fact` persists runtime host variables and can affect subsequent roles, so prefer ordinary variables for static expressions.
- Pass dependencies and delegation targets explicitly. Keep host selection in the playbook; avoid hardcoded inventory group names or cross-role internals. Declare required role/collection dependencies rather than relying on a previous undocumented play.
- Serialize YAML/JSON data with `to_nice_yaml`/`to_nice_json` when possible; use Jinja templates for text or formats requiring them. Quote file modes and set ownership deliberately. Avoid timestamp-dependent desired state.
- Validate candidate service configuration before replacement where the module/service supports it. Notify a handler only on a relevant change; choose reload vs restart according to service behavior. Use `meta: flush_handlers` only when a subsequent task needs the new configuration.
- Protect secret-bearing tasks with appropriate `no_log`/`diff: false`; check that error output, labels and assertions do not expose values. Do not make a secret value part of a task name.
- Design restart after partial failure: each step rechecks actual state. `rescue` is not a transaction or automatic rollback; do not delete pre-existing data during cleanup. Storage repartitioning and credential changes need explicit preconditions and a recovery procedure.

For RKE2 installation, CNI bootstrap, exported kubeconfigs or cluster DNS failures, read [RKE2 bootstrap checks](references/rke2-bootstrap.md) before a live convergence.

## Validate behavior, not just syntax

Local checks use the project's execution environment and sanitized fixture inventory:

```bash
ansible-playbook -i tests/inventory.yml tests/converge.yml --syntax-check
ansible-lint .
```

Only show these paths as commands when the fixtures exist; otherwise create minimal appropriate fixtures or use the repository's equivalents. Do not expose resolved inventory variables in a diagnostic dump.

1. Inspect task behavior before running `--check --diff` on any shared target. Check mode is a simulation, unsupported modules can skip, registered values may be missing, and `check_mode: false` can execute a real mutation. Diff can disclose secrets.
2. On an authorized disposable VM/container, run the real role, verify service/configuration behavior, then run it again with identical inputs. Expect no unexplained `changed` on the second run; a check-mode run alone cannot establish idempotency.
3. Review four failure modes: repeat-run errors, destructive repeat actions, unnecessary expensive work, and false change reporting. Also detect hidden changes masked with `changed_when: false`.
4. Exercise relevant non-default inputs, supported OS differences, invalid input rejection and handler behavior. A container lacking systemd cannot prove systemd restart behavior; use an appropriate VM when required.
5. For a risky multi-step workflow, test recovery from an interrupted run on the disposable target. Preserve data and access invariants, not merely a green task recap.

## Deliver

Explain inputs and defaults, dependencies, target compatibility, reload/restart impact, checks run and any missing runtime coverage. Put shared-host configuration and rollout/recovery changes in the owning repository under its existing authority; do not infer deployment permission from successful lint.

Sources: [roles and argument validation](https://docs.ansible.com/projects/ansible/latest/playbook_guide/playbooks_reuse_roles.html), [check and diff limitations](https://docs.ansible.com/projects/ansible/latest/playbook_guide/playbooks_checkmode.html), [variable precedence](https://docs.ansible.com/projects/ansible/latest/playbook_guide/playbooks_variables.html).
