variable "name" {
  type = string
}

variable "keys" {
  description = "Logical keys to create. Field-level envelope encryption (T5) uses the 'pii' key to wrap DEKs."
  type        = set(string)
  default     = ["data", "pii", "logs", "secrets"]
}

variable "deletion_window_in_days" {
  type    = number
  default = 30
}

variable "tags" {
  type    = map(string)
  default = {}
}
