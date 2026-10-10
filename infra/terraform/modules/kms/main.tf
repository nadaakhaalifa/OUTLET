# One customer-managed key per purpose so access can be scoped and rotated independently.
# Yearly automatic rotation (T5). Key policies keep the default account-root statement; grants to
# workloads are added by the modules that consume the key (least privilege).

resource "aws_kms_key" "this" {
  for_each                = var.keys
  description             = "${var.name} ${each.key}"
  enable_key_rotation     = true
  deletion_window_in_days = var.deletion_window_in_days
  tags                    = merge(var.tags, { Name = "${var.name}-${each.key}", Purpose = each.key })
}

resource "aws_kms_alias" "this" {
  for_each      = var.keys
  name          = "alias/${var.name}-${each.key}"
  target_key_id = aws_kms_key.this[each.key].key_id
}
