-- Optional AI assist (bring-your-own model). Off by default; nothing else depends on these columns.
ALTER TABLE "TenantSetting"
  ADD COLUMN "aiEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "aiBaseUrl" TEXT,
  ADD COLUMN "aiModel" TEXT,
  ADD COLUMN "aiKey" TEXT,
  ADD COLUMN "aiFeatures" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "TenantSetting" ADD CONSTRAINT "TenantSetting_ai_lengths"
  CHECK (("aiBaseUrl" IS NULL OR length("aiBaseUrl") <= 300) AND ("aiModel" IS NULL OR length("aiModel") <= 120));
ALTER TABLE "TenantSetting" ADD CONSTRAINT "TenantSetting_ai_features"
  CHECK ("aiFeatures" <@ ARRAY['campaign_assist','reply_assist']::TEXT[]);
