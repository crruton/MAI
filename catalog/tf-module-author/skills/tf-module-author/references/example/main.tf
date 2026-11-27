terraform {
  required_version = ">= 1.7.0, < 2.0.0"
}

variable "services" {
  description = "Private service contracts keyed by stable logical identity."
  type = map(object({
    replicas = optional(number, 2)
    public   = optional(bool, false)
    enabled  = optional(bool, true)
  }))
  default = { api = {} }

  validation {
    condition = alltrue([
      for service in values(var.services) :
      service.replicas >= 1 && service.replicas == floor(service.replicas)
    ])
    error_message = "Replica counts must be positive integers."
  }

  validation {
    condition     = alltrue([for service in values(var.services) : !service.public])
    error_message = "This private-only module does not accept public services."
  }
}

resource "terraform_data" "service" {
  for_each = { for name, service in var.services : name => service if service.enabled }
  input    = each.value
}

output "service_settings" {
  description = "Configured inputs indexed by the caller's logical service keys."
  value       = { for name, service in terraform_data.service : name => service.input }
}
