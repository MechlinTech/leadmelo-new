-- Optional per-tenant retention for message bodies and reply text (NULL = keep until erased).
ALTER TABLE "TenantSetting" ADD COLUMN "messageRetentionDays" INTEGER;
ALTER TABLE "TenantSetting" ADD CONSTRAINT retention_minimum CHECK ("messageRetentionDays" IS NULL OR "messageRetentionDays" >= 30);
