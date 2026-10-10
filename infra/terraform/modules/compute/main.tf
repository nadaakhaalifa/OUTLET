# Compute foundation for managed containers (T7: ECS or Kubernetes; ECS Fargate assumed here, pending
# ADR-0002 and an owner decision on the orchestrator). This module creates the cluster, log group,
# security group and IAM roles. The ECS service and task definition are NOT created here: they need a
# signed image digest from the release workflow, and apps/api has no deployable image yet. Deployments
# are by digest only (never a mutable tag), verified with cosign (ADR-0015).

resource "aws_ecs_cluster" "this" {
  name = var.name

  setting {
    name  = "containerInsights"
    value = "enabled"
  }

  tags = var.tags
}

resource "aws_ecs_cluster_capacity_providers" "this" {
  cluster_name       = aws_ecs_cluster.this.name
  capacity_providers = ["FARGATE", "FARGATE_SPOT"]

  default_capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
    base              = 1
  }
}

resource "aws_cloudwatch_log_group" "api" {
  name              = "/outlet/${var.name}/api"
  retention_in_days = var.log_retention_days
  kms_key_id        = var.kms_key_arn
  tags              = var.tags
}

resource "aws_security_group" "service" {
  name_prefix = "${var.name}-svc-"
  description = "Application tasks"
  vpc_id      = var.vpc_id
  tags        = merge(var.tags, { Name = "${var.name}-svc" })

  lifecycle {
    create_before_destroy = true
  }
}

# Egress is HTTPS only. Anything else (PSP webhooks out, courier APIs) goes through the allow-listed
# egress proxy (T5 API7) that is added with the first outbound integration.
resource "aws_vpc_security_group_egress_rule" "https" {
  security_group_id = aws_security_group.service.id
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
  description       = "HTTPS egress"
}

data "aws_iam_policy_document" "ecs_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "execution" {
  name               = "${var.name}-task-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
  tags               = var.tags
}

resource "aws_iam_role_policy_attachment" "execution_managed" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "read_secrets" {
  count = length(var.secret_arns) > 0 ? 1 : 0

  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = var.secret_arns
  }

  # Secrets are encrypted with a customer-managed key, so reading them also needs Decrypt on that key.
  dynamic "statement" {
    for_each = var.secrets_kms_key_arn == null ? [] : [1]

    content {
      actions   = ["kms:Decrypt"]
      resources = [var.secrets_kms_key_arn]
    }
  }
}

resource "aws_iam_role_policy" "read_secrets" {
  count  = length(var.secret_arns) > 0 ? 1 : 0
  name   = "read-secrets"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.read_secrets[0].json
}

# Task role: what the application code itself may do. Empty on purpose; grants are added per feature.
resource "aws_iam_role" "task" {
  name               = "${var.name}-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
  tags               = var.tags
}
