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

variable "tags" {
  type    = map(string)
  default = {}
}
