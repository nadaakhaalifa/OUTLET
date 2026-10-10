# Secret containers only. No secret_string / secret_version resources exist anywhere in this repo,
# so no value can enter Terraform state or Git. Set values with the provider CLI or console.

resource "aws_secretsmanager_secret" "this" {
  for_each                = var.secret_names
  name                    = "${var.name}/${each.key}"
  kms_key_id              = var.kms_key_arn
  recovery_window_in_days = var.recovery_window_in_days
  tags                    = merge(var.tags, { Name = "${var.name}/${each.key}" })
}
