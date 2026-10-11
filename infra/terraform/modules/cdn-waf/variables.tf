variable "name" {
  type = string
}

variable "origin_domain_name" {
  description = "Load balancer or bucket domain name serving as origin."
  type        = string
}

variable "origin_is_s3" {
  description = "True when the origin is an S3 bucket (uses origin access control)."
  type        = bool
  default     = false
}

variable "aliases" {
  description = "Custom domain names. Empty in dev. Requires acm_certificate_arn (us-east-1)."
  type        = list(string)
  default     = []
}

variable "acm_certificate_arn" {
  type    = string
  default = null
}

variable "rate_limit_per_5_minutes" {
  description = "Per-IP request cap at the edge. Tune with load tests; this is a starting value, not a verified figure."
  type        = number
  default     = 2000
}

variable "tags" {
  type    = map(string)
  default = {}
}
