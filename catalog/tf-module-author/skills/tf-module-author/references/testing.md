# Test module contracts without creating infrastructure

## When applicable

Use when a module exposes optional resources, keyed collections or input constraints that syntax validation cannot verify. Adapt the contract to the real module; do not turn this example's private-only policy into a universal requirement.

## Why it matters

A test can be green because it exercises defaults only, supplies the expected output through a mock, or accepts any failure. Assert what the module must preserve and name the exact validation expected to fail.

## Incorrect pattern

Running `terraform test` on an uninspected suite can execute apply-mode runs. Asserting only that a mocked ID is nonempty proves neither provider compatibility nor correct resource arguments. Catching any nonzero exit hides unrelated failures.

## Runnable example

The [module](example/main.tf) and [test file](example/tests/contracts.tftest.hcl) use the built-in `terraform_data` provider as a stand-in for resource inputs. No downloaded providers, credentials, backend or cloud resources are needed. Every run explicitly uses plan; the mock demonstrates provider replacement, while assertions inspect configured inputs and identities rather than generated IDs.

Copy the entire `example/` directory to a new scratch directory, then run there:

```bash
terraform init -backend=false -input=false
terraform fmt -check -recursive
terraform validate
terraform test -no-color
```

Terraform 1.7+ is required for mocks. Preserve any stricter project version requirement. The cases verify default settings, stable logical keys, disabled resources, invalid replica counts and rejection of public exposure under the example's stated contract. `expect_failures` names the checked variable; unexpected diagnostics still fail the run.

## Transfer to a cloud module

Replace the stand-in with the target provider's real resource schema and mock every provider configuration/alias the test uses. Provider mocks still require the provider plugin/schema to be installed through the approved installation configuration. Review external data sources, provisioners and setup modules; mocking one provider does not isolate the entire suite.

Assert security-relevant arguments, output mappings and optional branches at plan time. Computed fields can remain unknown during plan; use version-supported overrides only when needed, and never inject the very result being asserted. Record what the mock cannot validate: API defaults, IAM, quotas, eventual consistency and runtime health.

## S3-compatible endpoints

Schema validation and mocked providers cannot prove AWS-provider compatibility with another vendor's S3 API. Exercise the selected provider version's actual request serialization when bucket creation fails with a generic 400. An empty HTTP body and an XML `CreateBucketConfiguration` containing an empty location constraint are different requests; an AWS default region does not guarantee identical wire behavior across provider versions.

For a local regression fixture, use a loopback endpoint, dummy credentials, an isolated backend-free directory and only the provider features needed for the failing request. Capture only the relevant method, path and body; return a deliberate failure after that request so the fixture does not emulate successful infrastructure creation or continue into unrelated calls. Keep real credentials and provider trace logs out of the fixture. Test the request invariant, rather than hardcoding the supposedly safe provider version in the assertion.

When a provider regression is established, constrain the affected root/module and lock its provider selection; retain signed package verification. Record why the version is constrained and the request-level check required to remove the constraint. A loopback test proves serialization only. After an authorized cloud apply, verify bucket ownership, access policy, retention/versioning and an empty follow-up plan.

## Verify the tests themselves

In a disposable copy, remove one input validation or change an expected resource key. The relevant test must fail. Restore the original and rerun. For identity-preserving refactors, add state-aware migration/plan checks through the project's authorized runner; this no-state example cannot prove an existing deployment avoids replacement.

Sources: [Terraform tests](https://developer.hashicorp.com/terraform/language/tests), [provider mocking](https://developer.hashicorp.com/terraform/language/tests/mocking). Topic inspiration: [HashiCorp terraform-test](https://skills.sh/hashicorp/agent-skills/terraform-test); this example is independently written.
