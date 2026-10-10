# Conftest policy stubs for the Terraform source (T7 policy-as-code, T5 IaC scanning).
# Run: conftest test infra/terraform --policy infra/terraform/policy --parser hcl2
# These are STUBS: they are small, readable guardrails over the HCL source, not a full policy set.
# They have NOT been executed in this repository's authoring environment (conftest and opa were not
# installed). Run them once and fix any shape mismatch before relying on them in CI.
package main

import rego.v1

# Helper: all resource blocks of a type as {name: attrs}.
resources(type) := object.get(object.get(input, "resource", {}), type, {})

# conftest's hcl2 parser wraps each resource body in a one-element array in some versions.
body(r) := r[0] if is_array(r)
body(r) := r if not is_array(r)

deny contains msg if {
	some name, raw in resources("aws_db_instance")
	b := body(raw)
	not b.storage_encrypted == true
	msg := sprintf("aws_db_instance.%s must set storage_encrypted = true", [name])
}

deny contains msg if {
	some name, raw in resources("aws_db_instance")
	b := body(raw)
	b.publicly_accessible == true
	msg := sprintf("aws_db_instance.%s must not be publicly accessible", [name])
}

deny contains msg if {
	some name, raw in resources("aws_db_instance")
	b := body(raw)
	b.backup_retention_period == 0
	msg := sprintf("aws_db_instance.%s must keep backups (point-in-time recovery, RPO <= 15 min)", [name])
}

deny contains msg if {
	some name, raw in resources("aws_elasticache_replication_group")
	b := body(raw)
	not b.transit_encryption_enabled == true
	msg := sprintf("aws_elasticache_replication_group.%s must enable transit encryption", [name])
}

deny contains msg if {
	some name, raw in resources("aws_elasticache_replication_group")
	b := body(raw)
	not b.at_rest_encryption_enabled == true
	msg := sprintf("aws_elasticache_replication_group.%s must enable at-rest encryption", [name])
}

deny contains msg if {
	some name, raw in resources("aws_kms_key")
	b := body(raw)
	not b.enable_key_rotation == true
	msg := sprintf("aws_kms_key.%s must enable key rotation (yearly rotation, T5)", [name])
}

deny contains msg if {
	some name, raw in resources("aws_s3_bucket_public_access_block")
	b := body(raw)
	some attr in ["block_public_acls", "block_public_policy", "ignore_public_acls", "restrict_public_buckets"]
	not b[attr] == true
	msg := sprintf("aws_s3_bucket_public_access_block.%s must set %s = true", [name, attr])
}

# Buckets must have a public access block declared in the same module.
deny contains msg if {
	count(resources("aws_s3_bucket")) > 0
	count(resources("aws_s3_bucket_public_access_block")) == 0
	msg := "every aws_s3_bucket needs an aws_s3_bucket_public_access_block in the same module"
}

# No inline secret material: secret versions would put values into state.
deny contains msg if {
	some name in object.keys(resources("aws_secretsmanager_secret_version"))
	msg := sprintf("aws_secretsmanager_secret_version.%s would place a secret value in Terraform state; set values out of band", [name])
}

# No world-open ingress on security groups.
deny contains msg if {
	some name, raw in resources("aws_vpc_security_group_ingress_rule")
	b := body(raw)
	b.cidr_ipv4 == "0.0.0.0/0"
	msg := sprintf("aws_vpc_security_group_ingress_rule.%s must not open ingress to 0.0.0.0/0", [name])
}

# No long-lived access keys: CI uses OIDC (T5).
deny contains msg if {
	some name in object.keys(resources("aws_iam_access_key"))
	msg := sprintf("aws_iam_access_key.%s: long-lived cloud keys are forbidden; use OIDC", [name])
}

# Region must never be hard-coded in an environment: it is decided by ADR-0002.
deny contains msg if {
	some p in object.get(input, "provider", {})
	some cfg in p
	b := body(cfg)
	is_string(b.region)
	not startswith(b.region, "${")
	msg := sprintf("provider region %q is hard-coded; use var.region (ADR-0002)", [b.region])
}

warn contains msg if {
	some name, raw in resources("aws_db_instance")
	b := body(raw)
	not b.multi_az == true
	msg := sprintf("aws_db_instance.%s is single-AZ (acceptable for dev only)", [name])
}
