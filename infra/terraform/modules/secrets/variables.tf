variable "name" {
  type = string
}

variable "kms_key_arn" {
  type = string
}

variable "secret_names" {
  description = "Logical secret names. Terraform creates the containers only; values are set out of band and never pass through state."
  type        = set(string)
  default     = ["psp-api-key", "psp-webhook-secret", "courier-api-key", "sms-api-key", "jwt-signing-key"]
}

variable "recovery_window_in_days" {
  type    = number
  default = 30
}

variable "tags" {
  type    = map(string)
  default = {}
}
