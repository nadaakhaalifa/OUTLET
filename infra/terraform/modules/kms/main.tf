# One customer-managed key per purpose so access can be scoped and rotated independently.
# Yearly automatic rotation (T5). Key policies keep the account-root statement; grants to workloads
# are IAM policies added by the modules that consume the key (least privilege).

data "aws_caller_identity" "current" {}

data "aws_region" "current" {}

# Key policy: account root (so IAM policies on workloads can grant use, least privilege) plus, for the
# 'logs' key only, the CloudWatch Logs service principal. Without that statement a log group cannot use
# the key and creation fails with AccessDenied.
data "aws_iam_policy_document" "key" {
  for_each = var.keys

  statement {
    sid       = "EnableIamPolicies"
    actions   = ["kms:*"]
    resources = ["*"]

    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"]
    }
  }

  dynamic "statement" {
    for_each = each.key == "logs" ? [1] : []

    content {
      sid       = "AllowCloudWatchLogs"
      actions   = ["kms:Encrypt*", "kms:Decrypt*", "kms:ReEncrypt*", "kms:GenerateDataKey*", "kms:Describe*"]
      resources = ["*"]

      principals {
        type        = "Service"
        identifiers = ["logs.${data.aws_region.current.region}.amazonaws.com"]
      }

      condition {
        test     = "ArnLike"
        variable = "kms:EncryptionContext:aws:logs:arn"
        values   = ["arn:aws:logs:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:log-group:*"]
      }
    }
  }
}

resource "aws_kms_key" "this" {
  for_each                = var.keys
  policy                  = data.aws_iam_policy_document.key[each.key].json
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
