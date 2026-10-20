variable "cloud_provider" {
  description = "Pending ADR-0002. The modules in this repo currently implement 'aws' only; any other value fails validation so nobody applies a half-translated stack."
  type        = string
  default     = "aws"

  validation {
    condition     = var.cloud_provider == "aws"
    error_message = "Only 'aws' is implemented. Choosing another provider needs ADR-0002 Accepted and new module internals."
  }
}

variable "region" {
  description = "Primary region. REQUIRED, deliberately no default: it is decided by ADR-0002 (data residency)."
  type        = string
}

variable "edge_region" {
  description = "Region for CloudFront-scoped resources (WAF). AWS requires us-east-1 for that scope; it holds no personal data."
  type        = string
  default     = "us-east-1"
}

variable "github_repository" {
  description = "owner/repo allowed to deploy through OIDC."
  type        = string
}

variable "create_github_oidc_provider" {
  description = "Only one environment per account should create the provider."
  type        = bool
  default     = true
}

variable "existing_github_oidc_provider_arn" {
  type    = string
  default = null
}
