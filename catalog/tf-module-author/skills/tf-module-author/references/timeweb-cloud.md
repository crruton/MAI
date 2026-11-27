# Timeweb Cloud provider profile

Use for `twc_*` resources. Verify the selected release and installed schema rather than carrying forward a “latest” version from an example.

## Provider and target

1. Read existing `required_providers`, root lockfile, aliases and installation configuration. Current provider-authored examples use `tf.timeweb.cloud/timeweb-cloud/timeweb-cloud`; existing projects and older examples may use `timeweb-cloud/timeweb-cloud` through Terraform Registry. Source hostnames identify distinct providers for Terraform; changing that address requires a deliberate migration, not a cosmetic edit.
2. Establish account/project, location/availability zone, network and credential scope for each resource. Keep provider configuration in the root and pass required identities into reusable modules.
3. Use the project's approved token injection mechanism; the provider supports `TWC_TOKEN`. Do not print the token, commit it in a provider block, or loosen account security settings just because a tutorial assumes a different authorization setup.

Sources: [Timeweb Terraform documentation](https://timeweb.cloud/docs/terraform), [provider-authored usage and authentication](https://github.com/timeweb-cloud/terraform-provider-timeweb-cloud), [published provider documentation](https://registry.terraform.io/providers/timeweb-cloud/timeweb-cloud/latest/docs).

## Module decisions

- Discover supported configurators/presets, images and locations with appropriately filtered data sources or current API documentation. Confirm units and field types from the exact schema; do not infer GiB/MB from a tutorial's arithmetic or numeric IDs from display strings.
- Represent network attachment, routing/NAT, firewall ownership and public addresses explicitly. Check that selected services support the same location/network combination before promising private connectivity.
- Define whether an image/preset lookup is intended to track future changes or resolve an immutable choice. Avoid selecting an arbitrary first match from a changing catalog.
- For managed databases and Kubernetes, check resource-specific import support, version availability, backup/deletion behavior and service permissions. The API may support an operation that the selected Terraform provider does not expose.
- Keep disk resize, image replacement and network moves visible in the module contract. Plan actions and service API behavior both matter; a syntactically accepted field does not establish an in-place change.

## Version-specific diagnostic lead

[Issue #35](https://github.com/timeweb-cloud/terraform-provider-timeweb-cloud/issues/35) reports provider **1.6.13** creating a `twc_router` attached to Kubernetes, then failing to decode the API response before recording its ID. The report also describes import limitations for that version. It is not evidence that all later releases are affected.

If this symptom matches, inspect the selected release and actual routers through approved read-only access before another create attempt. Establish whether an object exists outside state; repeated apply can create duplicates. Prepare a verified provider fix/upgrade or recovery proposal under the project's authority rather than guessing import support or removing more state.

For other failures, search [upstream issues](https://github.com/timeweb-cloud/terraform-provider-timeweb-cloud/issues) by resource, error and exact version. Record the tested workaround and remove it only after a clean normal plan and relevant service checks establish the desired behavior.

## Evidence before delivery

Record provider source/version, account/project/location selection, preset/image resolution, units, network assumptions and unverified service capabilities. Local validation does not establish API compatibility, quota or billing; target plans and runtime checks use the project's approved runner and test environment.
