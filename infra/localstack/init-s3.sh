#!/bin/bash
# LocalStack ready hook — creates the resume bucket once the S3 API is up.
#
# In production this bucket is Terraform-managed (PRD §16, §29), so the API
# deliberately does NOT create buckets at runtime. This script is the local
# stand-in for that provisioning step, which keeps the application code
# identical in development and production.
set -euo pipefail

BUCKET="${RESUME_BUCKET:-talentlens-resumes-dev}"

awslocal s3api create-bucket --bucket "$BUCKET"

# PRD §29 Table 29.1 requires versioning on the resumes bucket. Enabled here
# too so that local behaviour matches production.
awslocal s3api put-bucket-versioning \
  --bucket "$BUCKET" \
  --versioning-configuration Status=Enabled

# Resumes are never public. The production bucket is KMS-encrypted and private
# (PRD §24.2); LocalStack does not emulate KMS, so this asserts the access
# posture only.
awslocal s3api put-public-access-block \
  --bucket "$BUCKET" \
  --public-access-block-configuration \
  "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"

echo "[init-s3] bucket ready: $BUCKET"
