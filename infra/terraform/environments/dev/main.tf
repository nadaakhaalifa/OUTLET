# Environment: dev
# Development. Synthetic data only. Scale to zero outside working hours (T10) once compute services exist.

provider "aws" {
  region = var.region

  default_tags {
    tags = local.tags
  }
}

provider "aws" {
  alias  = "us_east_1"
  region = var.edge_region

  default_tags {
    tags = local.tags
  }
}

locals {
  name = "outlet-dev"

  tags = {
    Project     = "outlet-nk"
    Environment = "dev"
    ManagedBy   = "terraform"
    DataClass   = "synthetic"
  }
}

module "network" {
  source             = "../../modules/network"
  name               = local.name
  cidr_block         = "10.10.0.0/16"
  az_count           = 2
  single_nat_gateway = true
  tags               = local.tags
}

module "kms" {
  source = "../../modules/kms"
  name   = local.name
  tags   = local.tags
}

module "secrets" {
  source      = "../../modules/secrets"
  name        = local.name
  kms_key_arn = module.kms.key_arns["secrets"]
  tags        = local.tags
}

module "compute" {
  source              = "../../modules/compute"
  name                = local.name
  vpc_id              = module.network.vpc_id
  kms_key_arn         = module.kms.key_arns["logs"]
  log_retention_days  = 14
  secret_arns         = values(module.secrets.secret_arns)
  secrets_kms_key_arn = module.kms.key_arns["secrets"]
  tags                = local.tags
}

module "postgres" {
  source                     = "../../modules/postgres"
  name                       = local.name
  vpc_id                     = module.network.vpc_id
  subnet_ids                 = module.network.private_subnet_ids
  allowed_security_group_ids = [module.compute.service_security_group_id]
  kms_key_arn                = module.kms.key_arns["data"]
  instance_class             = "db.t4g.medium"
  multi_az                   = false
  backup_retention_days      = 7
  deletion_protection        = false
  tags                       = local.tags
}

module "redis" {
  source                     = "../../modules/redis"
  name                       = local.name
  vpc_id                     = module.network.vpc_id
  subnet_ids                 = module.network.private_subnet_ids
  allowed_security_group_ids = [module.compute.service_security_group_id]
  kms_key_arn                = module.kms.key_arns["data"]
  node_type                  = "cache.t4g.small"
  num_cache_clusters         = 1
  tags                       = local.tags
}

module "object_storage" {
  source        = "../../modules/object-storage"
  name          = local.name
  kms_key_arn   = module.kms.key_arns["data"]
  force_destroy = true
  tags          = local.tags
}

# Edge: origin is the media bucket until the API load balancer exists. Replace with the load
# balancer domain when compute services are added.
module "cdn_waf" {
  source             = "../../modules/cdn-waf"
  name               = local.name
  origin_domain_name = module.object_storage.bucket_regional_domain_names["media"]
  origin_is_s3       = true

  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }

  tags = local.tags
}

data "aws_iam_policy_document" "ci" {
  # Deliberately narrow: CI may read its own secrets' metadata and push nothing else until the
  # deploy pipeline defines exactly what it needs. Extend per feature through review (CODEOWNERS).
  statement {
    sid       = "DescribeOwnCluster"
    actions   = ["ecs:DescribeClusters", "ecs:DescribeServices"]
    resources = [module.compute.cluster_arn, "${replace(module.compute.cluster_arn, ":cluster/", ":service/")}/*"]
  }
}

module "github_oidc" {
  source                = "../../modules/github-oidc"
  name                  = local.name
  github_repository     = var.github_repository
  allowed_subjects      = ["repo:${var.github_repository}:environment:dev"]
  policy_json           = data.aws_iam_policy_document.ci.json
  create_provider       = var.create_github_oidc_provider
  existing_provider_arn = var.existing_github_oidc_provider_arn
  tags                  = local.tags
}
