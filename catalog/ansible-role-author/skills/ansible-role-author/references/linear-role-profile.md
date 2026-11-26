# Optional linear-role house style

Apply only when the user or target repository explicitly selects this profile. These are house conventions, not Ansible's universal requirements. Preserve another repository's chosen FQCN, collection, variable and tag conventions.

## Naming and layout

Use one stable role name or documented abbreviation in snake_case prefixes:

| Declaration | Prefix | Purpose |
|---|---|---|
| `defaults/main.yml` | `<role>_` | Public overridable inputs |
| `vars/main.yml` | `<role>__` | Higher-precedence internal values |
| Task vars, `set_fact`, custom loop variable | `_<role>_` | Task/runtime internals |
| `register` | `__<role>_` | Module result |

These prefixes communicate intent; they do not enforce scope or read-only access. Role vars can be overridden by higher-precedence inputs. Restrict `set_fact` to genuinely runtime-derived values.

Include tasks, defaults and `meta/argument_specs.yml`; add handlers, templates, files and metadata/dependencies where used. Put required inputs in the argument specification without fabricated defaults. Keep actual optional defaults in `defaults/` and matching documentation in the spec. Use collections when that is the repository's packaging convention.

## Task conventions

- Prefer a readable top-to-bottom flow; avoid nested dynamic includes and loops over loop results when simple tasks express the dependency. A coherent OS-specific import is still appropriate when needed.
- Put `when` immediately after `name`; use scalar expressions for single conditions and avoid one-item loops “for future use.” Use `true`/`false` and quoted file modes.
- Use short builtin module names and FQCN for collection modules; use FQCN inside `module_defaults`. Configure only the relevant lint exceptions locally; do not disable unrelated rules to satisfy this style.
- Do not add production task tags under this profile; existing tag-based APIs require an explicit migration. Host selection belongs in playbooks, while delegation targets and dependencies enter the role as documented inputs.
- For enable/disable behavior, use a parameterized `state` when it remains clear, with `omit` for arguments irrelevant to the absent state. Avoid deleting data on disable unless that is the declared contract.
- Serialize structured YAML/JSON data rather than constructing it with Jinja control flow. Keep ordinary service text templates where the file format needs them.

## Semantic boundaries

- YAML `null`, `~` and `!!null` can represent null; the bare word `None` is a string. This profile may choose `!!null` for consistency. Test presence with `is defined`, null with `is none`, and semantic validity with the appropriate condition. `truthy`/`falsy` intentionally collapse valid values such as `false`, `0` and empty containers; they are not a universal required-input test.
- Judge idempotency by repeat failures, destructive repeats, unnecessary expensive work and false change reporting; also detect actual changes hidden behind `changed_when: false`.
- `block`/`rescue` supports controlled error handling, not automatic rollback. Cleanup must distinguish newly created artifacts from existing data and must itself be safe to repeat.
- Local facts in `/etc/ansible/facts.d/` can expose a documented, non-secret host-state contract. Create the directory, serialize valid JSON/INI, and refresh facts when a later task needs newly written values; writing a file does not update `ansible_local` in memory automatically. Do not use facts as an unversioned substitute for explicit role inputs.

Validate using the repository's checks and a real second converge on an authorized disposable host. Adopting this profile does not require an external convention checker.

Sources for actual Ansible semantics: [role argument defaults](https://docs.ansible.com/projects/ansible/latest/playbook_guide/playbooks_reuse_roles.html), [variable precedence](https://docs.ansible.com/projects/ansible/latest/playbook_guide/playbooks_variables.html), [local facts](https://docs.ansible.com/projects/ansible/latest/playbook_guide/playbooks_vars_facts.html#facts-d-or-local-facts).
