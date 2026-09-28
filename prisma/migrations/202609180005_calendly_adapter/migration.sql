-- Encrypted per-tenant Calendly webhook signing key (AES-256-GCM via application encrypt()).
ALTER TABLE "TenantSetting" ADD COLUMN "calendlySigningKey" TEXT;
