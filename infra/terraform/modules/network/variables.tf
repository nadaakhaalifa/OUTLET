variable "name" {
  description = "Name prefix, for example outlet-dev."
  type        = string
}

variable "cidr_block" {
  description = "VPC CIDR. Use non-overlapping ranges per environment."
  type        = string
}

variable "az_count" {
  description = "Number of availability zones (2 minimum for multi-AZ data stores)."
  type        = number
  default     = 2

  validation {
    condition     = var.az_count >= 2 && var.az_count <= 3
    error_message = "az_count must be 2 or 3."
  }
}

variable "single_nat_gateway" {
  description = "One shared NAT gateway (cheap, non-prod) instead of one per AZ."
  type        = bool
  default     = true
}

variable "tags" {
  type    = map(string)
  default = {}
}
