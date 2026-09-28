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
