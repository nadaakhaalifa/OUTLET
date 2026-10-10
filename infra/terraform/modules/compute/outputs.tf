output "cluster_arn" {
  value = aws_ecs_cluster.this.arn
}

output "service_security_group_id" {
  value = aws_security_group.service.id
}

output "execution_role_arn" {
  value = aws_iam_role.execution.arn
}

output "task_role_arn" {
  value = aws_iam_role.task.arn
}

output "log_group_name" {
  value = aws_cloudwatch_log_group.api.name
}
