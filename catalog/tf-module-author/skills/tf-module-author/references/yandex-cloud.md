# Yandex Cloud provider profile

Use for `yandex_*` resources. Verify the repository's selected version before adopting a workaround. An issue report is evidence about its reproduction, not a guarantee about every later release.

## Target and provider identity

1. Read `required_providers`, the root lockfile and existing provider aliases. The documented provider source is `yandex-cloud/yandex`; installation mirrors do not inherently change that identity. Preserve the project's approved mirror configuration and checksums rather than replacing global `.terraformrc`.
2. Confirm organization/cloud/folder and zones, then how each resource selects its folder. A default provider folder does not establish the destination of a resource with an explicit override or a passed alias.
3. Use the project's service-account/federated credential mechanism. Keep credential material out of HCL, tfvars examples, plans shared for review and diagnostic output. Separate Terraform control-plane access from workload identities and Object Storage data-plane access.

Sources: [Yandex quickstart](https://yandex.cloud/en/docs/tutorials/infrastructure-management/terraform-quickstart), [provider documentation](https://terraform-provider.yandexcloud.net/), [provider source/releases](https://github.com/yandex-cloud/terraform-provider-yandex).

## Module decisions

- Choose regions/zones, CIDRs, routing, NAT, security rules and DNS from the target topology. Confirm database/Kubernetes versions, quota and instance availability with the actual service; do not paste a tutorial's zone, image or size as a reusable default.
- Make service accounts, storage credentials and network dependencies explicit. Check the exact IAM resource's ownership semantics before managing a binding or policy; two roots must not compete over the same role's member list.
- For images, presets and managed-service capabilities, use a stable explicit choice or a suitably constrained data source. A changing image family can trigger a new deployment; document that update policy.
- Validate backup/retention, deletion protection and public endpoint settings independently of a successful plan. Imported databases and managed clusters need configuration matching the desired live behavior, not only a valid import address.

## Version-specific failure leads

[Issue #633](https://github.com/yandex-cloud/terraform-provider-yandex/issues/633) reproduces IAM-grant import IDs differing from state `id` on provider **0.219.0**, Terraform **1.14**. The report explicitly did not retest its then-newer provider version. For affected grant resources, verify that version's documented import syntax; do not blindly copy the saved `id` or generalize its delimiter to all Yandex resources.

For repeated diffs or API errors, record selected provider/Terraform versions and the exact resource. Compare the installed schema, resource docs and [matching upstream issues](https://github.com/yandex-cloud/terraform-provider-yandex/issues). Reproduce any proposed fix in a permitted test target and confirm a clean normal plan; `ignore_changes` is an ownership decision, not a general provider-bug remedy.

## Evidence before delivery

Record cloud/folder/zone selection, provider source/version, relevant capability assumptions and any issue/workaround with the tested version. Format/validate and schema inspection can run locally; target IAM, quotas, price and service health remain unverified until checked against the actual environment.
