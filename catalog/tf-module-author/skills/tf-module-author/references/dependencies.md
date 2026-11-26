# Scope dependencies to the actual contract

## When applicable

Use when module changes defer unrelated data reads or make a plan unexpectedly conservative. Read provider schemas and the module interface before editing dependency edges.

## Why it matters

A module-wide dependency orders all operations in the dependent module against the other module. An attribute reference expresses a narrower relationship when the consumer only needs that value. Hidden behavioral prerequisites still require explicit ordering.

## Incorrect for a value-only dependency

This synthetic example assumes the service needs only the network module's subnet ID:

```hcl
module "service" {
  source     = "./modules/service"
  subnet_id  = module.network.subnet_id
  depends_on = [module.network]
}
```

The extra edge couples unrelated network resources to service planning.

## Corrected expression

```hcl
module "service" {
  source    = "./modules/service"
  subnet_id = module.network.subnet_id
}
```

Do not remove an explicit edge when it represents a real prerequisite absent from the value reference, such as a permission attachment required before an operation. Identify the narrow resource/output contract that carries that requirement and explain the non-obvious ordering there.

## Verify and account for side effects

Validate a representative root with the project's selected providers. Compare plans after changing the actual subnet dependency and after changing an unrelated network resource. The service must still depend on the former without unnecessarily deferring reads for the latter. Inspect replacement paths and unknown values; fewer diff lines are not proof of a correct dependency graph.

A plan or provider mock does not prove readiness of an eventually consistent remote service. Preserve the provider's documented readiness behavior and test it through the authorized rollout process when needed. This reference does not authorize apply or state changes.

Source: [Terraform depends_on behavior](https://developer.hashicorp.com/terraform/language/meta-arguments/depends_on).
