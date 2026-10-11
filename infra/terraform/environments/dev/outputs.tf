output "vpc_id" {
  value = module.network.vpc_id
}

output "postgres_endpoint" {
  value = module.postgres.endpoint
}

output "redis_primary_endpoint" {
  value = module.redis.primary_endpoint
}

output "cdn_domain_name" {
  value = module.cdn_waf.distribution_domain_name
}

output "github_oidc_provider_arn" {
  description = "Pass to other environments in the same account as existing_github_oidc_provider_arn."
  value       = module.github_oidc.provider_arn
}

output "ci_role_arn" {
  value = module.github_oidc.role_arn
}
