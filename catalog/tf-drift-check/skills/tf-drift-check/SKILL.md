---
name: tf-drift-check
description: Diagnose Terraform drift between configuration, saved state, and live infrastructure; distinguish external changes from code or provider changes and prepare a reconciliation. Use for unexpected plans, missing resources, or partial-apply recovery.
version: 1.0.0
owner: crruton
---

# Terraform drift check

Produce an explanation of divergence with a reconciliation diff or operational proposal. Confirm the owning root, target, backend, authorized runner and change owner before attributing differences to drift.

## Execution boundary

Refresh, import, state rm/mv/push, force-unlock, untaint and backend migration change operational state; prepare a recovery proposal instead of executing them to clear drift.

## Compare the right three things

1. Record the deployed commit and variable inputs, current working commit, selected provider versions, workspace/state key and cloud identity. A different root, empty backend, renamed address or upgraded provider can look like remote deletion.
2. Read the latest successful run, any failed/partial run and approved emergency changes. A failed apply can leave real resources created, changed or missing from state; do not interpret failure as a rollback.
3. Inspect relevant configuration and state **metadata** on the authorized runner. Avoid putting raw state, secret outputs or provider trace logs into chat. Use only the needed addresses and redacted attribute differences.
4. Rule out authorization, wrong region, API unavailability and provider read bugs before declaring a resource deleted. A 403 or provider panic is not proof of absence.

## Obtain evidence without reconciling state

Use the existing project planning process. Where a CLI run is authorized, capture a restricted artifact and sanitized output:

```bash
terraform plan -refresh-only -detailed-exitcode -out=drift.tfplan
```

Capture the exit status directly: `0` means no differences, `2` means differences, `1` means failure. Account for shell `errexit` and pipelines so code `2` is not mistaken for failure and a failed plan is not reported as clean. Plan may take backend locks and read cloud APIs; it does not persist a refreshed state until applied.

Then obtain a **normal** plan with the same revision and inputs to see what Terraform would do to enforce the configuration. Do not use `terraform refresh` as diagnosis: it writes refreshed state. Do not apply a refresh-only plan merely to acknowledge an alert.

For a local first-pass inventory, the authorized runner can project addresses/actions without values:

```bash
terraform show -json drift.tfplan | jq '{
  drift: [.resource_drift[]? | {address, actions: .change.actions}],
  changed_outputs: ((.output_changes // {}) | keys)
}'
```

Review projected identifiers before sharing; this projection alone cannot explain changed attributes or prove no drift. Inspect the protected plan's relevant attribute differences and errors locally. Older producers may omit fields; an absent array is not proof of no remote change. Review the actual actions, replacement paths, dependent resources, data-loss risk, permission/network exposure and recovery limits before proposing reconciliation.

## Choose reconciliation by cause

| Evidence | Interpretation and next change |
|---|---|
| Live change is unauthorized or accidental | Prepare a normal plan restoring declared intent; check whether restoration replaces data or interrupts service. |
| Live change is desired | Update configuration to match the intended change, then review the normal plan. Refresh-only acceptance does not change configuration. |
| Resource exists but association is missing/wrong | Verify ownership, exact import ID and address; prepare supported import/moved blocks in the owning root. Avoid creating a duplicate. |
| Resource is absent in a confirmed target | Decide whether to recreate it, remove its declaration, or recover data. A recreation plan does not imply data recovery. |
| Provider normalization/schema change or read failure | Compare versions, release notes and a matching issue; isolate a minimal non-production reproduction. Do not hide an unexplained diff with broad `ignore_changes`. |
| Another controller intentionally owns an attribute | Document the ownership boundary and narrowly scope any `ignore_changes`; prove Terraform still controls the intended attributes. |

State repair, unlocking, untainting and backend migration need the project's operational procedure, evidence and recovery safeguards. Prepare that proposal when necessary; avoid using state removal or `-refresh=false` apply as a generic repair for an unhealthy provider.

## Close the check

Report target/revision, time window, affected addresses and attribute names, likely actor/cause, confidence, and the chosen reconciliation. After authorized reconciliation, repeat a normal plan with the deployed inputs and verify service health. A clean plan covers Terraform-managed observations; it does not establish application health or detect every unmanaged resource.

Sources: [planning and refresh-only semantics](https://developer.hashicorp.com/terraform/cli/commands/plan), [drift JSON](https://developer.hashicorp.com/terraform/internals/json-format), [why refresh is state-changing](https://developer.hashicorp.com/terraform/cli/commands/refresh).
