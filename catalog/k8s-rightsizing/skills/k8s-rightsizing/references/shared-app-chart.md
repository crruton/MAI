# Legacy shared app chart profile

Use only when repository instructions or the pinned chart establish this profile.
Verify keys in that version before editing; this is not a generic Helm contract.

- Application values may live in `.helm/values-<env>.yaml`.
- Container resources use `resources`; migration hooks may use a separate `preHook.resources`.
- Replica count may use `replicas`, not `replicaCount`.
- Some versions omit `resources` from defaults while templates still consume it.
  Render the effective environment values and inspect admission defaults before
  concluding that a workload has no requests or limits.

A values-only correction belongs in the application's values. A missing template
capability belongs in the chart owner. Preserve the release's actual source path.
