CREATE TYPE "OutreachPurpose" AS ENUM ('SEQUENCE', 'BOOKING_INVITATION');
ALTER TABLE "OutreachEvent" ADD COLUMN "purpose" "OutreachPurpose" NOT NULL DEFAULT 'SEQUENCE';
CREATE INDEX "OutreachEvent_tenantId_purpose_status_idx" ON "OutreachEvent"("tenantId", "purpose", "status");
