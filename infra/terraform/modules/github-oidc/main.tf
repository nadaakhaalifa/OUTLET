# Keyless CI to cloud (T5: no long-lived cloud keys, OIDC from CI).
# VERIFY BEFORE LAUNCH: the provider's current thumbprint handling. AWS no longer requires a
# thumbprint match for GitHub's issuer, but the field is mandatory in older provider versions.

locals {
  provider_arn = var.create_provider ? aws_iam_openid_connect_provider.github[0].arn : var.existing_provider_arn
}

resource "aws_iam_openid_connect_provider" "github" {
  count           = var.create_provider ? 1 : 0
  url             = "https://token.actions.githubusercontent.com"
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = ["6938fd4d98bab03faadb97b34396831e3780aea1"]
  tags            = var.tags
}

data "aws_iam_policy_document" "trust" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [local.provider_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = var.allowed_subjects
    }
  }
}

resource "aws_iam_role" "ci" {
  name                 = "${var.name}-github-ci"
  assume_role_policy   = data.aws_iam_policy_document.trust.json
  max_session_duration = 3600
  tags                 = var.tags

  lifecycle {
    precondition {
      condition     = var.create_provider || var.existing_provider_arn != null
      error_message = "Set existing_provider_arn when create_provider is false, otherwise the trust policy has no federated principal."
    }
  }
}

resource "aws_iam_role_policy" "ci" {
  name   = "ci"
  role   = aws_iam_role.ci.id
  policy = var.policy_json
}
