# CDN + WAF at the edge (T7). A CloudFront WAF web ACL must live in us-east-1, so the caller passes
# an aliased provider named aws.us_east_1. A waiting-room/queue product is NOT included: it is a
# separate vendor decision (see docs/engineering/iac.md).

resource "aws_wafv2_web_acl" "this" {
  provider = aws.us_east_1
  name     = var.name
  scope    = "CLOUDFRONT"

  default_action {
    allow {}
  }

  rule {
    name     = "aws-common"
    priority = 10

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesCommonRuleSet"
        vendor_name = "AWS"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.name}-common"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "aws-ip-reputation"
    priority = 20

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesAmazonIpReputationList"
        vendor_name = "AWS"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.name}-ip-reputation"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "aws-known-bad-inputs"
    priority = 15

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesKnownBadInputsRuleSet"
        vendor_name = "AWS"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.name}-known-bad-inputs"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "rate-limit-per-ip"
    priority = 30

    action {
      block {}
    }

    statement {
      rate_based_statement {
        limit              = var.rate_limit_per_5_minutes
        aggregate_key_type = "IP"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.name}-rate-limit"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = var.name
    sampled_requests_enabled   = true
  }

  tags = var.tags
}

resource "aws_cloudfront_origin_access_control" "s3" {
  count                             = var.origin_is_s3 ? 1 : 0
  name                              = var.name
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_distribution" "this" {
  enabled         = true
  is_ipv6_enabled = true
  comment         = var.name
  aliases         = var.aliases
  web_acl_id      = aws_wafv2_web_acl.this.arn
  price_class     = "PriceClass_100"
  http_version    = "http2and3"
  # S3 origin serves the web apps entry document; a custom (API) origin must not rewrite "/".
  default_root_object = var.origin_is_s3 ? "index.html" : null

  origin {
    origin_id                = "primary"
    domain_name              = var.origin_domain_name
    origin_access_control_id = var.origin_is_s3 ? aws_cloudfront_origin_access_control.s3[0].id : null

    dynamic "custom_origin_config" {
      for_each = var.origin_is_s3 ? [] : [1]
      content {
        http_port              = 80
        https_port             = 443
        origin_protocol_policy = "https-only"
        origin_ssl_protocols   = ["TLSv1.2"]
      }
    }
  }

  default_cache_behavior {
    target_origin_id       = "primary"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true
    # AWS managed policy ids: CachingOptimized and CORS-S3Origin. VERIFY BEFORE LAUNCH that the ids are current.
    cache_policy_id          = "658327ea-f89d-4fab-a63d-7e88639e58f6"
    origin_request_policy_id = "88a5eaf4-2fd4-4709-b370-b4c650ea3fcb"
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = var.acm_certificate_arn == null
    acm_certificate_arn            = var.acm_certificate_arn
    ssl_support_method             = var.acm_certificate_arn == null ? null : "sni-only"
    minimum_protocol_version       = var.acm_certificate_arn == null ? null : "TLSv1.2_2021"
  }

  tags = var.tags
}
