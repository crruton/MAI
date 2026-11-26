mock_provider "terraform" {}

run "private_defaults" {
  command = plan

  assert {
    condition = (
      keys(output.service_settings) == ["api"] &&
      output.service_settings["api"].replicas == 2 &&
      !output.service_settings["api"].public
    )
    error_message = "Defaults must retain the private API contract and replica count."
  }
}

run "stable_logical_keys" {
  command = plan
  variables {
    services = {
      worker = { replicas = 3 }
      api    = {}
    }
  }

  assert {
    condition = (
      keys(terraform_data.service) == ["api", "worker"] &&
      output.service_settings["worker"].replicas == 3 &&
      output.service_settings["api"].replicas == 2
    )
    error_message = "Collection changes must retain logical addresses and per-service settings."
  }
}

run "disabled_service" {
  command = plan
  variables {
    services = { api = { enabled = false } }
  }

  assert {
    condition     = length(terraform_data.service) == 0 && length(output.service_settings) == 0
    error_message = "Disabled services must not produce resources or exposed settings."
  }
}

run "reject_fractional_replicas" {
  command = plan
  variables {
    services = { api = { replicas = 1.5 } }
  }
  expect_failures = [var.services]
}

run "reject_zero_replicas" {
  command = plan
  variables {
    services = { api = { replicas = 0 } }
  }
  expect_failures = [var.services]
}

run "reject_public_service" {
  command = plan
  variables {
    services = { api = { public = true } }
  }
  expect_failures = [var.services]
}
