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

output "ci_role_arn" {
  value = module.github_oidc.role_arn
}
