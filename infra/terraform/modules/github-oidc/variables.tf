variable "name" {
  type = string
}

variable "github_repository" {
  description = "owner/repo that may assume the role."
  type        = string
}

variable "allowed_subjects" {
  description = <<-EOT
    OIDC subject claims allowed to assume the role, for example
    ["repo:owner/repo:environment:staging"] or ["repo:owner/repo:ref:refs/heads/main"].
    Never use a wildcard repo. Prefer GitHub Environments so approvals gate production.
  EOT
  type        = list(string)

  validation {
    condition     = length(var.allowed_subjects) > 0 && alltrue([for s in var.allowed_subjects : !can(regex("^repo:\\*", s))])
    error_message = "allowed_subjects must be non-empty and must not wildcard the repository."
  }
}

variable "policy_json" {
  description = "Least-privilege IAM policy document for what CI may do in this environment."
  type        = string
}

variable "create_provider" {
  description = "Create the account-wide GitHub OIDC provider. Only one environment per account should set this."
  type        = bool
  default     = true
}

variable "existing_provider_arn" {
  type    = string
  default = null
}

variable "tags" {
  type    = map(string)
  default = {}
}
