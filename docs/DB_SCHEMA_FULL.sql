-- LeadMelo V20 complete PostgreSQL schema (all 11 migrations concatenated, in order).
-- Reference only: deploy with 'prisma migrate deploy' (docker compose 'migrate' service), not by running this file.

-- ===== prisma/migrations/202609180001_initial/migration.sql =====
-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('SUPER_ADMIN', 'TENANT_ADMIN', 'MANAGER', 'MEMBER');

-- CreateEnum
CREATE TYPE "Plan" AS ENUM ('FREE', 'STARTER', 'GROWTH', 'SCALE', 'ENTERPRISE');

-- CreateEnum
CREATE TYPE "LeadStatus" AS ENUM ('NEW', 'QUALIFIED', 'CONTACTED', 'REPLIED', 'MEETING', 'WON', 'LOST', 'SUPPRESSED');

-- CreateEnum
CREATE TYPE "ProviderKind" AS ENUM ('APOLLO', 'HUNTER', 'ROCKETREACH', 'CLAY', 'PEOPLE_DATA_LABS', 'CUSTOM');

-- CreateEnum
CREATE TYPE "DiscoveryJobStatus" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED', 'COMPLETE', 'FAILED');

-- CreateEnum
CREATE TYPE "ContactRole" AS ENUM ('CTO', 'VP_ENGINEERING', 'ENGINEERING_MANAGER', 'QA_DIRECTOR', 'QA_MANAGER', 'HEAD_OF_QUALITY', 'OTHER');

-- CreateEnum
CREATE TYPE "ContactVerificationStatus" AS ENUM ('UNKNOWN', 'VALID', 'RISKY', 'INVALID');

-- CreateEnum
CREATE TYPE "CampaignStatus" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED', 'COMPLETE');

-- CreateEnum
CREATE TYPE "SequenceStepType" AS ENUM ('EMAIL', 'LINKEDIN_TASK', 'CALL_TASK');

-- CreateEnum
CREATE TYPE "OutreachStatus" AS ENUM ('QUEUED', 'SENDING', 'CANCELED', 'SENT', 'OPENED', 'CLICKED', 'REPLIED', 'BOUNCED', 'UNSUBSCRIBED', 'FAILED');

-- CreateEnum
CREATE TYPE "ReplyIntent" AS ENUM ('POSITIVE', 'NEUTRAL', 'OBJECTION', 'NEGATIVE', 'OUT_OF_OFFICE', 'UNSURE');

-- CreateEnum
CREATE TYPE "Channel" AS ENUM ('EMAIL', 'LINKEDIN', 'PHONE', 'WEB_FORM');

-- CreateEnum
CREATE TYPE "AppointmentStatus" AS ENUM ('REQUESTED', 'BOOKED', 'COMPLETED', 'NO_SHOW', 'CANCELED', 'DISQUALIFIED', 'WON', 'LOST');

-- CreateEnum
CREATE TYPE "DeliverabilityStatus" AS ENUM ('HEALTHY', 'WATCHLIST', 'THROTTLED', 'BLOCKED');

-- CreateEnum
CREATE TYPE "CampaignOutcomeType" AS ENUM ('APPOINTMENT_BOOKED', 'QUALIFIED_OPPORTUNITY', 'DISQUALIFIED', 'NO_SHOW', 'WON', 'LOST');

-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED', 'CANCELED');

-- CreateEnum
CREATE TYPE "AutomationMode" AS ENUM ('FULLY_AUTOMATIC', 'REVIEW_BEFORE_SEND', 'REVIEW_BEFORE_BOOKING', 'PAUSED');

-- CreateEnum
CREATE TYPE "QualificationStatus" AS ENUM ('UNCHECKED', 'QUALIFIED', 'NEEDS_REVIEW', 'DISQUALIFIED');

-- CreateTable
CREATE TABLE "Tenant" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "plan" "Plan" NOT NULL DEFAULT 'FREE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Tenant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "role" "Role" NOT NULL DEFAULT 'MEMBER',
    "passwordHash" TEXT,
    "disabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invite" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),

    CONSTRAINT "Invite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Lead" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "company" TEXT NOT NULL,
    "domain" TEXT,
    "contactName" TEXT,
    "contactEmail" TEXT,
    "score" INTEGER NOT NULL DEFAULT 0,
    "qualification" "QualificationStatus" NOT NULL DEFAULT 'UNCHECKED',
    "status" "LeadStatus" NOT NULL DEFAULT 'NEW',
    "reason" TEXT,
    "source" TEXT,
    "signalSummary" TEXT,
    "disqualificationReason" TEXT,
    "calendlyUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Lead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Contact" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "leadId" TEXT,
    "fullName" TEXT NOT NULL,
    "title" TEXT,
    "role" "ContactRole" NOT NULL DEFAULT 'OTHER',
    "email" TEXT,
    "linkedinUrl" TEXT,
    "verification" "ContactVerificationStatus" NOT NULL DEFAULT 'UNKNOWN',
    "sourceProvider" "ProviderKind",
    "lastVerifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Contact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DataProvider" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "kind" "ProviderKind" NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "encryptedConfig" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DataProvider_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ICP" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "offer" TEXT NOT NULL,
    "industries" TEXT[],
    "companySizes" TEXT[],
    "geographies" TEXT[],
    "technologies" TEXT[],
    "buyingSignals" TEXT[],
    "buyerTitles" TEXT[],
    "exclusionRules" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "scoreWeights" JSONB NOT NULL DEFAULT '{}',
    "minScore" INTEGER NOT NULL DEFAULT 75,
    "weeklyAppointmentGoal" INTEGER NOT NULL DEFAULT 5,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ICP_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DiscoveryJob" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "icpId" TEXT,
    "name" TEXT NOT NULL,
    "status" "DiscoveryJobStatus" NOT NULL DEFAULT 'DRAFT',
    "offer" TEXT NOT NULL,
    "targetTitles" TEXT[],
    "industries" TEXT[],
    "locations" TEXT[],
    "keywords" TEXT[],
    "excludedDomains" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "weeklyProspectLimit" INTEGER NOT NULL DEFAULT 50,
    "minScore" INTEGER NOT NULL DEFAULT 70,
    "calendlyUrl" TEXT,
    "lastRunAt" TIMESTAMP(3),
    "nextRunAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DiscoveryJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Campaign" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "icpId" TEXT,
    "name" TEXT NOT NULL,
    "status" "CampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "automationMode" "AutomationMode" NOT NULL DEFAULT 'FULLY_AUTOMATIC',
    "offer" TEXT,
    "senderName" TEXT NOT NULL,
    "senderEmail" TEXT NOT NULL,
    "calendlyUrl" TEXT NOT NULL,
    "dailySendCap" INTEGER NOT NULL DEFAULT 25,
    "weeklyProspectCap" INTEGER NOT NULL DEFAULT 50,
    "weeklyAppointmentGoal" INTEGER NOT NULL DEFAULT 5,
    "minScore" INTEGER NOT NULL DEFAULT 75,
    "minAppointmentQualityScore" INTEGER NOT NULL DEFAULT 80,
    "businessDaysOnly" BOOLEAN NOT NULL DEFAULT true,
    "stopOnReply" BOOLEAN NOT NULL DEFAULT true,
    "channels" "Channel"[] DEFAULT ARRAY['EMAIL']::"Channel"[],
    "timezone" TEXT NOT NULL DEFAULT 'America/Los_Angeles',
    "sendStartHour" INTEGER NOT NULL DEFAULT 9,
    "sendEndHour" INTEGER NOT NULL DEFAULT 17,
    "nextRunAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "outcomeType" "CampaignOutcomeType" NOT NULL DEFAULT 'APPOINTMENT_BOOKED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Campaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SequenceStep" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "stepOrder" INTEGER NOT NULL,
    "type" "SequenceStepType" NOT NULL DEFAULT 'EMAIL',
    "waitBusinessDays" INTEGER NOT NULL DEFAULT 0,
    "subject" TEXT,
    "body" TEXT NOT NULL,

    CONSTRAINT "SequenceStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutreachEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "campaignId" TEXT,
    "leadId" TEXT,
    "contactId" TEXT,
    "stepOrder" INTEGER,
    "status" "OutreachStatus" NOT NULL DEFAULT 'QUEUED',
    "providerMessageId" TEXT,
    "scheduledAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "error" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "approvedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "leaseUntil" TIMESTAMP(3),
    "reservedAt" TIMESTAMP(3),
    "subject" TEXT,
    "body" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OutreachEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Reply" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "contactId" TEXT,
    "intent" "ReplyIntent" NOT NULL DEFAULT 'UNSURE',
    "rawSnippet" TEXT NOT NULL,
    "recommendedAction" TEXT,
    "bookedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Reply_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Appointment" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "campaignId" TEXT,
    "contactId" TEXT,
    "providerEventId" TEXT,
    "providerUpdatedAt" TIMESTAMP(3),
    "qualified" BOOLEAN NOT NULL DEFAULT false,
    "status" "AppointmentStatus" NOT NULL DEFAULT 'REQUESTED',
    "calendlyEventUri" TEXT,
    "scheduledStart" TIMESTAMP(3),
    "scheduledEnd" TIMESTAMP(3),
    "timezone" TEXT,
    "qualificationNotes" TEXT,
    "qualityScore" INTEGER,
    "outcomeReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Appointment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignOutcome" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "type" "CampaignOutcomeType" NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "targetCount" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "measuredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CampaignOutcome_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CalendarRoutingRule" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "calendlyUrl" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'America/Los_Angeles',
    "minScore" INTEGER NOT NULL DEFAULT 75,
    "ownerEmail" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "CalendarRoutingRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeliverabilityProfile" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "senderEmail" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "status" "DeliverabilityStatus" NOT NULL DEFAULT 'HEALTHY',
    "dailyCap" INTEGER NOT NULL DEFAULT 25,
    "bounceRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "complaintRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "positiveReplyRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "lastCheckedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeliverabilityProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutomationRun" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "status" "RunStatus" NOT NULL DEFAULT 'QUEUED',
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "prospectsFound" INTEGER NOT NULL DEFAULT 0,
    "contactsVerified" INTEGER NOT NULL DEFAULT 0,
    "messagesQueued" INTEGER NOT NULL DEFAULT 0,
    "repliesClassified" INTEGER NOT NULL DEFAULT 0,
    "appointmentsBooked" INTEGER NOT NULL DEFAULT 0,
    "errors" JSONB,
    "idempotencyKey" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "leaseUntil" TIMESTAMP(3),
    "leaseToken" TEXT,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AutomationRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TenantSetting" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "emailProvider" TEXT,
    "encryptedConfig" TEXT,
    "dailySendCap" INTEGER NOT NULL DEFAULT 100,
    "weeklyProspectCap" INTEGER NOT NULL DEFAULT 50,
    "defaultCalendlyUrl" TEXT,
    "senderName" TEXT,
    "senderEmail" TEXT,
    "automationEnabled" BOOLEAN NOT NULL DEFAULT false,
    "postalAddress" TEXT,
    "gatewayKey" TEXT,
    "webhookSecret" TEXT,

    CONSTRAINT "TenantSetting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "actorUserId" TEXT,
    "action" TEXT NOT NULL,
    "entity" TEXT,
    "entityId" TEXT,
    "ipHash" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Suppression" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Suppression_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RateLimit" (
    "key" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RateLimit_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "Enrollment" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "hasBuyer" BOOLEAN NOT NULL,
    "hasPainSignal" BOOLEAN NOT NULL,
    "evidence" JSONB NOT NULL,
    "stoppedAt" TIMESTAMP(3),
    "stopReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Enrollment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "providerEventId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkerHeartbeat" (
    "id" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkerHeartbeat_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Tenant_slug_key" ON "Tenant"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Invite_tokenHash_key" ON "Invite"("tokenHash");

-- CreateIndex
CREATE INDEX "Lead_tenantId_status_idx" ON "Lead"("tenantId", "status");

-- CreateIndex
CREATE INDEX "Lead_tenantId_score_idx" ON "Lead"("tenantId", "score");

-- CreateIndex
CREATE INDEX "Lead_tenantId_qualification_idx" ON "Lead"("tenantId", "qualification");

-- CreateIndex
CREATE UNIQUE INDEX "Lead_tenantId_domain_key" ON "Lead"("tenantId", "domain");

-- CreateIndex
CREATE INDEX "Contact_tenantId_role_idx" ON "Contact"("tenantId", "role");

-- CreateIndex
CREATE INDEX "Contact_tenantId_email_idx" ON "Contact"("tenantId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "Contact_tenantId_email_key" ON "Contact"("tenantId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "DataProvider_tenantId_kind_name_key" ON "DataProvider"("tenantId", "kind", "name");

-- CreateIndex
CREATE INDEX "ICP_tenantId_active_idx" ON "ICP"("tenantId", "active");

-- CreateIndex
CREATE INDEX "DiscoveryJob_tenantId_status_idx" ON "DiscoveryJob"("tenantId", "status");

-- CreateIndex
CREATE INDEX "DiscoveryJob_tenantId_icpId_idx" ON "DiscoveryJob"("tenantId", "icpId");

-- CreateIndex
CREATE INDEX "Campaign_tenantId_status_idx" ON "Campaign"("tenantId", "status");

-- CreateIndex
CREATE INDEX "Campaign_tenantId_icpId_idx" ON "Campaign"("tenantId", "icpId");

-- CreateIndex
CREATE INDEX "Campaign_status_nextRunAt_idx" ON "Campaign"("status", "nextRunAt");

-- CreateIndex
CREATE UNIQUE INDEX "SequenceStep_campaignId_stepOrder_key" ON "SequenceStep"("campaignId", "stepOrder");

-- CreateIndex
CREATE UNIQUE INDEX "OutreachEvent_idempotencyKey_key" ON "OutreachEvent"("idempotencyKey");

-- CreateIndex
CREATE INDEX "OutreachEvent_tenantId_status_idx" ON "OutreachEvent"("tenantId", "status");

-- CreateIndex
CREATE INDEX "OutreachEvent_tenantId_scheduledAt_idx" ON "OutreachEvent"("tenantId", "scheduledAt");

-- CreateIndex
CREATE INDEX "Reply_tenantId_intent_idx" ON "Reply"("tenantId", "intent");

-- CreateIndex
CREATE INDEX "Appointment_tenantId_status_idx" ON "Appointment"("tenantId", "status");

-- CreateIndex
CREATE INDEX "Appointment_tenantId_scheduledStart_idx" ON "Appointment"("tenantId", "scheduledStart");

-- CreateIndex
CREATE UNIQUE INDEX "Appointment_tenantId_providerEventId_key" ON "Appointment"("tenantId", "providerEventId");

-- CreateIndex
CREATE INDEX "CampaignOutcome_campaignId_type_idx" ON "CampaignOutcome"("campaignId", "type");

-- CreateIndex
CREATE INDEX "CalendarRoutingRule_campaignId_active_idx" ON "CalendarRoutingRule"("campaignId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "DeliverabilityProfile_tenantId_senderEmail_key" ON "DeliverabilityProfile"("tenantId", "senderEmail");

-- CreateIndex
CREATE UNIQUE INDEX "AutomationRun_idempotencyKey_key" ON "AutomationRun"("idempotencyKey");

-- CreateIndex
CREATE INDEX "AutomationRun_tenantId_status_idx" ON "AutomationRun"("tenantId", "status");

-- CreateIndex
CREATE INDEX "AutomationRun_campaignId_createdAt_idx" ON "AutomationRun"("campaignId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "TenantSetting_tenantId_key" ON "TenantSetting"("tenantId");

-- CreateIndex
CREATE INDEX "AuditEvent_tenantId_createdAt_idx" ON "AuditEvent"("tenantId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Suppression_tenantId_email_key" ON "Suppression"("tenantId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

-- CreateIndex
CREATE INDEX "Enrollment_tenantId_contactId_stoppedAt_idx" ON "Enrollment"("tenantId", "contactId", "stoppedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Enrollment_campaignId_contactId_key" ON "Enrollment"("campaignId", "contactId");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookEvent_tenantId_providerEventId_key" ON "WebhookEvent"("tenantId", "providerEventId");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invite" ADD CONSTRAINT "Invite_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DataProvider" ADD CONSTRAINT "DataProvider_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ICP" ADD CONSTRAINT "ICP_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiscoveryJob" ADD CONSTRAINT "DiscoveryJob_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiscoveryJob" ADD CONSTRAINT "DiscoveryJob_icpId_fkey" FOREIGN KEY ("icpId") REFERENCES "ICP"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_icpId_fkey" FOREIGN KEY ("icpId") REFERENCES "ICP"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SequenceStep" ADD CONSTRAINT "SequenceStep_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutreachEvent" ADD CONSTRAINT "OutreachEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutreachEvent" ADD CONSTRAINT "OutreachEvent_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutreachEvent" ADD CONSTRAINT "OutreachEvent_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutreachEvent" ADD CONSTRAINT "OutreachEvent_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reply" ADD CONSTRAINT "Reply_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reply" ADD CONSTRAINT "Reply_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignOutcome" ADD CONSTRAINT "CampaignOutcome_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalendarRoutingRule" ADD CONSTRAINT "CalendarRoutingRule_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliverabilityProfile" ADD CONSTRAINT "DeliverabilityProfile_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationRun" ADD CONSTRAINT "AutomationRun_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationRun" ADD CONSTRAINT "AutomationRun_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TenantSetting" ADD CONSTRAINT "TenantSetting_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Enrollment" ADD CONSTRAINT "Enrollment_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Enrollment" ADD CONSTRAINT "Enrollment_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ===== prisma/migrations/202609180002_invariants/migration.sql =====
-- Defense in depth: an API or worker defect must not link two tenants' records.
CREATE FUNCTION leadmelo_check_tenant_links() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  i integer;
  parent_tenant text;
  parent_id text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."tenantId" IS DISTINCT FROM OLD."tenantId" THEN
    RAISE EXCEPTION 'tenant ownership is immutable' USING ERRCODE = '23514';
  END IF;
  FOR i IN 0..(TG_NARGS / 2 - 1) LOOP
    parent_id := to_jsonb(NEW)->>TG_ARGV[i * 2];
    IF parent_id IS NOT NULL THEN
      EXECUTE format('SELECT "tenantId" FROM %I WHERE id=$1', TG_ARGV[i * 2 + 1]) INTO parent_tenant USING parent_id;
      IF parent_tenant IS DISTINCT FROM NEW."tenantId" THEN
        RAISE EXCEPTION 'cross-tenant reference rejected' USING ERRCODE = '23514';
      END IF;
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;
CREATE TRIGGER tenant_links BEFORE INSERT OR UPDATE ON "Campaign" FOR EACH ROW EXECUTE FUNCTION leadmelo_check_tenant_links('icpId','ICP');
CREATE TRIGGER tenant_links BEFORE INSERT OR UPDATE ON "DiscoveryJob" FOR EACH ROW EXECUTE FUNCTION leadmelo_check_tenant_links('icpId','ICP');
CREATE TRIGGER tenant_links BEFORE INSERT OR UPDATE ON "Contact" FOR EACH ROW EXECUTE FUNCTION leadmelo_check_tenant_links('leadId','Lead');
CREATE TRIGGER tenant_links BEFORE INSERT OR UPDATE ON "Enrollment" FOR EACH ROW EXECUTE FUNCTION leadmelo_check_tenant_links('campaignId','Campaign','contactId','Contact');
CREATE TRIGGER tenant_links BEFORE INSERT OR UPDATE ON "AutomationRun" FOR EACH ROW EXECUTE FUNCTION leadmelo_check_tenant_links('campaignId','Campaign');
CREATE TRIGGER tenant_links BEFORE INSERT OR UPDATE ON "OutreachEvent" FOR EACH ROW EXECUTE FUNCTION leadmelo_check_tenant_links('campaignId','Campaign','contactId','Contact','leadId','Lead');
CREATE TRIGGER tenant_links BEFORE INSERT OR UPDATE ON "Reply" FOR EACH ROW EXECUTE FUNCTION leadmelo_check_tenant_links('contactId','Contact');
CREATE TRIGGER tenant_links BEFORE INSERT OR UPDATE ON "Appointment" FOR EACH ROW EXECUTE FUNCTION leadmelo_check_tenant_links('campaignId','Campaign','contactId','Contact');
ALTER TABLE "Suppression" ADD CONSTRAINT suppression_tenant_fk FOREIGN KEY ("tenantId") REFERENCES "Tenant"(id) ON DELETE CASCADE;
ALTER TABLE "WebhookEvent" ADD CONSTRAINT webhook_tenant_fk FOREIGN KEY ("tenantId") REFERENCES "Tenant"(id) ON DELETE CASCADE;
ALTER TABLE "Campaign" ADD CONSTRAINT campaign_limits CHECK ("dailySendCap">0 AND "weeklyProspectCap">0 AND "minScore" BETWEEN 0 AND 100 AND "minAppointmentQualityScore" BETWEEN 0 AND 100 AND "sendStartHour">=0 AND "sendEndHour"<=24 AND "sendStartHour"<"sendEndHour");
ALTER TABLE "Appointment" ADD CONSTRAINT appointment_interval CHECK ("scheduledEnd" IS NULL OR "scheduledStart" IS NULL OR "scheduledEnd">"scheduledStart");
ALTER TABLE "ICP" ADD CONSTRAINT icp_score CHECK ("minScore" BETWEEN 0 AND 100);
ALTER TABLE "Enrollment" ADD CONSTRAINT enrollment_score CHECK (score BETWEEN 0 AND 100);
CREATE UNIQUE INDEX one_active_enrollment_per_contact ON "Enrollment" ("tenantId", "contactId") WHERE "stoppedAt" IS NULL;
CREATE INDEX automation_due ON "AutomationRun" (status, "availableAt", "leaseUntil");
CREATE INDEX outreach_due ON "OutreachEvent" (status, "scheduledAt", "leaseUntil");

-- ===== prisma/migrations/202609180003_campaign_icp_autopilot/migration.sql =====
CREATE TYPE "OutreachPurpose" AS ENUM ('SEQUENCE', 'BOOKING_INVITATION');
ALTER TABLE "OutreachEvent" ADD COLUMN "purpose" "OutreachPurpose" NOT NULL DEFAULT 'SEQUENCE';
CREATE INDEX "OutreachEvent_tenantId_purpose_status_idx" ON "OutreachEvent"("tenantId", "purpose", "status");

-- ===== prisma/migrations/202609180004_m365_reliability/migration.sql =====
-- AlterTable
ALTER TABLE "Contact" ADD COLUMN     "reverifyRequestedAt" TIMESTAMP(3),
ADD COLUMN     "verificationAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "verificationLeaseUntil" TIMESTAMP(3),
ADD COLUMN     "verificationNextAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "OutreachEvent" ADD COLUMN     "leaseToken" TEXT;

-- CreateTable
CREATE TABLE "M365Connection" (
    "tenantId" TEXT NOT NULL,
    "directoryId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "encryptedSecret" TEXT NOT NULL,
    "mailboxes" TEXT[],
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "M365Connection_pkey" PRIMARY KEY ("tenantId")
);

-- CreateTable
CREATE TABLE "MailReceipt" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "mailbox" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'NEW',
    "draftId" TEXT,
    "internetMessageId" TEXT,
    "conversationId" TEXT,
    "sentConfirmedAt" TIMESTAMP(3),
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MailReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MailCursor" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "mailbox" TEXT NOT NULL,
    "cursor" TEXT,
    "leaseToken" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "nextPollAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSuccessAt" TIMESTAMP(3),
    "error" TEXT,

    CONSTRAINT "MailCursor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OperationalAlert" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveredAt" TIMESTAMP(3),
    "acknowledgedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseToken" TEXT,
    "leaseUntil" TIMESTAMP(3),

    CONSTRAINT "OperationalAlert_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "M365Connection_directoryId_key" ON "M365Connection"("directoryId");

-- CreateIndex
CREATE UNIQUE INDEX "MailReceipt_key_key" ON "MailReceipt"("key");

-- CreateIndex
CREATE INDEX "MailReceipt_tenantId_status_idx" ON "MailReceipt"("tenantId", "status");

-- CreateIndex
CREATE INDEX "MailReceipt_tenantId_mailbox_internetMessageId_idx" ON "MailReceipt"("tenantId", "mailbox", "internetMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "MailCursor_tenantId_mailbox_key" ON "MailCursor"("tenantId", "mailbox");

-- CreateIndex
CREATE UNIQUE INDEX "OperationalAlert_key_key" ON "OperationalAlert"("key");

-- CreateIndex
CREATE INDEX "OperationalAlert_tenantId_createdAt_idx" ON "OperationalAlert"("tenantId", "createdAt");

ALTER TABLE "M365Connection" ADD CONSTRAINT m365_tenant_fk FOREIGN KEY ("tenantId") REFERENCES "Tenant"(id) ON DELETE CASCADE;
ALTER TABLE "MailReceipt" ADD CONSTRAINT mail_receipt_tenant_fk FOREIGN KEY ("tenantId") REFERENCES "Tenant"(id) ON DELETE CASCADE;
ALTER TABLE "MailCursor" ADD CONSTRAINT mail_cursor_tenant_fk FOREIGN KEY ("tenantId") REFERENCES "Tenant"(id) ON DELETE CASCADE;
ALTER TABLE "OperationalAlert" ADD CONSTRAINT alert_tenant_fk FOREIGN KEY ("tenantId") REFERENCES "Tenant"(id) ON DELETE CASCADE;
ALTER TABLE "MailReceipt" ADD CONSTRAINT mail_receipt_status CHECK (status IN ('NEW','CREATING','DRAFT','SUBMITTING','ACCEPTED','AMBIGUOUS'));
CREATE INDEX reverify_due ON "Contact" ("verificationNextAt") WHERE "reverifyRequestedAt" IS NOT NULL;
CREATE INDEX alert_due ON "OperationalAlert" ("nextAttemptAt") WHERE "deliveredAt" IS NULL AND "acknowledgedAt" IS NULL;

-- ===== prisma/migrations/202609180005_calendly_adapter/migration.sql =====
-- Encrypted per-tenant Calendly webhook signing key (AES-256-GCM via application encrypt()).
ALTER TABLE "TenantSetting" ADD COLUMN "calendlySigningKey" TEXT;

-- ===== prisma/migrations/202609180006_versions_usage/migration.sql =====
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

-- ===== prisma/migrations/202609180007_identity/migration.sql =====
-- TOTP MFA state and single-use password reset tokens.
ALTER TABLE "User" ADD COLUMN "totpSecret" TEXT,
  ADD COLUMN "mfaEnabledAt" TIMESTAMP(3),
  ADD COLUMN "totpLastStep" INTEGER,
  ADD COLUMN "recoveryHashes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

CREATE TABLE "PasswordReset" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PasswordReset_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PasswordReset_tokenHash_key" ON "PasswordReset"("tokenHash");
CREATE INDEX "PasswordReset_userId_idx" ON "PasswordReset"("userId");
ALTER TABLE "PasswordReset" ADD CONSTRAINT "PasswordReset_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ===== prisma/migrations/202609180008_retention/migration.sql =====
-- Optional per-tenant retention for message bodies and reply text (NULL = keep until erased).
ALTER TABLE "TenantSetting" ADD COLUMN "messageRetentionDays" INTEGER;
ALTER TABLE "TenantSetting" ADD CONSTRAINT retention_minimum CHECK ("messageRetentionDays" IS NULL OR "messageRetentionDays" >= 30);

-- ===== prisma/migrations/202609180009_experiments/migration.sql =====
-- Controlled email-copy experiments: stable per-enrollment assignment, human-decided recommendations.
CREATE TABLE "Experiment" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "stepOrder" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "primaryMetric" TEXT NOT NULL DEFAULT 'POSITIVE_REPLY',
    "minSample" INTEGER NOT NULL DEFAULT 100,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "concludedAt" TIMESTAMP(3),
    CONSTRAINT "Experiment_pkey" PRIMARY KEY ("id"),
    CONSTRAINT experiment_status CHECK ("status" IN ('DRAFT','RUNNING','STOPPED','CONCLUDED')),
    CONSTRAINT experiment_metric CHECK ("primaryMetric" IN ('POSITIVE_REPLY','BOOKED','ATTENDED')),
    CONSTRAINT experiment_limits CHECK ("stepOrder" >= 1 AND "minSample" >= 20)
);
CREATE TABLE "ExperimentVariant" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "experimentId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "isControl" BOOLEAN NOT NULL DEFAULT false,
    "subject" TEXT,
    "body" TEXT,
    "weight" INTEGER NOT NULL DEFAULT 1,
    CONSTRAINT "ExperimentVariant_pkey" PRIMARY KEY ("id"),
    CONSTRAINT variant_weight CHECK ("weight" BETWEEN 1 AND 100000),
    CONSTRAINT variant_copy CHECK ("isControl" OR ("subject" IS NOT NULL AND "body" IS NOT NULL))
);
CREATE TABLE "ExperimentAssignment" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "experimentId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "enrollmentId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ExperimentAssignment_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "ExperimentRecommendation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "experimentId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "verdict" JSONB NOT NULL,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ExperimentRecommendation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT recommendation_status CHECK ("status" IN ('OPEN','ACCEPTED','REJECTED'))
);
CREATE INDEX "Experiment_tenantId_campaignId_idx" ON "Experiment"("tenantId", "campaignId");
-- At most one running experiment per campaign step, and exactly one control per experiment.
CREATE UNIQUE INDEX one_running_experiment_per_step ON "Experiment" ("campaignId", "stepOrder") WHERE "status" = 'RUNNING';
CREATE UNIQUE INDEX "ExperimentVariant_experimentId_label_key" ON "ExperimentVariant"("experimentId", "label");
CREATE UNIQUE INDEX one_control_per_experiment ON "ExperimentVariant" ("experimentId") WHERE "isControl";
CREATE UNIQUE INDEX "ExperimentAssignment_experimentId_enrollmentId_key" ON "ExperimentAssignment"("experimentId", "enrollmentId");
CREATE INDEX "ExperimentAssignment_variantId_idx" ON "ExperimentAssignment"("variantId");
CREATE UNIQUE INDEX "ExperimentRecommendation_experimentId_variantId_key" ON "ExperimentRecommendation"("experimentId", "variantId");

ALTER TABLE "Experiment" ADD CONSTRAINT experiment_tenant_fk FOREIGN KEY ("tenantId") REFERENCES "Tenant"(id) ON DELETE CASCADE;
ALTER TABLE "Experiment" ADD CONSTRAINT experiment_campaign_fk FOREIGN KEY ("campaignId") REFERENCES "Campaign"(id) ON DELETE CASCADE;
ALTER TABLE "ExperimentVariant" ADD CONSTRAINT variant_tenant_fk FOREIGN KEY ("tenantId") REFERENCES "Tenant"(id) ON DELETE CASCADE;
ALTER TABLE "ExperimentVariant" ADD CONSTRAINT variant_experiment_fk FOREIGN KEY ("experimentId") REFERENCES "Experiment"(id) ON DELETE CASCADE;
ALTER TABLE "ExperimentAssignment" ADD CONSTRAINT assignment_tenant_fk FOREIGN KEY ("tenantId") REFERENCES "Tenant"(id) ON DELETE CASCADE;
ALTER TABLE "ExperimentAssignment" ADD CONSTRAINT assignment_experiment_fk FOREIGN KEY ("experimentId") REFERENCES "Experiment"(id) ON DELETE CASCADE;
ALTER TABLE "ExperimentAssignment" ADD CONSTRAINT assignment_variant_fk FOREIGN KEY ("variantId") REFERENCES "ExperimentVariant"(id) ON DELETE CASCADE;
ALTER TABLE "ExperimentAssignment" ADD CONSTRAINT assignment_enrollment_fk FOREIGN KEY ("enrollmentId") REFERENCES "Enrollment"(id) ON DELETE CASCADE;
ALTER TABLE "ExperimentRecommendation" ADD CONSTRAINT recommendation_tenant_fk FOREIGN KEY ("tenantId") REFERENCES "Tenant"(id) ON DELETE CASCADE;
ALTER TABLE "ExperimentRecommendation" ADD CONSTRAINT recommendation_experiment_fk FOREIGN KEY ("experimentId") REFERENCES "Experiment"(id) ON DELETE CASCADE;

CREATE TRIGGER tenant_links BEFORE INSERT OR UPDATE ON "Experiment" FOR EACH ROW EXECUTE FUNCTION leadmelo_check_tenant_links('campaignId','Campaign');
CREATE TRIGGER tenant_links BEFORE INSERT OR UPDATE ON "ExperimentVariant" FOR EACH ROW EXECUTE FUNCTION leadmelo_check_tenant_links('experimentId','Experiment');
CREATE TRIGGER tenant_links BEFORE INSERT OR UPDATE ON "ExperimentAssignment" FOR EACH ROW EXECUTE FUNCTION leadmelo_check_tenant_links('experimentId','Experiment','variantId','ExperimentVariant','enrollmentId','Enrollment');
CREATE TRIGGER tenant_links BEFORE INSERT OR UPDATE ON "ExperimentRecommendation" FOR EACH ROW EXECUTE FUNCTION leadmelo_check_tenant_links('experimentId','Experiment');

-- ===== prisma/migrations/202609180010_growth_deliverability/migration.sql =====
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

-- ===== prisma/migrations/202609180011_ai_assist/migration.sql =====
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
