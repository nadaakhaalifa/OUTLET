terraform {
  required_version = ">= 1.9.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }

  # Remote state with locking and encryption. The bucket, key, region and lock table are supplied at
  # init time (`terraform init -backend-config=backend.hcl`), so no account ids are committed.
  # VERIFY BEFORE LAUNCH: state backend provider follows ADR-0002.
  backend "s3" {}
}
