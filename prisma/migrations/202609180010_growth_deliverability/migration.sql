-- Public access requests, assistant question log, automated sender health, holidays, Calendly reconciliation.
CREATE TABLE "AccessRequest" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "company" TEXT,
    "message" TEXT,
    "plan" TEXT,
    "source" TEXT NOT NULL,
    "handledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AccessRequest_pkey" PRIMARY KEY ("id"),
    CONSTRAINT access_request_source CHECK ("source" IN ('pricing','assistant','contact'))
);
CREATE INDEX "AccessRequest_createdAt_idx" ON "AccessRequest"("createdAt");

CREATE TABLE "AssistantQuestion" (
    "id" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "audience" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AssistantQuestion_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AssistantQuestion_createdAt_idx" ON "AssistantQuestion"("createdAt");

ALTER TABLE "DeliverabilityProfile" ADD COLUMN "spfStatus" TEXT,
  ADD COLUMN "dkimStatus" TEXT,
  ADD COLUMN "dmarcStatus" TEXT,
  ADD COLUMN "authCheckedAt" TIMESTAMP(3),
  ADD COLUMN "healthSource" TEXT NOT NULL DEFAULT 'external',
  ADD COLUMN "detail" JSONB;
ALTER TABLE "DeliverabilityProfile" ADD CONSTRAINT health_source CHECK ("healthSource" IN ('external','internal'));

ALTER TABLE "Campaign" ADD COLUMN "holidays" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "TenantSetting" ADD COLUMN "calendlyToken" TEXT,
  ADD COLUMN "calendlyOrganizationUri" TEXT,
  ADD COLUMN "calendlyReconciledAt" TIMESTAMP(3);

-- Per-user appearance preference (also mirrored in a cookie so the first paint is correct).
ALTER TABLE "User" ADD COLUMN "theme" TEXT;
ALTER TABLE "User" ADD CONSTRAINT user_theme CHECK ("theme" IS NULL OR "theme" IN ('system','light','dark','ocean','forest','sunset'));
