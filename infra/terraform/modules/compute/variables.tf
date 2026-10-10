variable "name" {
  type = string
}

variable "vpc_id" {
  type = string
}

variable "kms_key_arn" {
  description = "Key for log group encryption."
  type        = string
}

variable "log_retention_days" {
  type    = number
  default = 30
}

variable "secret_arns" {
  description = "Secrets the task execution role may read (least privilege)."
  type        = list(string)
  default     = []
}

variable "secrets_kms_key_arn" {
  description = "CMK that encrypts the secrets in secret_arns. The execution role gets kms:Decrypt on it."
  type        = string
  default     = null
}

variable "tags" {
  type    = map(string)
  default = {}
}
