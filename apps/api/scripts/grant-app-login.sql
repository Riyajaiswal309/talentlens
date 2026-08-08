-- Local development only.
--
-- The migration creates the restricted application role NOLOGIN with no
-- password, so that no credential is committed (PRD §24.3). This script gives
-- it a local-only password so the API can connect as it during development.
--
-- Production: assign the password from AWS Secrets Manager with 90-day
-- rotation (PRD §24.3). Never run this file against a deployed environment.

ALTER ROLE "talentlens_app" WITH LOGIN PASSWORD 'talentlens_app_dev';
