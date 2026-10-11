variable "name" {
  type = string
}

variable "kms_key_arn" {
  type = string
}

variable "buckets" {
  description = <<-EOT
    Logical buckets. All are private, versioned and encrypted. Signed URLs for downloads are at most 15 minutes (T5).
    object_lock turns on WORM retention (immutable audit log, T5) and can only be set at creation.
  EOT
  type = map(object({
    object_lock            = optional(bool, false)
    object_lock_days       = optional(number, 365)
    expire_noncurrent_days = optional(number, 90)
  }))
  default = {
    uploads = {}
    media   = {}
    audit   = { object_lock = true }
  }
}

variable "force_destroy" {
  description = "Only true in dev."
  type        = bool
  default     = false
}

variable "tags" {
  type    = map(string)
  default = {}
}
