# Unit tests for terraform.rego. Run: conftest verify --policy infra/terraform/policy
#
# Fixtures are inline. The policy consumes the HCL2-parsed source shape that
# `conftest test --parser hcl2` produces (input.resource.<type>.<name> = [ {attrs} ]), which is
# what `conftest parse <file>.tf --parser hcl2` prints. They were built by hand to match that shape
# (checked against conftest parse output of modules/postgres); no cloud credentials or
# `terraform plan` output were used.
package main

import rego.v1

# --- compliant baseline pieces ---------------------------------------------------------------
good_db := {"aws_db_instance": {"this": [{"storage_encrypted": true, "publicly_accessible": false, "backup_retention_period": 7, "multi_az": true}]}}

good_cache := {"aws_elasticache_replication_group": {"this": [{"transit_encryption_enabled": true, "at_rest_encryption_enabled": true}]}}

good_pab := {"aws_s3_bucket_public_access_block": {"this": [{"block_public_acls": true, "block_public_policy": true, "ignore_public_acls": true, "restrict_public_buckets": true}]}}

has(msgs, needle) if {
	some m in msgs
	contains(m, needle)
}

# --- whole compliant document produces no denies ---------------------------------------------
test_compliant_document_allowed if {
	doc := {
		"resource": object.union_n([good_db, good_cache, good_pab, {"aws_s3_bucket": {"b": [{}]}}, {"aws_kms_key": {"k": [{"enable_key_rotation": true}]}}, {"aws_vpc_security_group_ingress_rule": {"r": [{"cidr_ipv4": "10.0.0.0/16"}]}}]),
		"provider": {"aws": [{"region": "${var.region}"}]},
	}
	count(deny) == 0 with input as doc
	count(warn) == 0 with input as doc
}

test_empty_input_allowed if count(deny) == 0 with input as {}

# --- aws_db_instance -------------------------------------------------------------------------
test_db_unencrypted_denied if has(deny, "storage_encrypted") with input as {"resource": {"aws_db_instance": {"x": [{"storage_encrypted": false}]}}}
test_db_encryption_missing_denied if has(deny, "storage_encrypted") with input as {"resource": {"aws_db_instance": {"x": [{}]}}}
test_db_encrypted_allowed if not has(deny, "storage_encrypted") with input as {"resource": good_db}

test_db_public_denied if has(deny, "publicly accessible") with input as {"resource": {"aws_db_instance": {"x": [{"storage_encrypted": true, "publicly_accessible": true}]}}}
test_db_private_allowed if not has(deny, "publicly accessible") with input as {"resource": good_db}

test_db_no_backups_denied if has(deny, "keep backups") with input as {"resource": {"aws_db_instance": {"x": [{"storage_encrypted": true, "backup_retention_period": 0}]}}}
test_db_backups_allowed if not has(deny, "keep backups") with input as {"resource": good_db}

# warn: single AZ
test_db_single_az_warns if has(warn, "single-AZ") with input as {"resource": {"aws_db_instance": {"x": [{"multi_az": false}]}}}
test_db_multi_az_no_warn if count(warn) == 0 with input as {"resource": good_db}

# --- aws_elasticache_replication_group -------------------------------------------------------
test_cache_no_transit_denied if has(deny, "transit encryption") with input as {"resource": {"aws_elasticache_replication_group": {"x": [{"at_rest_encryption_enabled": true}]}}}
test_cache_no_rest_denied if has(deny, "at-rest encryption") with input as {"resource": {"aws_elasticache_replication_group": {"x": [{"transit_encryption_enabled": true}]}}}
test_cache_encrypted_allowed if count(deny) == 0 with input as {"resource": good_cache}

# --- aws_kms_key -----------------------------------------------------------------------------
test_kms_rotation_off_denied if has(deny, "key rotation") with input as {"resource": {"aws_kms_key": {"k": [{"enable_key_rotation": false}]}}}
test_kms_rotation_missing_denied if has(deny, "key rotation") with input as {"resource": {"aws_kms_key": {"k": [{}]}}}
test_kms_rotation_on_allowed if count(deny) == 0 with input as {"resource": {"aws_kms_key": {"k": [{"enable_key_rotation": true}]}}}

# --- public access block attributes (one test per attribute) ---------------------------------
test_pab_each_attribute_denied if {
	every attr in ["block_public_acls", "block_public_policy", "ignore_public_acls", "restrict_public_buckets"] {
		bad := object.union(good_pab.aws_s3_bucket_public_access_block.this[0], {attr: false})
		has(deny, sprintf("must set %s = true", [attr])) with input as {"resource": {"aws_s3_bucket_public_access_block": {"this": [bad]}}}
	}
}

test_pab_missing_attribute_denied if has(deny, "restrict_public_buckets") with input as {"resource": {"aws_s3_bucket_public_access_block": {"this": [{"block_public_acls": true, "block_public_policy": true, "ignore_public_acls": true}]}}}
test_pab_all_true_allowed if count(deny) == 0 with input as {"resource": good_pab}

# --- bucket needs a public access block ------------------------------------------------------
test_bucket_without_pab_denied if has(deny, "needs an aws_s3_bucket_public_access_block") with input as {"resource": {"aws_s3_bucket": {"b": [{}]}}}
test_bucket_with_pab_allowed if count(deny) == 0 with input as {"resource": object.union(good_pab, {"aws_s3_bucket": {"b": [{}]}})}

# --- secret versions -------------------------------------------------------------------------
test_secret_version_denied if has(deny, "secret value in Terraform state") with input as {"resource": {"aws_secretsmanager_secret_version": {"s": [{"secret_string": "x"}]}}}
test_secret_without_version_allowed if count(deny) == 0 with input as {"resource": {"aws_secretsmanager_secret": {"s": [{}]}}}

# --- ingress ---------------------------------------------------------------------------------
test_world_ingress_denied if has(deny, "0.0.0.0/0") with input as {"resource": {"aws_vpc_security_group_ingress_rule": {"r": [{"cidr_ipv4": "0.0.0.0/0"}]}}}
test_private_ingress_allowed if count(deny) == 0 with input as {"resource": {"aws_vpc_security_group_ingress_rule": {"r": [{"cidr_ipv4": "10.0.0.0/8"}]}}}

# --- access keys -----------------------------------------------------------------------------
test_access_key_denied if has(deny, "long-lived cloud keys") with input as {"resource": {"aws_iam_access_key": {"k": [{"user": "u"}]}}}
test_no_access_key_allowed if count(deny) == 0 with input as {"resource": {"aws_iam_user": {"u": [{}]}}}

# --- provider region -------------------------------------------------------------------------
test_hardcoded_region_denied if has(deny, "hard-coded") with input as {"provider": {"aws": [{"region": "eu-south-1"}]}}
test_variable_region_allowed if count(deny) == 0 with input as {"provider": {"aws": [{"region": "${var.region}"}]}}
test_aliased_providers_each_checked if count([m | some m in deny; contains(m, "hard-coded")]) == 1 with input as {"provider": {"aws": [{"region": "${var.region}"}, {"region": "us-east-1", "alias": "us_east_1"}]}}
