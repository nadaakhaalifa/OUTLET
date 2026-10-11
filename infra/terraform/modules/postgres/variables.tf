variable "name" {
  type = string
}

variable "vpc_id" {
  type = string
}

variable "subnet_ids" {
  description = "Private subnet ids."
  type        = list(string)
}

variable "allowed_security_group_ids" {
  description = "Security groups (compute) allowed to reach Postgres on 5432."
  type        = list(string)
  default     = []
}

variable "kms_key_arn" {
  type = string
}

variable "engine_version" {
  description = "Postgres major version. VERIFY BEFORE LAUNCH against the provider's supported list."
  type        = string
  default     = "17"
}

variable "instance_class" {
  type    = string
  default = "db.t4g.medium"
}

variable "allocated_storage_gb" {
  type    = number
  default = 50
}

variable "multi_az" {
  type    = bool
  default = false
}

variable "backup_retention_days" {
  description = "Point-in-time recovery window. RPO <= 15 min (T9) needs continuous PITR, so never 0."
  type        = number
  default     = 7

  validation {
    condition     = var.backup_retention_days >= 1
    error_message = "backup_retention_days must be at least 1 so point-in-time recovery stays on."
  }
}

variable "deletion_protection" {
  type    = bool
  default = true
}

variable "tags" {
  type    = map(string)
  default = {}
}
