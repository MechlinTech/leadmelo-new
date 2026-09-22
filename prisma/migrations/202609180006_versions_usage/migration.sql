-- Campaign versioning, immutable-style usage ledger, tenant spend controls.
ALTER TABLE "Campaign" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "TenantSetting" ADD COLUMN "monthlySpendCapCents" INTEGER,
  ADD COLUMN "providerCostCents" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "suspended" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "TenantSetting" ADD CONSTRAINT tenant_spend_nonnegative CHECK (("monthlySpendCapCents" IS NULL OR "monthlySpendCapCents" >= 0) AND "providerCostCents" >= 0);

CREATE TABLE "CampaignVersion" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "reason" TEXT NOT NULL,
    "actorUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CampaignVersion_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CampaignVersion_campaignId_version_key" ON "CampaignVersion"("campaignId", "version");
CREATE INDEX "CampaignVersion_tenantId_idx" ON "CampaignVersion"("tenantId");
ALTER TABLE "CampaignVersion" ADD CONSTRAINT "CampaignVersion_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CampaignVersion" ADD CONSTRAINT campaign_version_tenant_fk FOREIGN KEY ("tenantId") REFERENCES "Tenant"(id) ON DELETE CASCADE;
CREATE TRIGGER tenant_links BEFORE INSERT OR UPDATE ON "CampaignVersion" FOR EACH ROW EXECUTE FUNCTION leadmelo_check_tenant_links('campaignId','Campaign');

CREATE TABLE "UsageLedger" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "campaignId" TEXT,
    "kind" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "costCents" INTEGER NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "UsageLedger_pkey" PRIMARY KEY ("id"),
    CONSTRAINT usage_nonnegative CHECK ("quantity" >= 0 AND "costCents" >= 0)
);
CREATE UNIQUE INDEX "UsageLedger_tenantId_idempotencyKey_key" ON "UsageLedger"("tenantId", "idempotencyKey");
CREATE INDEX "UsageLedger_tenantId_createdAt_idx" ON "UsageLedger"("tenantId", "createdAt");
ALTER TABLE "UsageLedger" ADD CONSTRAINT "UsageLedger_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE TRIGGER tenant_links BEFORE INSERT OR UPDATE ON "UsageLedger" FOR EACH ROW EXECUTE FUNCTION leadmelo_check_tenant_links('campaignId','Campaign');
