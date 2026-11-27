# Cloud.ru Evolution provider profile

Use for `cloudru_evolution_*` resources. Match provider source, release, schema and API behavior; a valid schema alone cannot prove service prerequisites or a successful Read implementation.

## Establish the selected installation

1. Inspect source addresses in configuration, lockfile and state metadata. Cloud.ru's quickstart shows `cloudru/cloud` for its mirror installation and `cloud.ru/cloudru/cloud` in its manual-installation example. These are distinct Terraform provider identities: do not silently replace one with the other or infer interchangeability from the binary name. Select the release supported by the target project.
2. Follow the existing project's installation path and verify the chosen release/checksums. Prefer an isolated project CLI configuration when diagnosing installation; do not replace the user's global configuration or introduce `dev_overrides` as a production default.
3. Confirm project, region, service-account identity, endpoint configuration and needed product permissions. Provider authentication success does not establish workload service-account roles or data-plane access. Resolve role identifiers from current IAM documentation/API instead of granting an inherited list of admin roles.

Sources: [official quickstart](https://cloud.ru/docs/terraform-evolution/ug/topics/quickstart), [official release artifacts](https://github.com/cloud-ru/evo-terraform/releases), [1.x to 2.x migration guide](https://cloud.ru/docs/terraform-evolution/ug/topics/guides/migration). Migration instructions are operational guidance to adapt and review, not permission to rewrite state.

## Inspect schema and service prerequisites

After authorized local initialization, save `terraform providers schema -json` locally. Select the actual provider key, resource/data-source name, attribute flags and nested blocks. Use current resource docs and API contracts to resolve enum values, one-of constraints, import IDs and defaults not expressed by the schema. Do not treat strings found in a provider binary as a supported API contract.

- **Subnets:** current docs expose `dns_servers` as an object containing `value`, rather than a bare list: `dns_servers = { value = var.dns_server_addresses }`. Confirm routable resolvers, private-zone resolution, default-subnet requirements and ordering for the selected project. A schema-optional DNS field does not establish usable workload DNS. See [subnet schema](https://cloud.ru/docs/terraform-evolution/ug/topics/reference/resources/cloudru_evolution_compute_subnet).
- **Managed Kubernetes:** verify subnet DNS, service-account permissions, supported CNI configuration and node flavors from the selected release/API. Select explicit suitable flavors rather than the first matching CPU/RAM result. Inspect addon and kubeconfig data sources/resources in the [provider catalog](https://cloud.ru/docs/terraform-evolution/ug/doc-contents) and selected release's schema before deciding whether an operation needs a separate API workflow.
- **Object Storage:** distinguish S3-compatible endpoint behavior from the provider's management/user-plane API requirements. Check quota units, lifecycle filters, CORS and endpoint fields against the selected resource version. Do not add a permissive CORS rule or deletion policy merely to avoid a read failure.

## Version-specific diagnostic leads

These are upstream reports, not locally reproduced fixes. Check their current status, affected version and linked release before using them:

| Reported version | Symptom and engineering consequence | Primary report |
|---|---|---|
| 2.1.4 | Minimal OBS bucket creation leaves quota-related values unknown after apply. Verify explicit supported quota fields and management endpoint behavior before selecting a workaround; an apply error can still leave a live bucket. | [#45](https://github.com/cloud-ru/evo-terraform/issues/45) |
| 2.1.3 | PostgreSQL user `granted_roles` has create/update consistency errors. Review partial state and the actual user before another mutation; do not weaken privileges to make a plan pass. | [#44](https://github.com/cloud-ru/evo-terraform/issues/44) |
| 2.1.0 | External-IP removal is reported to cascade to its attached VM. Review the live attachment and replacement/deletion blast radius even when the plan only highlights the IP. | [#39](https://github.com/cloud-ru/evo-terraform/issues/39) |

Preserve a concrete versioned reproduction before carrying a workaround into a module. Verify CORS, quota and endpoint requirements against that release rather than adding fields solely because another version needed them.

## Partial apply or provider panic

Record versions, resource address, API operation and sanitized error; compare state address metadata and approved read-only cloud observations. Separate physically created objects from recorded state and replacement/taint markers. Keep any trace logs restricted because they may contain authentication and payloads; normal sanitized diagnostics are preferable.

Prepare the matching configuration/provider fix, import or repair proposal in the owning repository and review a fresh normal plan. Do not automatically untaint, remove state, disable refresh for apply, or add broad `ignore_changes`; each can hide an unresolved live/state mismatch. See [upstream issues](https://github.com/cloud-ru/evo-terraform/issues) and the project's recovery procedure.
