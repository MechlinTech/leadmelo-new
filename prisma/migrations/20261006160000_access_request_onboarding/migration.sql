-- Onboarding state for access requests: approval, linked account, last email send, last delivery error.
ALTER TABLE "AccessRequest" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'PENDING',
  ADD COLUMN "userId" TEXT,
  ADD COLUMN "lastEmailAt" TIMESTAMP(3),
  ADD COLUMN "emailError" TEXT;
ALTER TABLE "AccessRequest" ADD CONSTRAINT access_request_status CHECK ("status" IN ('PENDING','APPROVED'));
